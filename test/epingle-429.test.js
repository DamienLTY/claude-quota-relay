// DR-018 : un 429 sur un compte epingle (state.forceIndex) ou demande (x-cqr-compte) ne remonte plus au client quand un
// autre compte peut servir. Vrai relais contre un faux Anthropic local (aucun reseau, aucun quota).
// S1 epingle -> epinglage deplace ; S2 demande -> politique normale ; S3 aucun autre compte -> attente puis reprise ;
// S4 plafond d'attente atteint -> le 429 est rendu (inchange) ; S5 401 et 200-rejected inchanges.
// Run: node test/epingle-429.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const TA = "sk-ant-oat01-FAKE-ACCOUNT-AAA-not-real-0000000", TB = "sk-ant-oat01-FAKE-ACCOUNT-BBB-not-real-0000000";
const NOM = { [TA]: "a", [TB]: "b" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok, ko) => { const s = require("net").createServer(); s.on("error", ko); s.listen(0, "127.0.0.1", () => { const n = s.address().port; s.close(() => ok(n)); }); });
const post = (port, headers) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }));
  const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: Object.assign({ "content-type": "application/json", "content-length": data.length, authorization: "Bearer client-placeholder" }, headers) }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  req.setTimeout(20000, () => req.destroy(new Error("requete sans reponse en 20 s (boucle ou client pendu)")));
  req.on("error", reject); req.write(data); req.end();
});

const OKH = { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
const modes = {};   // nom -> { mode, ra, probes }  (probes: les sondes suivent aussi le mode)
const reelles = {}; // nom -> nombre de requetes reelles recues
const sondes = {};  // nom -> nombre de sondes (max_tokens: 0)
const reset = () => { for (const n of ["a", "b"]) { reelles[n] = 0; sondes[n] = 0; modes[n] = { mode: "ok" }; } };
reset();

const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    let o = {}; try { o = JSON.parse(b); } catch (e) { /* corps non JSON : traite comme requete reelle */ }
    const nom = NOM[String(req.headers.authorization || "").replace("Bearer ", "")] || "?";
    const sonde = !!(o && o.max_tokens === 0);
    if (sonde) sondes[nom]++; else reelles[nom]++;
    const m = modes[nom] || { mode: "ok" };
    let mode = m.mode;
    if (sonde && !m.probes) mode = "ok";
    if (mode === "429-puis-ok") mode = (!sonde && reelles[nom] === 1) ? "429" : "ok";
    if (mode === "429") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(m.ra == null ? 60 : m.ra) });
      return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } }));
    }
    if (mode === "401") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid" } })); }
    if (mode === "200-rejected") { res.writeHead(200, Object.assign({}, OKH, { "anthropic-ratelimit-unified-status": "rejected" })); return res.end(JSON.stringify({ ok: nom })); }
    res.writeHead(200, OKH); res.end(JSON.stringify({ ok: nom }));
  });
});

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

