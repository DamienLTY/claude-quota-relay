// End-to-end: spawn the REAL proxy against a LOCAL mock upstream (no network, no quota),
// force an account switch, and assert the proxy actually injected the context-editing
// edit + beta header into the outgoing request (native mode), and did NOT in dry-run.
// Run: node test/proxy-e2e.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const PROXY_PORT = 8792, MOCK_PORT = 8793;
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const FAKE1 = "sk-ant-oat01-FAKE-ACCOUNT-ONE-not-real-0000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": data.length, "authorization": "Bearer client-placeholder", "anthropic-beta": "existing-beta-1" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
function health(port) {
  return new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + port + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
}

// Mock upstream: echoes back whether the request carried context_management + which beta header,
// AND returns rate-limit headers whose value increments on every hit (per-token counter) --
// lets the live-poll test detect that a token got probed AGAIN (a changed % = a new probe).
const probeHits = {};
// mockMode="overage" : rejoue le cas reel "forfait epuise mais credits disponibles" -- Anthropic
// repond 200 (la requete EST servie, facturee aux credits) avec unified-status:rejected.
let mockMode = null;
// mockMode="500" : panne serveur Anthropic. `fail500` = nombre de reponses 500 restantes a
// servir (Infinity = panne permanente). Chaque 500 servi est compte dans hits500.
let fail500 = 0, hits500 = 0, fail529 = 0;
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const auth = req.headers["authorization"] || "";
        probeHits[auth] = (probeHits[auth] || 0) + 1;
        // les pannes simulees ne visent que les VRAIES requetes : la sonde de quota
        // (max_tokens:0) doit continuer a repondre, comme cote Anthropic ou elle passe meme
        // quand les grosses requetes sont refusees.
        const isProbe = body && body.max_tokens === 0;
        if (!isProbe && fail500 > 0) { fail500--; hits500++; res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } })); return; }
        if (!isProbe && fail529 > 0) { fail529--; res.writeHead(529, { "content-type": "application/json", "retry-after": "0" }); res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })); return; }
        res.writeHead(200, Object.assign({
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": String(Math.min(0.99, probeHits[auth] * 0.01)),
          "anthropic-ratelimit-unified-7d-utilization": "0.5",
          "anthropic-ratelimit-unified-status": "allowed",
        }, mockMode === "overage" ? {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-overage-status": "allowed",
          "anthropic-ratelimit-unified-overage-utilization": "0.03",
          "anthropic-ratelimit-unified-overage-in-use": "true",
        } : null));
        res.end(JSON.stringify({ echo: { has_cm: !!body.context_management, edits: (body.context_management || {}).edits || null, beta: req.headers["anthropic-beta"] || null }, usage: { input_tokens: 10, output_tokens: 1 } }));
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const bigBody = () => {
  const m = [{ role: "user", content: "go" }];
  for (let i = 0; i < 6; i++) { m.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: {} }] }); m.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "x".repeat(500) }] }); }
  return { model: "claude-haiku-4-5", max_tokens: 10, messages: m };
};

function seedState(dir) {
  fs.writeFileSync(p.join(dir, "state.json"), JSON.stringify({ activeIndex: 0, pct: { account1: { h5: 99, d7: 50 }, account2: { h5: 40, d7: 50 } }, exhausted: {}, reset5h: {}, reset7d: {} }));
}
function writeConf(dir, compaction, opts) {
  opts = opts || {};
  fs.writeFileSync(p.join(dir, "tokens.json"), JSON.stringify({
    port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99,
    waitAtSoftPercent: opts.waitAtSoftPercent === undefined ? null : opts.waitAtSoftPercent,
    maxWaitMs: 600000, pollMs: 15000, serverErrorMaxMs: opts.serverErrorMaxMs,
    livePollMs: opts.livePollMs,
    compaction, overage: opts.overage,
    tokens: [{ name: "account1", token: opts.tokenAccount1 || FAKE, enabled: opts.bothEnabled ? true : false }, { name: "account2", token: FAKE, enabled: true }],
  }));
}

