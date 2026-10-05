// Le relais lui-meme ne doit plus mourir sans laisser de trace, ni couper une requete (DR-012).
// Incident d'origine : huit sous-agents tues d'un coup (ECONNREFUSED), relais mort sans une ligne au
// journal -- plantage non journalise (la pile partait dans proxy.out.log), arret brutal sans trace.
// Chaque scenario lance une instance ISOLEE (port 8810, faux amont 8811, dossier temporaire) : le relais
// vivant de ce PC n'est jamais touche.
// Contre-epreuve : CQR_TEST_SRC=<dossier avec proxy.js, lib.js, compaction.js> pointe le test sur une
// autre version du code (copie de HEAD, mutant...). Run: node test/relais-vie.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = process.env.CQR_TEST_SRC || p.join(__dirname, "..", "src");
const PKG = p.join(__dirname, "..", "package.json");
const VERSION = JSON.parse(fs.readFileSync(PKG, "utf8")).version;
const PROXY_PORT = 8810, MOCK_PORT = 8811;
const FAKE1 = "sk-ant-oat01-FAKE-ACCOUNT-ONE-not-real-0000000", FAKE2 = "sk-ant-oat01-FAKE-ACCOUNT-TWO-not-real-0000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le test parle au relais par le canal IPC : emettre un signal (un vrai SIGTERM tue un process Windows
// sans rien executer), lever une erreur, emettre une erreur sur la reponse en cours. Il raccourcit aussi
// le delai de sonde (10 s -> 0,8 s) pour ne pas attendre.
const HOOK = `
const http = require("http");
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, a, b) { if (ev === "request") global.__res = b; return emit.apply(this, arguments); };
const setTimeoutReq = http.ClientRequest.prototype.setTimeout;
http.ClientRequest.prototype.setTimeout = function (ms, cb) { return setTimeoutReq.call(this, ms === 10000 ? 800 : ms, cb); };
// Garde PAR REQUETE : une levee DANS le trajet d'une requete, pas au niveau du processus.
//  - writeThrows : les n prochains corps de VRAIE requete (max_tokens 10) ecrits vers l'amont levent, dans forward().
//  - unpipeThrows : le debranchement de la reponse amont levent, dans onCut, APRES l'envoi des premiers octets.
let writeThrows = 0, unpipeThrows = 0;
const clientReq = http.ClientRequest.prototype, write = clientReq.write;
clientReq.write = function (chunk) { if (writeThrows > 0 && /"max_tokens":10[,}]/.test(String(chunk))) { writeThrows--; throw new Error("boom-forward"); } return write.apply(this, arguments); };
const Readable = require("stream").Readable, unpipe = Readable.prototype.unpipe;
Readable.prototype.unpipe = function () { if (unpipeThrows > 0 && /onCut/.test(new Error().stack)) { unpipeThrows--; throw new Error("boom-cut"); } return unpipe.apply(this, arguments); };
process.on("message", (m) => {
  if (m.writeThrows != null) writeThrows = m.writeThrows;
  if (m.unpipeThrows != null) unpipeThrows = m.unpipeThrows;
  if (m.sig) process.emit(m.sig);
  if (m.throw) setTimeout(() => { throw new Error(m.throw); }, 0);
  if (m.reject) Promise.reject(new Error(m.reject));
  if (m.resError && global.__res) global.__res.emit("error", new Error(m.resError));
});
`;

