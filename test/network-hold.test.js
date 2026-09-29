// Anthropic injoignable sans coupure franche (DR-011) : connexion muette apres une veille ou un
// changement de reseau, erreur hors de l'ancienne liste de codes (certificat intercepte par un
// VPN type Zscaler, portail...). Avant le correctif : le client restait pendu sur la connexion
// muette, et l'erreur inconnue lui revenait tout de suite -- 11 tentatives brulees en 3 min,
// sous-agent mort (mesure reelle le 2026-09-28).
// Run: node test/network-hold.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const PROXY_PORT = 8796, MOCK_PORT = 8797;
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// plan : comportement de chaque vraie requete, dans l'ordre. "mute" = accepte et ne repond
// jamais ; "garbage" = repond autre chose que du HTTP (erreur que l'ancienne liste ignorait).
let plan = [], hits = 0;
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const H = { "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
        if (body.max_tokens === 0) { res.writeHead(200, H); res.end("{}"); return; } // sonde de quota
        hits++;
        const what = plan.shift() || "ok";
        if (what === "slow") { setTimeout(() => { res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H)); res.end('event: message_stop\ndata: {"ok":true}\n\n'); }, 2500); return; }
        if (what === "mute") return;
        if (what === "garbage") { req.socket.end("PAS DU HTTP\r\n\r\n"); return; }
        if (what === "headers") { res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H)); res.flushHeaders(); return; } // en-tetes, puis rien du tout
        if (what === "cut400") { res.writeHead(400, Object.assign({ "content-type": "application/json", "content-length": "500" }, H)); res.write('{"type":"err'); setTimeout(() => { try { req.socket.destroy(); } catch (e) {} }, 200); return; }
        if (what === "stall") { res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H)); res.write("event: ping\ndata: {}\n\n"); return; } // puis plus rien
        if (body.stream) { res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, H)); res.end('event: message_stop\ndata: {"ok":true}\n\n'); return; }
        res.writeHead(200, Object.assign({ "content-type": "application/json" }, H));
        res.end(JSON.stringify({ ok: true }));
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}
function health(port) {
  return new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + port + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
}
function ask(stream, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, stream: !!stream, messages: [{ role: "user", content: "go" }] }));
    const out = { error: null, status: 0, body: "", ms: 0 };
    const done = () => { out.ms = Date.now() - t0; resolve(out); };
    const q = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      out.status = res.statusCode;
      res.on("data", (c) => (out.body += c));
      res.on("end", done);
      res.on("error", (e) => { out.error = e.code || e.message; done(); });
    });
    q.on("error", (e) => { out.error = e.code || e.message; done(); });
    q.setTimeout(timeoutMs, () => { q.destroy(); out.error = "TIMEOUT"; done(); });
    q.write(data); q.end();
  });
}