(async () => {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-e2e-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  writeConf(DIR, { enabled: true, dryRun: false, mode: "native", keepToolUses: 10, thresholds: {} });
  seedState(DIR);

  const mock = await startMock();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1" }), stdio: "ignore", windowsHide: true });

  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40; i++) { if (await health(PROXY_PORT)) { up = true; break; } await sleep(150); }
    assert.ok(up, "proxy should be up");
    await sleep(400); // let startup probe settle

    // --- native mode: switch account1(99%)->account2 must inject clear_tool_uses + beta ---
    seedState(DIR);
    const r1 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r1.status, 200, "native: 200 from mock");
    assert.ok(r1.json && r1.json.echo, "native: got echo");
    assert.strictEqual(r1.json.echo.has_cm, true, "native: proxy injected context_management");
    assert.strictEqual(r1.json.echo.edits[0].type, "clear_tool_uses_20250919", "native: correct edit type");
    assert.strictEqual(r1.json.echo.edits[0].keep.value, 10, "native: keep 10");
    assert.ok(/existing-beta-1/.test(r1.json.echo.beta) && /context-management-2025-06-27/.test(r1.json.echo.beta), "native: beta appended, existing kept");

    // --- dry-run: same switch must NOT modify the body ---
    writeConf(DIR, { enabled: false, dryRun: true, mode: "native", keepToolUses: 10, thresholds: {} });
    seedState(DIR);
    const r2 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r2.json.echo.has_cm, false, "dry-run: body NOT modified");
    assert.ok(!/context-management-2025-06-27/.test(r2.json.echo.beta || ""), "dry-run: beta NOT touched");

    // --- strip mode: body stubbed, response shape unchanged, no context_management ---
    writeConf(DIR, { enabled: true, dryRun: false, mode: "strip", keepToolUses: 2, thresholds: {} });
    seedState(DIR);
    const r3 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r3.status, 200, "strip: 200");
    assert.strictEqual(r3.json.echo.has_cm, false, "strip: no context_management (proxy stubbed the body itself)");

    // --- count_tokens must NOT be compacted (compaction gated to /v1/messages) ---
    writeConf(DIR, { enabled: true, dryRun: false, mode: "native", keepToolUses: 10, thresholds: {} });
    seedState(DIR);
    const r4 = await post(PROXY_PORT, "/v1/messages/count_tokens", bigBody());
    assert.strictEqual(r4.json.echo.has_cm, false, "count_tokens: not compacted (gated to /v1/messages)");

    console.log("PASS — proxy e2e: native inject (+beta merge), dry-run no-op, strip mode, count_tokens skipped");

    // --- credits d'usage supplementaire : le cas REEL "forfait epuise, credits dispo" ---
    // Anthropic renvoie 200 (requete servie sur les credits) avec unified-status:rejected.
    // Avant : le relais lisait "rejected" -> quarantaine du compte + attente d'un reset qui ne
    // sert a rien. Maintenant : reponse rendue au client, compte NON bloque, credits enregistres.
    mockMode = "overage";
    writeConf(DIR, { enabled: false }, { bothEnabled: true });
    seedState(DIR);
    const r5 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r5.status, 200, "credits: la reponse servie sur les credits est rendue au client");
    assert.ok(r5.json && r5.json.echo, "credits: corps de reponse intact");
    const sOv = JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
    const exhausted = Object.keys(sOv.exhausted || {}).filter((k) => sOv.exhausted[k] > Date.now());
    assert.strictEqual(exhausted.length, 0, "credits: aucun compte mis en quarantaine (il repond !): " + JSON.stringify(sOv.exhausted));
    assert.ok(sOv.overage && Object.keys(sOv.overage).length, "credits: etat des credits enregistre");
    const anyOv = sOv.overage[Object.keys(sOv.overage)[0]];
    assert.strictEqual(anyOv.status, "allowed", "credits: statut lu depuis les en-tetes");
    assert.strictEqual(anyOv.u, 3, "credits: 0.03 -> 3% consommes");

    // ... et quand PLUS AUCUN compte n'a de forfait (waitAtSoftPercent atteint), la requete passe
    // par les credits au lieu d'etre retenue des heures.
    writeConf(DIR, { enabled: false }, { bothEnabled: true, waitAtSoftPercent: 95, overage: { use: true, maxPercent: 100 } });
    fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({
      activeIndex: 0, exhausted: {}, reset5h: { account1: Date.now() + 3600000, account2: Date.now() + 3600000 }, reset7d: {},
      pct: { account1: { h5: 100, d7: 50 }, account2: { h5: 100, d7: 50 } },
      overage: { account1: { status: "allowed", u: 3 }, account2: { status: "allowed", u: 3 } },
    }));
    const r6 = await Promise.race([post(PROXY_PORT, "/v1/messages", bigBody()), sleep(5000).then(() => ({ held: true }))]);
    assert.ok(!r6.held, "credits autorises: la requete passe (pas de mise en attente) alors que les 2 comptes sont a 100%");
    assert.strictEqual(r6.status, 200, "credits: 200 rendu au client");
    mockMode = null;
    console.log("PASS — proxy e2e credits: 200 sur credits rendu au client sans quarantaine + routage credits au lieu d'attendre");

    // --- panne serveur Anthropic (500) : la requete est REJOUEE, pas perdue ---
    // Cas reel du 29/07/2026 : deux compactions perdues sur "API Error: 500". Le 500 n'a aucun
    // en-tete de quota -> ce n'est pas une limite, c'est une panne, et elle est intermittente.
    writeConf(DIR, { enabled: false }, { bothEnabled: true });
    seedState(DIR);
    hits500 = 0; fail500 = 1;          // une panne passagere : le 1er appel echoue, le 2e passe
    const t0 = Date.now();
    const r7 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r7.status, 200, "500 passager : la requete est rejouee et aboutit (pas d'erreur rendue au client)");
    assert.ok(r7.json && r7.json.echo, "500 passager : corps de reponse intact apres retry");
    assert.strictEqual(hits500, 1, "500 passager : le mock a bien servi une erreur avant de repondre");
    assert.ok(Date.now() - t0 >= 1500, "500 passager : le retry attend (backoff) au lieu de marteler le serveur");

    // ... mais une panne PERMANENTE ne doit pas suspendre la requete indefiniment : au bout du
    // budget (ici 0 = desactive), la vraie erreur est rendue au client.
    writeConf(DIR, { enabled: false }, { bothEnabled: true, serverErrorMaxMs: 0 });
    seedState(DIR);
    hits500 = 0; fail500 = Infinity;
    const r8 = await Promise.race([post(PROXY_PORT, "/v1/messages", bigBody()), sleep(8000).then(() => ({ held: true }))]);
    assert.ok(!r8.held, "500 permanent : la requete n'est pas suspendue pour toujours");
    assert.strictEqual(r8.status, 500, "500 permanent : la vraie erreur est rendue au client");
    assert.strictEqual(hits500, 1, "serverErrorMaxMs=0 : aucun retry (comportement d'origine preserve)");
    fail500 = 0; hits500 = 0;
    console.log("PASS — proxy e2e panne serveur: 500 passager rejoue et servi, 500 permanent rendu au client (jamais suspendu)");

    // --- surcharge Anthropic (529) : pause enregistree pour que la sonde ne la leve pas ---
    writeConf(DIR, { enabled: false }, { bothEnabled: true });
    seedState(DIR);
    fail529 = 1;                       // le 1er compte servi est refuse, le relais bascule
    const r9 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r9.status, 200, "529 : bascule sur l'autre compte, le client obtient sa reponse");
    const s529 = JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
    const ovl = Object.keys(s529.overload || {});
    assert.strictEqual(ovl.length, 1, "529 : la surcharge est enregistree pour le compte refuse: " + JSON.stringify(s529.overload));
    assert.strictEqual(s529.overload[ovl[0]].n, 1, "529 : premier refus de la serie");
    assert.ok(s529.overload[ovl[0]].until > Date.now() + 60000, "529 : pause d'au moins 90 s posee (la sonde ne pourra pas la lever)");
    assert.ok(s529.exhausted && s529.exhausted[ovl[0]], "529 : compte effectivement mis en pause");
    fail529 = 0;
    console.log("PASS — proxy e2e surcharge 529: bascule de compte + pause horodatee (backoff) enregistree");

    // --- rafraichissement des quotas SANS sonde periodique (nouveau defaut) ---
    // Claude Code ne redessine pas sa barre d'etat tout seul : sonder toutes les 45 s ne servait
    // qu'a generer du trafic (3310 sondes pour 268 vraies requetes le 29/07/2026). Desormais le
    // compte qui sert la requete se renseigne par ses en-tetes, et les AUTRES sont sondes a
    // l'occasion de cette requete.
    writeConf(DIR, { enabled: false }, { bothEnabled: true });   // pas de livePollMs -> mode continu coupe
    fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({
      activeIndex: 0, exhausted: {}, reset5h: {}, reset7d: {},
      pct: { account1: { h5: 99, d7: 50, at: "2020-01-01T00:00:00.000Z" }, account2: { h5: 40, d7: 50, at: "2020-01-01T00:00:00.000Z" } },
    }));
    const r10 = await post(PROXY_PORT, "/v1/messages", bigBody());
    assert.strictEqual(r10.status, 200, "requete servie normalement");
    await sleep(600); // la sonde des autres comptes part en tache de fond, sans retarder la reponse
    const sFresh = JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
    const old = new Date("2021-01-01T00:00:00.000Z").getTime();
    assert.ok(Date.parse(sFresh.pct.account1.at) > old, "compte 1 rafraichi a l'occasion de la requete: " + sFresh.pct.account1.at);
    assert.ok(Date.parse(sFresh.pct.account2.at) > old, "compte 2 rafraichi aussi (celui qui sert la requete, par ses en-tetes)");
    const at1 = sFresh.pct.account1.at;
    await sleep(900); // aucune requete cliente : plus rien ne doit bouger (zero sonde periodique)
    const sIdle = JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
    assert.strictEqual(sIdle.pct.account1.at, at1, "au repos : aucune sonde periodique (c'etait 3310/jour avant)");
    console.log("PASS — proxy e2e sondes: rafraichies a chaque requete, zero trafic au repos");

    // --- live poll: BOTH accounts' quota keeps refreshing in state.json with ZERO client
    // requests (the fix for "statusline only updates the active account, goes stale while
    // idle waiting for a reset"). livePollMs is read once at proxy startup -> restart it. ---
    try { child.kill(); } catch (e) {}
    writeConf(DIR, { enabled: false }, { livePollMs: 150, bothEnabled: true, tokenAccount1: FAKE1 });
    seedState(DIR);
    const child2 = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1" }), stdio: "ignore", windowsHide: true });
    try {
      let up2 = false; for (let i = 0; i < 40; i++) { if (await health(PROXY_PORT)) { up2 = true; break; } await sleep(150); }
      assert.ok(up2, "restarted proxy (live poll config) should be up");
      await sleep(700); // let a couple of 150ms poll cycles run, with zero client requests sent
      const s1 = JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
      assert.ok(s1.pct && s1.pct.account1 && s1.pct.account2, "both accounts probed with no client traffic at all");
      assert.notStrictEqual(s1.pct.account1.h5, 99, "account1's stale seeded value (99%) was refreshed by the background probe");
      assert.notStrictEqual(s1.pct.account2.h5, 40, "account2's stale seeded value (40%) was refreshed too (not just the active one)");
      const h5_1_first = s1.pct.account1.h5;
      await sleep(700); // more cycles -> the mock's incrementing counter proves it's PERIODIC, not one-shot
      const s2 = JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
      assert.ok(s2.pct.account1.h5 > h5_1_first, "account1 keeps being re-probed over time (periodic, not a single probe): " + h5_1_first + " -> " + s2.pct.account1.h5);
      console.log("PASS — live poll: both accounts refresh with zero client requests, periodically (not one-shot)");
    } finally { try { child2.kill(); } catch (e) {} }
  } catch (e) { failed = e; }
  finally {
    try { child.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