// ---------- faux Anthropic ----------
// real : "ok" | "hang" (accepte, ne repond jamais) | "longsse" (flux sans fin) | "cut" (un morceau de flux puis la connexion tombe) | "terms" (400 conditions pour le compte 1)
// probe : "ok" | "stall" (en-tetes 200 puis le corps ne vient jamais)
const M = { real: "ok", probe: "ok", hits: 0, auths: [], aborted: 0 };
function resetMock() { M.real = "ok"; M.probe = "ok"; M.hits = 0; M.auths = []; M.aborted = 0; }
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.on("error", () => {}); res.on("error", () => {});
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const auth = req.headers["authorization"] || "";
        const H = { "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
        if (body.max_tokens === 0) { // sonde de quota
          res.writeHead(200, H);
          if (M.probe === "stall") res.write("{"); else res.end("{}");
          return;
        }
        M.hits++; M.auths.push(auth);
        res.on("close", () => { if (!res.writableFinished) M.aborted++; }); // le relais a coupe la requete amont
        if (M.real === "hang") return;
        if (M.real === "terms" && auth.indexOf(FAKE1) >= 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue." } }));
          return;
        }
        if (M.real === "cut") {
          res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H));
          res.write("event: d\ndata: " + "x".repeat(2000) + "\n\n");
          setTimeout(() => { try { res.socket.destroy(); } catch (e) {} }, 200);
          return;
        }
        if (M.real === "longsse") {
          res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H));
          const iv = setInterval(() => { try { res.write("event: d\ndata: " + "x".repeat(20000) + "\n\n"); } catch (e) {} }, 100);
          res.on("close", () => clearInterval(iv));
          return;
        }
        res.writeHead(200, Object.assign({ "content-type": "application/json" }, H));
        res.end(JSON.stringify({ ok: true }));
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}

// ---------- instances isolees du relais ----------
const live = [], dirs = [];
function mkDir(opts) {
  opts = opts || {};
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-vie-")); dirs.push(DIR);
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.copyFileSync(PKG, p.join(DIR, "package.json"));
  fs.writeFileSync(p.join(DIR, "hook.js"), HOOK);
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify(Object.assign({ port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, maxWaitMs: 600000, pollMs: 15000, livePollMs: 0,
    tokens: opts.tokens || [{ name: "account1", token: FAKE1, enabled: true }] }, opts.conf || {})));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));
  return DIR;
}
// env : une valeur null retire la variable
function spawnRelay(DIR, env) {
  const e = Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1", TEMP: DIR, TMP: DIR }, env);
  for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
  const child = cp.spawn(process.execPath, ["--require", p.join(DIR, "hook.js"), p.join(DIR, "proxy.js")], { cwd: DIR, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: e });
  child.exited = new Promise((resolve) => child.on("exit", (code, sig) => { child.exitInfo = { code, sig }; resolve(child.exitInfo); }));
  child.on("error", () => {});
  live.push(child);
  return child;
}
const health = () => new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + PROXY_PORT + "/__proxy_health", { agent: false }, (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
async function waitUp(child) { for (let i = 0; i < 60; i++) { if (child.exitInfo) return false; if (await health()) return true; await sleep(100); } return false; }
const readLog = (DIR) => { try { return fs.readFileSync(p.join(DIR, "proxy.log"), "utf8"); } catch (e) { return ""; } };
const readPid = (DIR) => { try { return fs.readFileSync(p.join(DIR, "proxy.pid"), "utf8").trim(); } catch (e) { return null; } };
const count = (txt, s) => txt.split(s).length - 1;
// attend la sortie du relais, sans bloquer le test s'il ne sort pas
const sortie = (child, ms) => Promise.race([child.exited, sleep(ms || 4000).then(() => { throw new Error("le relais n'est pas sorti (pid " + child.pid + ")"); })]);

function ask(stream, timeoutMs) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, stream: !!stream, messages: [{ role: "user", content: "go" }] }));
    const out = { error: null, status: 0, body: "" };
    const done = () => resolve(out);
    const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      out.status = res.statusCode; res.on("data", (c) => (out.body += c)); res.on("end", done); res.on("error", (e) => { out.error = e.code || e.message; done(); });
    });
    q.on("error", (e) => { out.error = e.code || e.message; done(); });
    q.setTimeout(timeoutMs, () => { q.destroy(); out.error = "TIMEOUT"; done(); });
    q.write(data); q.end();
  });
}
// requete cliente qu'on laisse en cours (le test decide quand l'abandonner) ; onData : 1er octet recu
function openClient(stream, onData) {
  const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, stream, messages: [{ role: "user", content: "go" }] }));
  const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
    res.on("error", () => {});
    res.on("data", () => { if (onData) { const f = onData; onData = null; f(); } });
  });
  q.on("error", () => {});
  q.end(data);
  return q;
}

