// Compactage anticipe (DR-980, DR-985) : le VRAI proxy contre un amont simule local (aucun reseau, aucun quota).
// Cas (a) a (i) du plan : interrupteur, classes, agents en cours, fin de tour, coupure, sonde, en-tete Host.
// Run: node test/anticipe-e2e.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok, ko) => { const s = require("net").createServer(); s.on("error", ko); s.listen(0, "127.0.0.1", () => { const n = s.address().port; s.close(() => ok(n)); }); });

let MOCK_PORT, PROXY_PORT;
const reqs = []; // requetes de flux vues par l'amont : { host, ae, mode }
const sseEv = (nom, d) => "event: " + nom + "\ndata: " + JSON.stringify(d) + "\n\n";
// 4 + 1000 + 289000 = 290004 de contexte reel ; declenchement 282000 pour 333000 a 0,94
function sse(stop) {
  return sseEv("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: 289000, output_tokens: 1 } } })
    + sseEv("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })
    + sseEv("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 57 } })
    + sseEv("message_stop", { type: "message_stop" });
}
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const H = { "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
        if (!body.stream) { res.writeHead(200, Object.assign({ "content-type": "application/json" }, H)); res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } })); return; }
        const mode = req.headers["x-test-mode"] || "end_turn";
        reqs.push({ host: req.headers.host, ae: req.headers["accept-encoding"], mode });
        if (mode === "gz") { // amont qui compresse malgre tout : le relais ne doit pas toucher a ce flux
          const z = require("zlib").gzipSync(Buffer.from(sse("end_turn")));
          res.writeHead(200, Object.assign({ "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": z.length }, H)); res.end(z); return;
        }
        res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H));
        if (mode === "cut") {
          res.write(sse("end_turn").slice(0, 700)); // coupe au milieu d'un evenement
          setTimeout(() => { try { res.socket.destroy(); } catch (e) {} }, 150);
          return;
        }
        res.end(sse(mode));
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}
function health(port) {
  return new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + port + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
}
const lance = (id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: " + id + "\noutput_file: x" }] }] });
const MSG_AGENT = [{ role: "user", content: "go" }, lance("a1")];
const MSG_RIEN = [{ role: "user", content: "go" }];
function ask({ messages, headers, model }) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ model: model || "claude-opus-5-5", max_tokens: 10, stream: true, messages: messages || MSG_AGENT }));
    const out = { cleanEnd: false, error: null, status: 0, headers: {}, body: Buffer.alloc(0) };
    const parts = [];
    const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST",
      headers: Object.assign({ "content-type": "application/json", "content-length": data.length, "accept-encoding": "gzip, deflate", "x-claude-code-request-class": "main", "x-claude-code-session-id": "sess1234abcd" }, headers || {}) }, (res) => {
      out.status = res.statusCode; out.headers = res.headers;
      res.on("data", (c) => parts.push(c));
      res.on("end", () => { out.cleanEnd = true; out.body = Buffer.concat(parts); resolve(out); });
      res.on("error", (e) => { out.error = e.code || e.message; resolve(out); });
      res.on("aborted", () => { out.error = out.error || "aborted"; resolve(out); });
    });
    q.on("error", (e) => { out.error = e.code || e.message; resolve(out); });
    q.setTimeout(20000, () => { q.destroy(); out.error = "TIMEOUT"; resolve(out); });
    q.write(data); q.end();
  });
}
const deltaUsage = (buf) => JSON.parse(/event: message_delta\ndata: (.*)\n/.exec(buf.toString("utf8"))[1]).usage;