(async () => {
  const watchdog = setTimeout(() => { console.error("FAIL: test trop long (150 s)"); process.exit(1); }, 150000);
  const PROXY = await freePort(), MOCK = await freePort();
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-ep429-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  const conf = (maxWaitMs) => fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: PROXY, switchAtPercent: 94, sevenDayBlockPercent: 99, pollMs: 1000, maxWaitMs, waitAtSoftPercent: null, compaction: { enabled: false },
    tokens: [{ name: "a", token: TA, enabled: true }, { name: "b", token: TB, enabled: true }] }));
  const seed = (extra) => fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify(Object.assign({ activeIndex: 0, pct: { a: { h5: 10, d7: 10 }, b: { h5: 50, d7: 10 } }, exhausted: {}, reset5h: {}, reset7d: {} }, extra)));
  const state = () => JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
  const logFile = p.join(DIR, "proxy.log");
  const logLen = () => { try { return fs.readFileSync(logFile, "utf8").length; } catch (e) { return 0; } };
  const logDepuis = (n) => { try { return fs.readFileSync(logFile, "utf8").slice(n); } catch (e) { return ""; } };

  await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));
  conf(600000); seed();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1" }), stdio: "ignore", windowsHide: true });

  // prepare un scenario : conf, etat, amont, compteurs a zero ; renvoie le repere de journal
  const prep = (maxWait, st, m) => { conf(maxWait); seed(st); reset(); Object.assign(modes, m); return logLen(); };
  const b3600 = { mode: "429", ra: 3600, probes: true };

  scenario("S1 epingle 429 -> epinglage deplace sur b, requete servie par b", async () => {
    const L = prep(600000, { forceIndex: 0 }, { a: { mode: "429", ra: 60 }, b: { mode: "ok" } });
    const r = await post(PROXY, {});
    assert.strictEqual(r.status, 200, "statut 200 attendu, recu " + r.status + " " + r.body.slice(0, 80));
    assert.ok(r.body.includes('"b"'), "servi par b : " + r.body);
    assert.strictEqual(state().forceIndex, 1, "forceIndex deplace sur b");
    assert.strictEqual(reelles.a, 1, "une requete reelle sur a");
    assert.ok(/EPINGLE deplace a -> b/.test(logDepuis(L)), "journal EPINGLE deplace a -> b");
  });

  scenario("S2 compte demande (x-cqr-compte) en 429 -> politique normale", async () => {
    const L = prep(600000, {}, { a: { mode: "429", ra: 60 }, b: { mode: "ok" } });
    const r = await post(PROXY, { "x-cqr-compte": "a" });
    assert.strictEqual(r.status, 200, "statut 200 attendu, recu " + r.status + " " + r.body.slice(0, 80));
    assert.ok(r.body.includes('"b"'), "servi par b : " + r.body);
    assert.ok(state().forceIndex == null, "forceIndex non cree");
    assert.ok(/x-cqr-compte ignore compte=a raison=epuise/.test(logDepuis(L)), "journal x-cqr-compte ignore ... raison=epuise");
  });

  scenario("S3 aucun autre compte -> attente puis reprise par le compte epingle", async () => {
    const L = prep(600000, { forceIndex: 0, exhausted: { b: Date.now() + 2 * 3600e3 } }, { a: { mode: "429-puis-ok", ra: 1 }, b: b3600 });
    const t0 = Date.now();
    const r = await post(PROXY, {});
    assert.strictEqual(r.status, 200, "statut 200 attendu, recu " + r.status + " " + r.body.slice(0, 80));
    assert.ok(Date.now() - t0 < 15000, "en moins de 15 s : " + (Date.now() - t0));
    assert.strictEqual(reelles.a, 2, "2 requetes reelles sur a, recu " + reelles.a);
    assert.strictEqual(reelles.b, 0, "0 requete reelle sur b, recu " + reelles.b);
    assert.ok(/WAIT/.test(logDepuis(L)), "journal WAIT");
    assert.strictEqual(state().forceIndex, 0, "forceIndex reste sur a");
  });

  scenario("S4 plafond d'attente atteint -> le 429 est rendu, sans boucle", async () => {
    const L = prep(0, { forceIndex: 0, exhausted: { b: Date.now() + 2 * 3600e3 } }, { a: { mode: "429", ra: 3600 }, b: b3600 });
    const r = await post(PROXY, {});
    assert.strictEqual(r.status, 429, "statut 429 rendu, recu " + r.status);
    assert.ok(reelles.a >= 1 && reelles.a <= 2, "au plus 2 requetes reelles sur a, recu " + reelles.a);
    assert.ok(/WAIT giveup/.test(logDepuis(L)), "journal WAIT giveup");
  });

  scenario("S5 hors demande : 401 et 200-rejected rendus tels quels, epinglage intact", async () => {
    prep(600000, { forceIndex: 0 }, { a: { mode: "401" }, b: { mode: "ok" } });
    let r = await post(PROXY, {});
    assert.strictEqual(r.status, 401, "401 rendu, recu " + r.status);
    assert.strictEqual(state().forceIndex, 0, "forceIndex reste 0 (401)");
    assert.strictEqual(reelles.b, 0, "0 requete reelle sur b (401), recu " + reelles.b);
    prep(600000, { forceIndex: 0 }, { a: { mode: "200-rejected" }, b: { mode: "ok" } });
    r = await post(PROXY, {});
    assert.strictEqual(r.status, 200, "200 rendu, recu " + r.status);
    assert.ok(r.body.includes('"a"'), "rendu par a : " + r.body);
    assert.strictEqual(state().forceIndex, 0, "forceIndex reste 0 (200-rejected)");
  });

  let failed = 0;
  try {
    let up = false; for (let i = 0; i < 40 && !up; i++) { up = await new Promise((r) => { const q = http.get("http://127.0.0.1:" + PROXY + "/__proxy_health", (x) => { x.resume(); r(x.statusCode === 200); }); q.on("error", () => r(false)); }); if (!up) await sleep(150); }
    assert.ok(up, "relais demarre");
    await sleep(3000); // les sondes de demarrage (0,5 s puis toutes les 2 s, une par compte) se calment
    for (const [name, fn] of scenarios) {
      let verdict;
      try { await fn(); verdict = "PASS  " + name; }
      catch (e) { failed++; verdict = "FAIL  " + name + "\n        " + String(e.message).split("\n")[0].slice(0, 600); }
      console.log(verdict);
    }
  } catch (e) { failed++; console.error("FAIL: " + e.message); }
  finally {
    try { child.kill(); } catch (e) { /* deja arrete */ }
    try { mock.closeAllConnections(); mock.close(); } catch (e) { /* deja ferme */ }
    await sleep(200);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* dossier temporaire, sans importance */ }
    clearTimeout(watchdog);
  }
  if (failed) { console.error(failed + " scenario(s) en echec sur " + scenarios.length); process.exit(1); }
  console.log("PASS — " + scenarios.length + " scenarios (429 epingle deplace, 429 demande, aucun autre compte, plafond rendu, 401/200-rejected inchanges)");
})();