// ---------- scenarios ----------
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario("journal de vie (3) + PID ecrit apres listen (4) : demarrage, 2e relais sans effet, 4 signaux, sortie", async () => {
  const DIR = mkDir();
  fs.writeFileSync(p.join(DIR, "proxy.stopped"), "arret voulu");
  let R = spawnRelay(DIR, { CQR_STARTED_BY: "statusline" });
  assert.ok(await waitUp(R), "le relais demarre");
  let log = readLog(DIR);
  assert.ok(log.includes("VIE demarrage pid=" + R.pid + " version=" + VERSION + " node=" + process.version + " lance_par=statusline"),
    "ligne de demarrage avec PID, version, Node, lanceur. Journal : " + log.slice(0, 300));
  assert.strictEqual(readPid(DIR), String(R.pid), "proxy.pid porte le PID du relais en ligne");
  assert.ok(!fs.existsSync(p.join(DIR, "proxy.stopped")), "un relais qui demarre annule le marqueur d'arret voulu");

  // un 2e relais sur le meme port echoue (EADDRINUSE) : il ne doit pas effacer le PID du 1er
  const B = spawnRelay(DIR, {});
  assert.strictEqual((await sortie(B)).code, 1, "le 2e relais s'efface (port pris)");
  assert.strictEqual(readPid(DIR), String(R.pid), "le 2e relais n'a pas efface proxy.pid du 1er");
  assert.ok(await health(), "le 1er relais est toujours en ligne");

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    if (!R) { R = spawnRelay(DIR, {}); assert.ok(await waitUp(R), "relais relance pour " + sig); }
    R.send({ sig });
    assert.strictEqual((await sortie(R)).code, 0, sig + " : sortie propre");
    log = readLog(DIR);
    assert.ok(log.includes("VIE signal " + sig + " recu pid=" + R.pid), sig + " journalise avant de sortir");
    assert.ok(log.includes("VIE sortie code=0 pid=" + R.pid), sig + " : la sortie et son code sont journalises");
    assert.strictEqual(readPid(DIR), null, sig + " : proxy.pid efface a la sortie");
    R = null;
  }
  assert.ok(!log.includes("arret brutal"), "des arrets propres ne se prennent jamais pour un arret brutal");
});

scenario("arret brutal precedent detecte au redemarrage (3)", async () => {
  const DIR = mkDir();
  const C = spawnRelay(DIR, {});
  assert.ok(await waitUp(C), "relais 1 en ligne");
  assert.strictEqual((await ask(false, 5000)).status, 200, "il a servi une requete");
  C.kill("SIGKILL"); await C.exited; // arret sans aucune chance de nettoyer (TerminateProcess)
  assert.strictEqual(readPid(DIR), String(C.pid), "le PID du relais mort est reste dans proxy.pid");
  const lignes = readLog(DIR).trimEnd().split("\n");
  const dernier = /^\[([^\]]+)\]/.exec(lignes[lignes.length - 1])[1];
  assert.ok(!lignes.join("\n").includes("arret brutal"), "premier demarrage : rien a detecter");

  const D = spawnRelay(DIR, { CQR_STARTED_BY: "cli" });
  assert.ok(await waitUp(D), "relais 2 en ligne");
  const log = readLog(DIR);
  assert.ok(log.includes("VIE arret brutal precedent detecte pid=" + C.pid + " derniere_ligne_du_journal=" + dernier),
    "arret brutal date par la derniere ligne du journal (" + dernier + "). Journal : " + log.slice(-600));
  assert.strictEqual(count(log, "arret brutal"), 1, "une seule ligne");
  assert.strictEqual(readPid(DIR), String(D.pid), "proxy.pid porte maintenant le PID du nouveau relais");
});