(async () => {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-net-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  const conf = (extra) => fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify(Object.assign({ port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, maxWaitMs: 600000, pollMs: 15000, livePollMs: 0, tokens: [{ name: "account1", token: FAKE, enabled: true }] }, extra)));
  conf({ upstreamIdleMs: 1500 });
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));

  const mock = await startMock();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1" }), stdio: "ignore", windowsHide: true });

  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40; i++) { if (await health(PROXY_PORT)) { up = true; break; } await sleep(150); }
    assert.ok(up, "proxy should be up");
    await sleep(600);

    // --- 1. connexion muette (veille, reseau change) : le relais la tient pour morte, garde le
    // client en ligne et refait la requete. Avant : client pendu jusqu'a son propre delai.
    plan = ["mute", "ok"]; hits = 0;
    const r1 = await ask(true, 12000);
    assert.strictEqual(r1.error, null, "connexion muette : le client ne doit voir aucune erreur, or: " + r1.error);
    assert.ok(/"ok":true/.test(r1.body), "la reponse arrive apres la reprise: " + r1.body.slice(0, 160));
    assert.ok(/claude-auth-proxy/.test(r1.body), "le client a recu un signal pendant la reprise");
    assert.strictEqual(hits, 2, "une connexion morte + une reprise, or: " + hits);

    // --- 2. erreur hors de l'ancienne liste (comme un certificat intercepte) : retenue et
    // retentee, au lieu d'un 502 immediat.
    plan = ["garbage", "garbage", "ok"]; hits = 0;
    const r2 = await ask(true, 20000);
    assert.strictEqual(r2.error, null, "erreur inconnue : aucune erreur cote client, or: " + r2.error);
    assert.strictEqual(r2.status, 200, "pas de 502 rendu au client");
    assert.ok(/"ok":true/.test(r2.body), "la reponse arrive apres deux echecs: " + r2.body.slice(0, 160));

    // --- 3. la reponse a commence puis se fige (reseau coupe en plein flux, sans erreur) :
    // rejouer doublerait la reponse, donc coupure franche -- que le client sait retenter.
    // Avant : client pendu indefiniment.
    plan = ["stall"]; hits = 0;
    const r4 = await ask(true, 12000);
    assert.ok(r4.error && r4.error !== "TIMEOUT", "flux fige : erreur reseau franche, pas de client pendu, or: " + r4.error);
    assert.ok(r4.ms < 8000, "coupe apres le delai de silence, or " + r4.ms + " ms");
    assert.strictEqual(hits, 1, "pas de rejeu une fois des octets partis");

    // --- 4. panne qui ne se regle pas : au bout du budget, l'erreur remonte (60 min en vrai,
    // 3 s ici) -- le client n'est jamais laisse pendu.
    conf({ upstreamIdleMs: 1500, networkErrorMaxMs: 3000 });
    plan = Array(50).fill("garbage"); hits = 0;
    const r3 = await ask(false, 30000);
    assert.notStrictEqual(r3.error, "TIMEOUT", "le client ne reste pas pendu");
    assert.strictEqual(r3.status, 502, "l'erreur remonte une fois le budget epuise, or: " + r3.status);
    assert.ok(r3.ms >= 2500, "la requete a ete retentee pendant le budget avant d'abandonner, or " + r3.ms + " ms");
    assert.ok(hits >= 2, "plusieurs tentatives avant l'abandon, or: " + hits);

    // --- 5. en-tetes recus a chaque tentative mais jamais de corps : le budget des coupures
    // doit quand meme s'epuiser (sinon retente indefiniment, budget remis a zero par les en-tetes).
    plan = Array(50).fill("headers"); hits = 0;
    const r5 = await ask(true, 15000);
    assert.ok(r5.error && r5.error !== "TIMEOUT", "en-tetes sans corps : le budget s'epuise, le client est coupe, or: " + r5.error);
    assert.ok(hits >= 2, "plusieurs tentatives avant l'abandon, or: " + hits);

    // --- 6. corps d'un 400 coupe en route : le client ne reste pas pendu.
    plan = ["cut400"]; hits = 0;
    const r6 = await ask(false, 8000);
    assert.ok(r6.error && r6.error !== "TIMEOUT", "400 coupe en plein corps : erreur reseau franche, pas de client pendu, or: " + r6.error);

    // --- 7. upstreamIdleMs: 0 = detection desactivee (convention du fichier). Sans garde, 0 + 1 s
    // de supplement abattait un amont qui repond en 2,5 s, a chaque tentative, pendant 60 min.
    conf({ upstreamIdleMs: 0 });
    plan = ["slow"]; hits = 0;
    const r7 = await ask(true, 12000);
    assert.strictEqual(r7.error, null, "upstreamIdleMs 0 : un amont lent est servi, or: " + r7.error);
    assert.ok(/"ok":true/.test(r7.body), "reponse complete: " + r7.body.slice(0, 120));
    assert.strictEqual(hits, 1, "une seule requete amont (detection coupee), or: " + hits);

    console.log("PASS — connexion muette reprise, flux fige coupe net, erreur inconnue retentee, abandon propre au bout du budget, budget tenu meme si des en-tetes arrivent, 400 coupe sans client pendu, detection desactivable");
  } catch (e) { failed = e; }
  finally {
    try { child.kill(); } catch (e) {}
    try { mock.closeAllConnections(); mock.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
