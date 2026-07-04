// Proves the v1 -> current upgrade path: re-running the installer over an existing v1 install
// preserves tokens/port/user settings, backfills new config, adds new hooks + wraps the status
// line WITHOUT duplicating, and is idempotent on a second run. Run: node test/upgrade.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const INSTALLER = p.join(__dirname, "..", "src", "install.js");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

const CFG = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-up-"));
const IDIR = p.join(CFG, "claude-quota-relay");
fs.mkdirSync(IDIR, { recursive: true });

// --- simulate a v1 install: tokens.json without compaction/guard, custom port, a v1 settings.json
fs.writeFileSync(p.join(IDIR, "tokens.json"), JSON.stringify({ port: 9999, switchAtPercent: 94, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
fs.writeFileSync(p.join(CFG, "settings.json"), JSON.stringify({
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999", FOO: "bar" },
  hooks: { SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: 'node "' + p.join(IDIR, "ensure-proxy.js") + '"' }] }] },
  statusLine: { type: "command", command: "echo MINE" },
}));

function install() { return cp.spawnSync(process.execPath, [INSTALLER, "--no-interactive", "--config-dir", CFG], { encoding: "utf8" }); }
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const count = (obj, re) => (JSON.stringify(obj).match(re) || []).length;

// --- first upgrade run ---
const r1 = install();
assert.strictEqual(r1.status, 0, "installer exits 0: " + (r1.stderr || ""));

const tok = rd(p.join(IDIR, "tokens.json"));
assert.ok(tok.compaction && tok.workflowGuard, "backfilled compaction + workflowGuard");
assert.strictEqual(tok.port, 9999, "custom port preserved (no --port given)");
assert.strictEqual(tok.tokens[0].token, FAKE, "existing token preserved");

const s = rd(p.join(CFG, "settings.json"));
assert.strictEqual(s.env.FOO, "bar", "unrelated user env preserved");
assert.ok(s.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "timeouts applied");
assert.strictEqual(count(s.hooks, /ensure-proxy\.js/g), 1, "ensure-proxy hook once");
assert.strictEqual(count(s.hooks, /memory-hook\.js/g), 3, "memory hook on 3 events");
assert.strictEqual(count(s.hooks, /cqr-workflow-guard\.js/g), 1, "guard hook once");
assert.ok(s.statusLine.command.includes("cqr-statusline.js"), "statusline wrapped");
assert.strictEqual(rd(p.join(IDIR, "statusline.json")).original.command, "echo MINE", "original statusline saved");
["compaction.js", "memory-hook.js", "cqr-statusline.js", "cqr-workflow-guard.js"].forEach((f) => assert.ok(fs.existsSync(p.join(IDIR, f)), f + " copied on upgrade"));

// --- second run: must be idempotent (no duplicates, no re-wrap) ---
const r2 = install();
assert.strictEqual(r2.status, 0, "second run exits 0");
const s2 = rd(p.join(CFG, "settings.json"));
assert.strictEqual(count(s2.hooks, /ensure-proxy\.js/g), 1, "ensure-proxy still once");
assert.strictEqual(count(s2.hooks, /memory-hook\.js/g), 3, "memory hooks still 3 (no dup)");
assert.strictEqual(count(s2.hooks, /cqr-workflow-guard\.js/g), 1, "guard still once (no dup)");
assert.strictEqual(rd(p.join(IDIR, "statusline.json")).original.command, "echo MINE", "not re-wrapped (original intact)");

fs.rmSync(CFG, { recursive: true, force: true });
console.log("PASS — upgrade v1->current: preserves config, adds new hooks + statusline, idempotent");