// Reprise de la copie installee (correctif local du 2026-10-02, jamais remonte au depot) : `cqr stop` tue le
// relais (sous Windows : TerminateProcess), donc meme PID mort qu'un plantage. Le marqueur proxy.stopped,
// lu avant d'etre efface, permet au journal de ne pas crier a l'arret brutal apres un arret voulu.
scenario("arret voulu (cqr stop) : le journal ne parle pas d'arret brutal", async () => {
  const DIR = mkDir();
  const C = spawnRelay(DIR, {});
  assert.ok(await waitUp(C), "relais 1 en ligne");
  C.kill("SIGKILL"); await C.exited;
  fs.writeFileSync(p.join(DIR, "proxy.stopped"), "arret voulu"); // ce que `cqr stop` pose avant de tuer
  const D = spawnRelay(DIR, {});
  assert.ok(await waitUp(D), "relais 2 en ligne");
  const log = readLog(DIR);
  assert.ok(log.includes("VIE arret voulu precedent (cqr stop) pid=" + C.pid + " derniere_ligne_du_journal="), "arret voulu dit comme tel. Journal : " + log.slice(-500));
  assert.ok(!log.includes("arret brutal"), "et pas pris pour un arret brutal");
  assert.ok(!fs.existsSync(p.join(DIR, "proxy.stopped")), "le marqueur est efface au demarrage");
});

scenario("rotation : les lignes de vie survivent a la coupe du journal (5)", async () => {
  const DIR = mkDir();
  let big = [111, 222, 333].map((n) => "[2026-01-01T00:00:00.000Z] VIE demarrage pid=" + n + " version=0.0.1 node=v1 lance_par=test").join("\n") + "\n";
  for (let i = 0; i < 21000; i++) big += "[2026-01-01T00:00:01.000Z] PROBE filler-" + i + " " + "x".repeat(80) + "\n"; // ~2,8 Mo : au-dela du seuil de 2 Mo
  fs.writeFileSync(p.join(DIR, "proxy.log"), big);
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  const log = readLog(DIR);
  assert.ok(log.length < 800_000, "le journal a ete coupe, or " + log.length + " octets");
  assert.ok(!log.includes("filler-0 "), "le vieux contenu ordinaire est parti");
  assert.ok(log.includes("filler-20999 "), "la fin du journal est restee");
  for (const n of [111, 222, 333]) assert.strictEqual(count(log, "VIE demarrage pid=" + n + " "), 1, "ligne de demarrage pid=" + n + " gardee, une seule fois");
  assert.ok(log.includes("VIE demarrage pid=" + R.pid + " "), "le demarrage courant est la");
});

scenario("gardes de processus : uncaughtException et unhandledRejection (1)", async () => {
  const DIR = mkDir();
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  R.send({ throw: "boom-test" }); await sleep(400);
  assert.ok(!R.exitInfo && await health(), "uncaughtException : le relais continue. Sortie : " + JSON.stringify(R.exitInfo));
  let log = readLog(DIR);
  assert.ok(/VIE erreur imprevue uncaughtException Error: boom-test \| +at /.test(log), "pile complete au journal, sur une ligne. Journal : " + log.slice(-500));
  R.send({ reject: "rejet-test" }); await sleep(400);
  assert.ok(!R.exitInfo && await health(), "unhandledRejection : le relais continue");
  log = readLog(DIR);
  assert.ok(/VIE erreur imprevue unhandledRejection Error: rejet-test \| +at /.test(log), "rejet journalise avec sa pile. Journal : " + log.slice(-500));
  const r = await ask(false, 5000);
  assert.strictEqual(r.status, 200, "et il sert toujours, or: " + (r.status || r.error));
});

scenario("cause connue : jeton a caractere invalide -> echec de CE compte, requete servie par l'autre (2)", async () => {
  const DIR = mkDir({ tokens: [{ name: "account1", token: FAKE1 + "\n", enabled: true }, { name: "account2", token: FAKE2, enabled: true }] });
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  await sleep(800); // la sonde de demarrage du compte abime (500 ms) leve en synchrone
  assert.ok(!R.exitInfo, "la sonde du jeton abime ne tue pas le relais. Sortie : " + JSON.stringify(R.exitInfo));
  const r = await ask(false, 8000);
  assert.strictEqual(r.status, 200, "la requete aboutit malgre le compte 1 abime, or: " + (r.status || r.error));
  assert.ok(M.hits === 1 && M.auths[0].indexOf(FAKE2) >= 0, "elle est partie sur le compte 2, or: " + JSON.stringify(M.auths));
  assert.ok(!R.exitInfo && await health(), "le relais est toujours en ligne");
  const log = readLog(DIR);
  assert.ok(/PROBE err account1 .*Invalid character/.test(log), "la sonde en echec est journalisee. Journal : " + log.slice(-700));
  assert.ok(/REQUEST impossible account1 .*Invalid character/.test(log), "l'envoi impossible est journalise");
  assert.ok(!log.includes("erreur imprevue"), "cause CONNUE : traitee dans le chemin normal, pas par la garde de dernier recours");
});