(async () => {
  PROXY_PORT = await freePort(); MOCK_PORT = await freePort();
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-anticipe-"));
  const USAGE = p.join(DIR, "usage.jsonl");
  for (const f of ["proxy.js", "compaction.js", "lib.js", "anticipe.js", "sonde-sse.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  const ecrireConf = (anticipe) => fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, maxWaitMs: 600000, pollMs: 15000, livePollMs: 0,
    compaction: anticipe === undefined ? { enabled: false } : { enabled: false, anticipe }, tokens: [{ name: "account1", token: FAKE, enabled: true }] }));
  const ON = { enabled: true, ratio: 0.94, fenetres: { "claude-opus-5-5": 333000 } };
  ecrireConf(ON);
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));
  const mock = await startMock();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1", CQR_USAGE_FILE: USAGE }), stdio: "ignore", windowsHide: true });
  const journal = () => { try { return fs.readFileSync(p.join(DIR, "proxy.log"), "utf8"); } catch (e) { return ""; } };

  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40; i++) { if (await health(PROXY_PORT)) { up = true; break; } await sleep(150); }
    assert.ok(up, "proxy should be up");
    await sleep(400);
    const REF_FIN = Buffer.from(sse("end_turn"));
    const REF_TOOL = Buffer.from(sse("tool_use"));

    // (b) allume, main, agent en cours, 290 k sur 333 k, end_turn -> delta reecrit
    reqs.length = 0;
    const b = await ask({});
    assert.strictEqual(b.error, null, "b : pas d'erreur " + b.error); assert.strictEqual(b.status, 200);
    assert.ok(!b.headers["content-encoding"], "b : pas de content-encoding"); assert.ok(!b.headers["content-length"], "b : pas de content-length");
    const u = deltaUsage(b.body);
    assert.strictEqual(u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, 320000, "b : entree gonflee jusqu'a la cible (320000)");
    assert.strictEqual(u.output_tokens, 57);
    assert.strictEqual(reqs[0].ae, undefined, "b : accept-encoding retire vers l'amont");
    assert.ok(!b.body.equals(REF_FIN), "b : flux different de l'amont");
    assert.strictEqual(b.body.toString("utf8").replace(/event: message_delta\ndata: .*\n\n/, ""), REF_FIN.toString("utf8").replace(/event: message_delta\ndata: .*\n\n/, ""), "b : tout le reste octet pour octet");
    // (i) l'amont voit Host avec son port
    assert.strictEqual(reqs[0].host, "127.0.0.1:" + MOCK_PORT, "i : Host de l'amont avec son port");
    await sleep(300);
    const lg = journal();
    assert.ok(/ANTICIPE gonfle session=sess1234 model=claude-opus-5-5 contexte=290004 declenchement=282000 cible=320000 agents=1/.test(lg), "b : ligne ANTICIPE gonfle : " + (lg.match(/ANTICIPE.*/g) || []).join(" | "));
    // (h) la sonde garde les VRAIS nombres d'Anthropic
    const lignes = fs.readFileSync(USAGE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const vu = lignes.filter((l) => l.cache_read_input_tokens === 289000);
    assert.ok(vu.length >= 1, "h : journal d'usage = 289000 reel : " + JSON.stringify(lignes).slice(0, 300));
    assert.ok(!lignes.some((l) => l.cache_read_input_tokens > 289000), "h : jamais la valeur gonflee dans le journal d'usage");

    // (a) interrupteur eteint (et absent) -> octets identiques, accept-encoding transmis
    for (const etat of [Object.assign({}, ON, { enabled: false }), undefined]) {
      ecrireConf(etat); reqs.length = 0;
      const a = await ask({});
      assert.ok(a.body.equals(REF_FIN), "a : octets identiques a l'amont (eteint)");
      assert.ok(/gzip/.test(reqs[0].ae || ""), "a : accept-encoding transmis quand eteint");
    }
    ecrireConf(ON);

    // (c) classe subagent -> identique, accept-encoding transmis
    reqs.length = 0;
    let r = await ask({ headers: { "x-claude-code-request-class": "subagent" } });
    assert.ok(r.body.equals(REF_FIN), "c : identique (subagent)"); assert.ok(/gzip/.test(reqs[0].ae || ""), "c : accept-encoding transmis");
    // classe absente (en-tetes d'indice non poses) -> inerte
    const sansClasse = await new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, stream: true, messages: MSG_AGENT }));
      const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, (res) => { const pp = []; res.on("data", (c) => pp.push(c)); res.on("end", () => resolve(Buffer.concat(pp))); });
      q.write(data); q.end();
    });
    assert.ok(sansClasse.equals(REF_FIN), "c : sans en-tete de classe -> inerte");
    // (d) en-tete agent-id -> identique
    reqs.length = 0;
    r = await ask({ headers: { "x-claude-code-agent-id": "agent-xyz" } });
    assert.ok(r.body.equals(REF_FIN), "d : identique (agent-id)"); assert.ok(/gzip/.test(reqs[0].ae || ""), "d : accept-encoding transmis");
    // (e) tool_use -> identique
    r = await ask({ headers: { "x-test-mode": "tool_use" } });
    assert.ok(r.body.equals(REF_TOOL), "e : identique (tool_use)");
    // (f) aucun agent en cours -> identique ; et modele sans fenetre -> identique
    reqs.length = 0;
    r = await ask({ messages: MSG_RIEN });
    assert.ok(r.body.equals(REF_FIN), "f : identique (aucun agent)"); assert.ok(/gzip/.test(reqs[0].ae || ""), "f : accept-encoding transmis");
    // agent lance PUIS notification de fin rangee dans un message de role system (forme reelle de Claude Code) -> identique
    r = await ask({ messages: MSG_AGENT.concat([{ role: "system", content: [{ type: "text", text: "[SYSTEM NOTIFICATION - NOT USER INPUT]" + String.fromCharCode(10) + "<task-notification><task-id>a1</task-id><status>completed</status></task-notification>" }] }]) });
    assert.ok(r.body.equals(REF_FIN), "f : identique (notification recue, role system)");
    r = await ask({ model: "claude-sonnet-5-5" });
    assert.ok(r.body.equals(REF_FIN), "f : identique (modele sans fenetre)");
    // sous le seuil : ratio 0.99 -> 297000 > 290004 : candidat mais pas de gonflement, ligne sous-le-seuil
    ecrireConf(Object.assign({}, ON, { ratio: 0.99 }));
    r = await ask({});
    assert.ok(r.body.equals(REF_FIN), "sous le seuil : identique");
    await sleep(200);
    assert.ok(/ANTICIPE sous-le-seuil contexte=290004 declenchement=297000/.test(journal()), "ligne sous-le-seuil");
    ecrireConf(ON);

    // reponse deja compressee par l'amont : octets, content-encoding et content-length intacts
    r = await ask({ headers: { "x-test-mode": "gz" } });
    assert.strictEqual(r.headers["content-encoding"], "gzip", "gz : content-encoding conserve");
    assert.ok(r.headers["content-length"], "gz : content-length conserve");
    assert.ok(require("zlib").gunzipSync(r.body).equals(REF_FIN), "gz : corps intact");

    // (g) amont coupe au milieu avec le Transform -> erreur reseau franche chez le client, jamais un corps propre
    r = await ask({ headers: { "x-test-mode": "cut" } });
    assert.ok(!r.cleanEnd, "g : un flux tronque n'est jamais rendu comme termine proprement");
    assert.ok(r.error && r.error !== "TIMEOUT", "g : erreur reseau franche, or : " + r.error);

    console.log("PASS - anticipe-e2e : cas a a i (eteint, gonflement, classes, agent-id, tool_use, aucun agent, coupure, sonde, Host)");
  } catch (e) { failed = e; }
  finally {
    try { child.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.stack || failed.message); process.exit(1); }
})();
