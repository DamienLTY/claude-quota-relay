// `cqr start`/`restart` used to always print "Proxy démarré." even if the spawned process
// crashed immediately (a real user hit this: proxy never actually came up, no visibility into
// why). Now it polls health after spawning and, on failure, surfaces the crash log tail.
// Run: node test/start-verify.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

function setupDir(port) {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-start-"));
  for (const f of ["proxy.js", "cli.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port, switchAtPercent: 94, sevenDayBlockPercent: 99, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
  return DIR;
}
function runCli(DIR, args) {
  return cp.spawnSync(process.execPath, [p.join(DIR, "cli.js"), ...args], { encoding: "utf8", timeout: 15000, windowsHide: true });
}
function cleanup(DIR) {
  try { cp.spawnSync(process.execPath, [p.join(DIR, "cli.js"), "stop"], { windowsHide: true }); } catch (e) {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  // --- Case A: normal start -> detected as a real success ---
  {
    const DIR = setupDir(8796);
    const r = runCli(DIR, ["start"]);
    assert.strictEqual(r.status, 0, "healthy start exits 0: " + r.stdout + r.stderr);
    assert.ok(r.stdout.includes("opérationnel"), "reports real success, not just 'spawned': " + r.stdout);
    cleanup(DIR);
    console.log("PASS — cqr start: healthy proxy detected as truly running");
  }

  // --- Case B: proxy.js itself crashes on startup (corporate antivirus killing it, a missing
  // dependency, any uncaught exception) -> failure detected, NOT silently reported as started,
  // and the crash reason is visible in the output. cli.js's OWN deps (compaction.js/lib.js) are
  // left intact -- only proxy.js (a separate process) is broken, to isolate the failure mode. ---
  {
    const DIR = setupDir(8797);
    fs.writeFileSync(p.join(DIR, "proxy.js"), 'throw new Error("simulated crash (e.g. corporate antivirus killed the process, or a real bug)");');
    const r = runCli(DIR, ["start"]);
    assert.strictEqual(r.status, 1, "broken proxy: cqr start exits 1 (not a false success): " + r.stdout);
    assert.ok(r.stderr.includes("ne répond pas") || r.stderr.includes("planté"), "explains the proxy didn't come up: " + r.stderr);
    assert.ok(/simulated crash/i.test(r.stderr), "surfaces the actual crash reason from proxy.out.log: " + r.stderr);
    cleanup(DIR);
    console.log("PASS — cqr start: proxy crash correctly detected + crash reason surfaced from the log");
  }

  // --- Case C: port already occupied by something else -> failure detected ---
  {
    const DIR = setupDir(8798);
    const blocker = http.createServer((req, res) => res.end("not the proxy"));
    await new Promise((resolve) => blocker.listen(8798, "127.0.0.1", resolve));
    try {
      const r = runCli(DIR, ["start"]);
      assert.strictEqual(r.status, 1, "port conflict: cqr start exits 1: " + r.stdout);
      assert.ok(r.stderr.includes("ne répond pas") || r.stderr.includes("planté"), "reports failure on port conflict: " + r.stderr);
      // Real bug found via a user report: proxy.js's server.on("error", ...) writes EADDRINUSE
      // to proxy.log (its own structured log), NOT proxy.out.log (raw stdout/stderr) -- the
      // diagnostic used to only read the latter, so this exact case was silently unhelpful.
      assert.ok(/EADDRINUSE/.test(r.stderr), "surfaces the EADDRINUSE detail from proxy.log: " + r.stderr);
      assert.ok(/cqr policy port/.test(r.stderr), "suggests the concrete fix: " + r.stderr);
    } finally { blocker.close(); cleanup(DIR); }
    console.log("PASS — cqr start: port conflict correctly detected + real EADDRINUSE cause surfaced from proxy.log");
  }

  // --- Case D: `cqr policy port <n>` actually unblocks a stuck install (the remedy Case C
  // points to) -- updates tokens.json AND settings.json's ANTHROPIC_BASE_URL, then a real start
  // on the new port succeeds. ---
  {
    // cli.js resolves settings.json as a sibling of the install dir (p.dirname(__dirname)) --
    // mirror the real <config>/claude-quota-relay layout, like upgrade.test.js does.
    const CFG = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-policy-"));
    const DIR = p.join(CFG, "claude-quota-relay");
    fs.mkdirSync(DIR, { recursive: true });
    for (const f of ["proxy.js", "cli.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
    fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8799, switchAtPercent: 94, sevenDayBlockPercent: 99, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
    const realSettings = p.join(CFG, "settings.json");
    fs.writeFileSync(realSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8799", FOO: "bar" } }));
    const blocker = http.createServer((req, res) => res.end("not the proxy"));
    await new Promise((resolve) => blocker.listen(8799, "127.0.0.1", resolve));
    try {
      const pol = runCli(DIR, ["policy", "port", "8800"]);
      assert.ok(pol.stdout.includes("8800"), "confirms the new port: " + pol.stdout);
      const conf = JSON.parse(fs.readFileSync(p.join(DIR, "tokens.json"), "utf8"));
      assert.strictEqual(conf.port, 8800, "tokens.json updated: " + JSON.stringify(conf));
      const settings = JSON.parse(fs.readFileSync(realSettings, "utf8"));
      assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8800", "settings.json updated: " + JSON.stringify(settings));
      assert.strictEqual(settings.env.FOO, "bar", "unrelated settings preserved: " + JSON.stringify(settings));
      const r = runCli(DIR, ["start"]);
      assert.strictEqual(r.status, 0, "start on the new port succeeds: " + r.stdout + r.stderr);
    } finally { blocker.close(); cleanup(DIR); fs.rmSync(CFG, { recursive: true, force: true }); }
    console.log("PASS — cqr policy port: unblocks a port conflict end-to-end (tokens.json + settings.json + real restart)");
  }
})();