scenario("cause connue : wscript introuvable -> une ligne au journal, rien d'autre (2)", async () => {
  if (process.platform !== "win32") return "ignore (win32 seulement : notifyWindows n'agit pas ailleurs)";
  const DIR = mkDir({ tokens: [{ name: "account1", token: FAKE1, enabled: true }, { name: "account2", token: FAKE2, enabled: true }] });
  const sansPath = Object.assign({}, process.env); for (const k of Object.keys(sansPath)) if (/^path$/i.test(k)) delete sansPath[k]; sansPath.PATH = DIR;
  // garde-fou : si wscript se lance quand meme avec ce PATH, on n'ouvre PAS de fenetre chez l'utilisateur
  const sonde = cp.spawnSync("wscript.exe", ["//nologo", "//B", "absent.vbs"], { env: sansPath, cwd: DIR, windowsHide: true, timeout: 3000 });
  if (!sonde.error || sonde.error.code !== "ENOENT") return "ignore (wscript.exe reste trouvable avec un PATH vide)";
  M.real = "terms";
  const R = spawnRelay(DIR, { CQR_NO_POPUP: null, PATH: DIR, Path: null });
  assert.ok(await waitUp(R), "relais en ligne");
  const r = await ask(false, 8000);
  assert.strictEqual(r.status, 200, "le compte 1 rend le 400 conditions, la requete bascule sur le compte 2, or: " + (r.status || r.error));
  await sleep(500);
  assert.ok(!R.exitInfo && await health(), "wscript introuvable ne tue pas le relais. Sortie : " + JSON.stringify(R.exitInfo));
  const log = readLog(DIR);
  assert.ok(/BLOCKED\(conditions\) account1/.test(log), "le blocage a bien eu lieu. Journal : " + log.slice(-700));
  assert.ok(/ALERTE fenetre impossible .*wscript/.test(log), "l'echec de la fenetre est une ligne du journal");
  assert.ok(!log.includes("erreur imprevue"), "cause CONNUE : traitee dans le chemin normal");
});

scenario("cause connue : erreur sur la reponse au client (2)", async () => {
  M.real = "hang";
  const DIR = mkDir();
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  const q = openClient(true);
  await sleep(500);
  assert.strictEqual(M.hits, 1, "la requete est en cours chez l'amont");
  R.send({ resError: "res-boom" }); await sleep(400);
  assert.ok(!R.exitInfo && await health(), "une erreur sur cres ne tue pas le relais. Sortie : " + JSON.stringify(R.exitInfo));
  const log = readLog(DIR);
  assert.ok(/CLIENT res error res-boom/.test(log), "journalisee. Journal : " + log.slice(-500));
  assert.ok(!log.includes("erreur imprevue"), "cause CONNUE : ecouteur dedie");
  q.destroy();
});

scenario("sonde lente : done() n'agit qu'une fois, une seule requete amont (6)", async () => {
  M.probe = "stall";
  const DIR = mkDir({ conf: { pollMs: 1000 } });
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  await sleep(1500); // sonde de demarrage passee
  // le compte est mis de cote 0,6 s : la requete attend, puis la sonde de reveil repond en-tetes 200 sans jamais finir son corps
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: { account1: Date.now() + 600 }, reset5h: {}, reset7d: {} }));
  M.hits = 0;
  const r = await ask(false, 15000);
  assert.strictEqual(r.status, 200, "la requete est servie apres l'attente, or: " + (r.status || r.error));
  await sleep(2000); // la sonde expire (0,8 s) APRES avoir repondu : c'est la que partait la 2e requete
  assert.strictEqual(M.hits, 1, "une seule requete amont pour ce client, or: " + M.hits);
  assert.ok(!R.exitInfo && await health(), "relais en ligne");
});

