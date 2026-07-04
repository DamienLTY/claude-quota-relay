// Tests for the status line wrapper (no network). Run: node test/statusline.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");
const lib = require("../src/lib.js");

const SCRIPT = p.join(__dirname, "..", "src", "cqr-statusline.js");

// fmtDur shape
assert.strictEqual(lib.fmtDur(null), "?", "unknown reset -> ?");
assert.strictEqual(lib.fmtDur(Date.now() - 1000), "0min", "past reset -> 0min");
assert.ok(/^\d+min$/.test(lib.fmtDur(Date.now() + 30 * 60000)), "30min -> Nmin");
assert.ok(/^\dh\d\dmin$/.test(lib.fmtDur(Date.now() + 65 * 60000)), ">1h -> XhYYmin");
assert.ok(/^\dj\d\dh$/.test(lib.fmtDur(Date.now() + (4 * 24 + 9) * 3600000)), ">24h -> XjYYh");

function setup(statusline) {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-sl-"));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ tokens: [
    { name: "compte1", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000", enabled: true },
    { name: "compte2", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000001", enabled: true },
  ] }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({
    pct: { compte1: { h5: 40, d7: 12 }, compte2: { h5: 73, d7: 55 } },
    reset5h: { compte1: Date.now() + 65 * 60000, compte2: Date.now() + 20 * 60000 },
    reset7d: { compte1: Date.now() + 3 * 3600000, compte2: Date.now() + 5 * 3600000 },
  }));
  fs.writeFileSync(p.join(DIR, "statusline.json"), JSON.stringify(statusline));
  return DIR;
}
function run(DIR) {
  return cp.spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ session_id: "x", model: { id: "claude-opus-4-8" } }), env: Object.assign({}, process.env, { CQR_DIR: DIR }), encoding: "utf8" }).stdout;
}

// Case A: no existing status line -> our two segments only
{
  const out = run(setup({ original: null }));
  assert.ok(out.includes("API-1 | 5h 40% - Reset à"), "API-1 rendered: " + out);
  assert.ok(out.includes("API-2 | 5h 73% - Reset à"), "API-2 rendered");
  assert.ok(out.includes("7j 12%") && out.includes("7j 55%"), "7d rendered");
  assert.ok(out.includes(" || "), "segments joined by ||");
  assert.ok(/Reset à \dh\d\dmin/.test(out) || /Reset à \d+min/.test(out), "reset duration formatted");
}

// Case B: existing status line is WRAPPED (prefix kept, ours appended)
{
  const out = run(setup({ original: { type: "command", command: "echo MYLINE" } }));
  assert.ok(out.startsWith("MYLINE || API-1"), "original prefix kept then ours appended: " + out);
}

console.log("PASS — statusline: standalone, wrapped-existing, numbering, reset formatting");
