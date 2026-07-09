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
    } finally { blocker.close(); cleanup(DIR); }
    console.log("PASS — cqr start: port conflict correctly detected (not falsely reported as started)");
  }
})();