scenario("abandon client : la requete amont est detruite, aucune nouvelle tentative (7)", async () => {
  // a) amont muet, requete non-flux
  M.real = "hang";
  const R = spawnRelay(mkDir(), {});
  assert.ok(await waitUp(R), "relais en ligne");
  let q = openClient(false);
  await sleep(500);
  assert.strictEqual(M.hits, 1, "la requete est en cours chez l'amont");
  q.destroy();
  await sleep(1500);
  assert.ok(M.aborted >= 1, "le client est parti : le relais a detruit la requete amont, or aborted=" + M.aborted);
  await sleep(2500);
  assert.strictEqual(M.hits, 1, "et n'en a pas relance une autre, or hits=" + M.hits);

  // b) flux long, client qui part apres le 1er octet
  M.real = "longsse"; M.hits = 0; M.aborted = 0;
  q = openClient(true, () => q.destroy());
  await sleep(1800);
  assert.ok(M.aborted >= 1, "flux en cours : le client part, le relais ferme la connexion amont, or aborted=" + M.aborted);
  assert.strictEqual(M.hits, 1, "sans nouvelle tentative, or hits=" + M.hits);

  // c) le relais n'en est pas reste coince : un client present est servi
  M.real = "ok";
  const r = await ask(true, 8000);
  assert.strictEqual(r.status, 200, "un client qui reste est toujours servi, or: " + (r.status || r.error));
  assert.ok(!R.exitInfo && await health(), "relais en ligne");
});

scenario("garde par requete : exception avant tout octet -> la requete est REJOUEE, le client est servi (1)", async () => {
  const DIR = mkDir();
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  for (const stream of [false, true]) {
    M.hits = 0;
    R.send({ writeThrows: 1 }); await sleep(100);
    const r = await ask(stream, 6000);
    assert.strictEqual(r.status, 200, (stream ? "flux" : "non-flux") + " : la requete aboutit malgre l'exception, or: " + (r.status || r.error));
    await sleep(500);
    assert.strictEqual(M.hits, 1, "une seule requete amont (pas de doublon de l'orpheline), or hits=" + M.hits);
  }
  assert.strictEqual(count(readLog(DIR), "VIE erreur en pleine requete Error: boom-forward"), 2, "chaque exception est journalisee");
  assert.ok(/boom-forward .*-> requete rejouee/.test(readLog(DIR)), "avec le rejeu annonce");
  assert.ok(!R.exitInfo && await health(), "relais en ligne");
});

scenario("garde par requete : le rejeu leve aussi -> fin nette tout de suite, pas de client pendu (1)", async () => {
  const DIR = mkDir();
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  R.send({ writeThrows: 2 }); await sleep(100);
  const t0 = Date.now();
  const r = await ask(false, 6000);
  assert.ok(r.error !== "TIMEOUT" && Date.now() - t0 < 3000, "le client recoit une fin nette en moins de 3 s, or: " + (r.error || r.status) + " en " + (Date.now() - t0) + " ms");
  assert.strictEqual(r.status, 502, "erreur 5xx : Claude Code retente aussitot, or: " + r.status);
  assert.strictEqual(M.hits, 0, "rien n'est parti chez l'amont");
  const log = readLog(DIR);
  assert.ok(/VIE erreur en pleine requete Error: boom-forward .*-> requete rejouee/.test(log), "1re exception journalisee, rejeu annonce. Journal : " + log.slice(-600));
  assert.ok(/VIE erreur en pleine requete \(rejeu\) Error: boom-forward .*-> requete terminee/.test(log), "2e exception journalisee, requete terminee");
  assert.ok(!R.exitInfo && await health(), "le relais reste en ligne");
});

scenario("garde par requete : requete SSE retenue (battements ctx.ka), exception puis rejeu en echec -> les battements s'arretent (1)", async () => {
  const DIR = mkDir({ conf: { pollMs: 1000 } });
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  await sleep(1200); // sonde de demarrage passee
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: { account1: Date.now() + 1200 }, reset5h: {}, reset7d: {} }));
  R.send({ writeThrows: 2 }); await sleep(100);
  const t0 = Date.now();
  const r = await ask(true, 9000);
  assert.ok(r.error !== "TIMEOUT" && Date.now() - t0 < 7000, "la requete retenue prend fin au lieu de battre indefiniment, or: " + (r.error || r.status) + " en " + (Date.now() - t0) + " ms");
  assert.ok(/event: error/.test(r.body), "le client recoit l'erreur SSE, or body: " + r.body.slice(-200));
  assert.ok(!R.exitInfo && await health(), "le relais reste en ligne");
});

