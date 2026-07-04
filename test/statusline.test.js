// Tests for the compact status line (no network). Run: node test/statusline.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");
const lib = require("../src/lib.js");

const SCRIPT = p.join(__dirname, "..", "src", "cqr-statusline.js");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, ""); // remove ANSI colors

// fmtDur shape (used by cqr preflight)
assert.strictEqual(lib.fmtDur(null), "?", "unknown -> ?");
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

// Case A: standalone -> cumulative 5h bar + mean% + clock reset + per-account 7j bars
{
  const out = strip(run(setup({ original: null })));
  assert.ok(out.startsWith("5h "), "starts with 5h: " + out);
  assert.ok(out.includes("7j "), "has 7j section");
  assert.ok(/↻\d\dh\d\d/.test(out), "next reset shown as a clock time (↻HHhMM)");
  assert.ok(out.includes("①") && out.includes("②"), "one 7j bar per account, numbered");
  assert.ok(out.includes("█"), "has progress bars");
  assert.ok(out.includes("57%"), "5h mean of 40 and 73 = 57%"); // cumulative fleet %
  assert.ok(!/Reset à/.test(out), "no verbose 'Reset à' text");
  assert.ok(!/API-1 \|/.test(out), "no old verbose per-account list");
}

// Case B: wrapped -> original kept as prefix, ours after " │ "
{
  const out = strip(run(setup({ original: { type: "command", command: "echo MYLINE" } })));
  assert.ok(out.startsWith("MYLINE │ 5h "), "original prefix kept then ours: " + out);
}

console.log("PASS — statusline: cumulative 5h + clock reset + per-account 7j, wrapped, no verbose text");
