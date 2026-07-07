// Tests for ANTHROPIC_TARGET_API_URL support (corporate networks where api.anthropic.com is
// blocked -- the user routes through their own relay, e.g. a Cloudflare Worker). Claude Code
// itself does NOT read this variable; our proxy + lib.js must, so the whole toolset (routing,
// probes, statusline data, compaction's Haiku call) works behind that block.
// Run: node test/upstream-override.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const lib = require("../src/lib.js");

// --- lib.resolveUpstream (pure) ---
{
  delete process.env.ANTHROPIC_TARGET_API_URL;
  const u = lib.resolveUpstream();
  assert.strictEqual(u.hostname, "api.anthropic.com", "no env var -> default host");
  assert.strictEqual(u.port, 443, "default port 443");
  assert.strictEqual(u.pathPrefix, "", "default: no path prefix");
}
{
  process.env.ANTHROPIC_TARGET_API_URL = "https://claude.example-worker.workers.dev";
  const u = lib.resolveUpstream();
  assert.strictEqual(u.hostname, "claude.example-worker.workers.dev", "custom host used");
  assert.strictEqual(u.port, 443, "https default port 443");
  assert.strictEqual(u.pathPrefix, "", "no path in the URL -> empty prefix");
  delete process.env.ANTHROPIC_TARGET_API_URL;
}
{
  process.env.ANTHROPIC_TARGET_API_URL = "http://internal-relay.corp:8080/anthropic-proxy";
  const u = lib.resolveUpstream();
  assert.strictEqual(u.hostname, "internal-relay.corp", "custom http host");
  assert.strictEqual(u.port, 8080, "custom port parsed");
  assert.strictEqual(u.pathPrefix, "/anthropic-proxy", "path prefix parsed (trailing slash stripped)");
  delete process.env.ANTHROPIC_TARGET_API_URL;
}
{
  process.env.ANTHROPIC_TARGET_API_URL = "not a valid url  ";
  const u = lib.resolveUpstream();
  assert.strictEqual(u.hostname, "api.anthropic.com", "invalid URL -> falls back to default, never throws");
  delete process.env.ANTHROPIC_TARGET_API_URL;
}

console.log("PASS — lib.resolveUpstream: default, https custom, http custom + path prefix, invalid falls back");

// --- e2e: spawn the REAL proxy with ONLY ANTHROPIC_TARGET_API_URL set (not the CQR_UPSTREAM_*
// test seam) and confirm it actually forwards to that relay, using the real env var name a
// corporate user would set. ---
(async () => {
  const SRC = p.join(__dirname, "..", "src");
  const PROXY_PORT = 8794, RELAY_PORT = 8795;
  const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-upstream-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({
    port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, waitAtSoftPercent: null, maxWaitMs: 600000, pollMs: 15000,
    tokens: [{ name: "a", token: FAKE, enabled: true }],
  }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));

  let relayHits = 0;
  const relay = http.createServer((req, res) => {
    relayHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, via: "corporate-relay" }));
  });
  await new Promise((resolve) => relay.listen(RELAY_PORT, "127.0.0.1", resolve));

  // No CQR_UPSTREAM_* here -- ANTHROPIC_TARGET_API_URL is the ONLY override, exactly as a real
  // corporate user's settings.json env block would set it (inherited by the proxy child process).
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], {
    env: Object.assign({}, process.env, { ANTHROPIC_TARGET_API_URL: "http://127.0.0.1:" + RELAY_PORT }),
    stdio: "ignore", windowsHide: true,
  });

  function health() {
    return new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + PROXY_PORT + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40; i++) { if (await health()) { up = true; break; } await sleep(150); }
    assert.ok(up, "proxy (ANTHROPIC_TARGET_API_URL set) should be up");
    await sleep(600); // the startup probe alone should hit the relay, not api.anthropic.com
    assert.ok(relayHits > 0, "proxy's startup probe reached the corporate relay (ANTHROPIC_TARGET_API_URL), not api.anthropic.com");
    console.log("PASS — proxy e2e: ANTHROPIC_TARGET_API_URL alone (no test seam) routes real traffic through the relay (" + relayHits + " hit(s))");
  } catch (e) { failed = e; }
  finally {
    try { child.kill(); } catch (e) {}
    try { relay.close(); } catch (e) {}
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
