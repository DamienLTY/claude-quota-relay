// Tests for the workflow quota guard PreToolUse hook. Run: node test/guard.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const SCRIPT = p.join(__dirname, "..", "src", "cqr-workflow-guard.js");

function setup(guard, h5best) {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-guard-"));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({
    workflowGuard: guard,
    tokens: [
      { name: "compte1", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000", enabled: true },
      { name: "compte2", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000001", enabled: true },
    ],
  }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ pct: { compte1: { h5: h5best, d7: 20 }, compte2: { h5: 95, d7: 90 } } }));
  return DIR;
}
function run(DIR, tool) {
  const r = cp.spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_name: tool, tool_input: {} }), env: Object.assign({}, process.env, { CQR_DIR: DIR }), encoding: "utf8" });
  return { out: (r.stdout || "").trim(), code: r.status };
}

// best account below threshold -> allow silently
{
  const r = run(setup({ enabled: true, mode: "ask", percent: 50 }, 40), "Workflow");
  assert.strictEqual(r.out, "", "best 40% < 50% -> no output (allow)");
}
// best account at/above threshold -> ask, with reason mentioning the %
{
  const r = run(setup({ enabled: true, mode: "ask", percent: 50 }, 80), "Workflow");
  const j = JSON.parse(r.out);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, "PreToolUse", "PreToolUse event");
  assert.strictEqual(j.hookSpecificOutput.permissionDecision, "ask", "ask decision");
  assert.ok(/80%/.test(j.hookSpecificOutput.permissionDecisionReason), "reason cites the headroom");
}
// mode deny -> deny
{
  const r = run(setup({ enabled: true, mode: "deny", percent: 50 }, 80), "Workflow");
  assert.strictEqual(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny", "deny mode");
}
// mode off -> allow silently even when low
{
  const r = run(setup({ enabled: true, mode: "off", percent: 50 }, 90), "Workflow");
  assert.strictEqual(r.out, "", "mode off -> no output");
}
// non-Workflow tool -> allow silently
{
  const r = run(setup({ enabled: true, mode: "ask", percent: 50 }, 90), "Bash");
  assert.strictEqual(r.out, "", "non-Workflow tool ignored");
}
// unknown quota -> allow (fail open)
{
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-guard-"));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ workflowGuard: { enabled: true, mode: "ask", percent: 50 }, tokens: [{ name: "compte1", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000", enabled: true }] }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ pct: {} }));
  const r = run(DIR, "Workflow");
  assert.strictEqual(r.out, "", "unknown quota -> allow");
}

console.log("PASS — workflow guard: allow<threshold, ask/deny>=threshold, off, non-Workflow, fail-open");