scenario("garde par requete : exception APRES l'envoi des premiers octets -> connexion client coupee (1)", async () => {
  M.real = "cut";
  const DIR = mkDir();
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  R.send({ unpipeThrows: 1 }); await sleep(100);
  const t0 = Date.now();
  const r = await ask(true, 6000);
  assert.ok(r.error && r.error !== "TIMEOUT" && Date.now() - t0 < 3000, "la connexion du client se termine en erreur reseau en moins de 3 s, or: " + (r.error || r.status) + " en " + (Date.now() - t0) + " ms");
  assert.strictEqual(M.hits, 1, "pas de rejeu : des octets etaient deja partis, or hits=" + M.hits);
  const log = readLog(DIR);
  assert.ok(/VIE erreur en pleine requete Error: boom-cut .*-> requete terminee/.test(log), "exception journalisee, requete terminee. Journal : " + log.slice(-600));
  assert.ok(!R.exitInfo && await health(), "le relais reste en ligne");
});

scenario("rafale de 1000 erreurs imprevues : piles tronquees, la ligne de demarrage survit a la coupe (5)", async () => {
  const DIR = mkDir();
  let filler = "";
  for (let i = 0; i < 7000; i++) filler += "[2026-01-01T00:00:01.000Z] PROBE filler-" + i + " " + "x".repeat(80) + "\n"; // ~700 Ko : la rafale franchit les 2 Mo
  fs.writeFileSync(p.join(DIR, "proxy.log"), filler);
  const R = spawnRelay(DIR, {});
  assert.ok(await waitUp(R), "relais en ligne");
  for (let i = 0; i < 1000; i++) R.send({ throw: "burst-" + i + "-" + "x".repeat(3000) });
  let log = "";
  for (let i = 0; i < 100 && !log.includes("burst-999-"); i++) { await sleep(200); log = readLog(DIR); }
  assert.ok(log.includes("burst-999-"), "la rafale est arrivee au bout");
  assert.ok(!R.exitInfo && await health(), "le relais a survecu aux 1000 erreurs");
  assert.ok(!log.includes("PROBE filler-0 "), "le journal a ete coupe (le vieux contenu ordinaire est parti)");
  assert.ok(log.includes("VIE demarrage pid=" + R.pid + " "), "la ligne de demarrage est toujours dans proxy.log");
  const vie = log.split("\n").filter((l) => /^\[[^\]]*\] VIE erreur imprevue/.test(l));
  assert.ok(vie.length > 0 && vie.every((l) => l.length < 1700), "chaque pile est tronquee (~1500 car.), plus longue : " + Math.max.apply(null, vie.map((l) => l.length)));
  assert.ok(log.length < 1_500_000, "le journal reste loin du seuil de 2 Mo apres la coupe, or " + log.length + " octets");
});

(async () => {
  const watchdog = setTimeout(() => { console.error("FAIL: test trop long (120 s)"); process.exit(1); }, 120000);
  const mock = await startMock();
  let failed = 0;
  for (const [name, fn] of scenarios) {
    resetMock();
    let verdict;
    try { const skip = await fn(); verdict = skip ? "SKIP  " + name + " -- " + skip : "PASS  " + name; }
    catch (e) { failed++; verdict = "FAIL  " + name + "\n        " + String(e.message).split("\n")[0].slice(0, 600); }
    console.log(verdict);
    for (const c of live.splice(0)) { if (!c.exitInfo) c.kill("SIGKILL"); await c.exited; }
    for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  }
  try { mock.closeAllConnections(); mock.close(); } catch (e) {}
  clearTimeout(watchdog);
  if (failed) { console.error(failed + " scenario(s) en echec sur " + scenarios.length); process.exit(1); }
  console.log("PASS — " + scenarios.length + " scenarios (journal de vie, PID tardif, arret brutal, rotation, gardes, causes connues, done unique, abandon client, garde par requete, rafale d'erreurs)");
})();
