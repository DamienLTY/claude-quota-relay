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
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const auth = req.headers["authorization"] || "";
        probeHits[auth] = (probeHits[auth] || 0) + 1;
        res.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": String(Math.min(0.99, probeHits[auth] * 0.01)),
          "anthropic-ratelimit-unified-7d-utilization": "0.5",
          "anthropic-ratelimit-unified-status": "allowed",
        });
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
    port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, waitAtSoftPercent: null, maxWaitMs: 600000, pollMs: 15000,
    livePollMs: opts.livePollMs,
    compaction,
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
