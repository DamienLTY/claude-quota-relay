// Coupure reseau PENDANT le corps de la reponse (cable ethernet debranche, bascule wifi).
// Avant le correctif, le proxy laissait passer un corps tronque -- que Claude Code n'arrivait
// plus a decompresser : "API Error: ZlibError fetching http://127.0.0.1:8788/v1/messages"
// (vecu le 01/09/2026) -- ou laissait le client pendu sans jamais rien lui repondre.
// Run: node test/stream-cut.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const PROXY_PORT = 8798, MOCK_PORT = 8799;
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cutMode: "before" = en-tetes puis coupure AVANT le moindre octet de corps (rattrapable) ;
//          "after"  = un morceau de corps est deja parti, PUIS coupure (non rejouable).
let cutMode = null, cutsLeft = 0, realHits = 0;
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const H = { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
        if (body.max_tokens === 0) { res.writeHead(200, H); res.end("{}"); return; } // sonde de quota
        realHits++;
        if (cutsLeft > 0) {
          cutsLeft--;
          res.writeHead(200, H);
          res.flushHeaders(); // en-tetes REELLEMENT recues par le proxy -> la coupure porte bien
                              // sur le CORPS, pas sur l'etablissement de la connexion (deja gere)
          if (cutMode === "after") res.write('{"debut":"' + "x".repeat(200)); // corps a moitie ecrit
          setTimeout(() => { try { res.socket.destroy(); } catch (e) {} }, 120);
          return;
        }
        res.writeHead(200, H);
        res.end(JSON.stringify({ ok: true, hits: realHits, usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}
function health(port) {
  return new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + port + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
}
// Renvoie ce que le CLIENT a reellement vecu : fin propre, ou erreur reseau.
function ask(stream, timeoutMs) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, stream: !!stream, messages: [{ role: "user", content: "go" }] }));
    const out = { cleanEnd: false, error: null, status: 0, body: "" };
    const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      out.status = res.statusCode;
      res.on("data", (c) => (out.body += c));
      res.on("end", () => { out.cleanEnd = true; resolve(out); });
      res.on("error", (e) => { out.error = e.code || e.message; resolve(out); });
    });
    q.on("error", (e) => { out.error = e.code || e.message; resolve(out); });
    q.setTimeout(timeoutMs, () => { q.destroy(); out.error = "TIMEOUT"; resolve(out); });
    q.write(data); q.end();
  });
}

(async () => {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-cut-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, maxWaitMs: 600000, pollMs: 15000, livePollMs: 0, tokens: [{ name: "account1", token: FAKE, enabled: true }] }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));

  const mock = await startMock();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1" }), stdio: "ignore", windowsHide: true });

  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40; i++) { if (await health(PROXY_PORT)) { up = true; break; } await sleep(150); }
    assert.ok(up, "proxy should be up");
    await sleep(400);

    // --- 1. coupure AVANT le premier octet : rien n'est encore parti au client, donc la
    // requete est rejouable -> le proxy la refait tout seul et l'utilisateur ne voit rien.
    cutMode = "before"; cutsLeft = 1; realHits = 0;
    const r1 = await ask(false, 20000);
    assert.strictEqual(r1.error, null, "coupure avant le 1er octet : le client ne doit voir AUCUNE erreur, or: " + r1.error);
    assert.strictEqual(r1.status, 200, "reponse servie normalement apres la reprise");
    assert.ok(JSON.parse(r1.body).ok, "corps complet et valide (pas tronque): " + r1.body);
    assert.strictEqual(realHits, 2, "le proxy a bien REFAIT la requete upstream (1 coupee + 1 aboutie), or: " + realHits);

    // --- 2. coupure APRES des octets deja relayes : rejouer doublerait la reponse. Le client
    // doit recevoir une erreur RESEAU franche (qu'il sait retenter), jamais un corps tronque
    // rendu comme une reponse propre -- c'est ce corps-la qui donnait le ZlibError.
    cutMode = "after"; cutsLeft = 99; realHits = 0;
    const r2 = await ask(false, 20000);
    assert.ok(!r2.cleanEnd, "un corps tronque ne doit JAMAIS etre rendu comme une reponse terminee proprement");
    assert.ok(r2.error && r2.error !== "TIMEOUT", "le client voit une erreur reseau franche, il ne reste pas pendu, or: " + r2.error);
    assert.strictEqual(realHits, 1, "aucun rejeu quand des octets sont deja partis (sinon reponse dupliquee)");

    // --- 3. meme coupure sur une requete STREAM : la connexion est tenue ouverte en SSE
    // pendant la reprise, puis la reponse complete arrive.
    cutMode = "before"; cutsLeft = 1; realHits = 0;
    const r3 = await ask(true, 20000);
    assert.strictEqual(r3.error, null, "stream : aucune erreur cote client, or: " + r3.error);
    assert.ok(/claude-auth-proxy/.test(r3.body), "stream : la connexion a ete tenue ouverte pendant la reprise: " + r3.body.slice(0, 120));
    assert.ok(/"ok":true/.test(r3.body), "stream : la reponse complete est bien arrivee apres la reprise");

    console.log("PASS — coupure en plein flux: rejouee si rien n'est parti, erreur reseau franche sinon (jamais de corps tronque -> plus de ZlibError), tenue en SSE si stream");
  } catch (e) { failed = e; }
  finally {
    try { child.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
