// Uninstall regression test: soft uninstall keeps tokens/install dir + cqr wrappers, restores the
// original status line; --purge removes everything including the PATH alias. Never touches the
// real Windows registry / shell rc file (CQR_SKIP_PATH_REGISTER seam). Run: node test/uninstall.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const INSTALLER = p.join(__dirname, "..", "src", "install.js");
const UNINSTALLER = p.join(__dirname, "..", "src", "uninstall.js");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const ENV = Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1" });

const CFG = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-uninstall-"));
const IDIR = p.join(CFG, "claude-quota-relay");
const SETTINGS = p.join(CFG, "settings.json");
fs.writeFileSync(SETTINGS, JSON.stringify({ env: { FOO: "bar" }, statusLine: { type: "command", command: "echo MINE" } }));

// --- install first (non-interactive, path registration skipped) ---
const ri = cp.spawnSync(process.execPath, [INSTALLER, "--no-interactive", "--config-dir", CFG], { encoding: "utf8", env: ENV });
assert.strictEqual(ri.status, 0, "install exits 0: " + (ri.stderr || ""));
assert.ok(fs.existsSync(p.join(IDIR, "bin", "cqr")), "install created the cqr wrapper");

// --- soft uninstall: keeps tokens.json + install dir + wrappers, restores original statusline ---
const r1 = cp.spawnSync(process.execPath, [UNINSTALLER, "--config-dir", CFG], { encoding: "utf8", env: ENV });
assert.strictEqual(r1.status, 0, "soft uninstall exits 0: " + (r1.stderr || ""));
const s1 = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
assert.strictEqual(s1.env.FOO, "bar", "unrelated env preserved");
assert.strictEqual(s1.env.ANTHROPIC_BASE_URL, undefined, "our env vars removed");
assert.strictEqual(s1.statusLine.command, "echo MINE", "original status line restored");
assert.ok(!s1.hooks || !JSON.stringify(s1.hooks).includes("memory-hook.js"), "our hooks removed");
assert.ok(fs.existsSync(p.join(IDIR, "tokens.json")), "soft uninstall keeps tokens.json");
assert.ok(fs.existsSync(p.join(IDIR, "bin", "cqr")), "soft uninstall keeps the cqr wrapper (still usable)");

// --- purge: removes the whole install dir (incl. bin/ wrappers) ---
const r2 = cp.spawnSync(process.execPath, [UNINSTALLER, "--config-dir", CFG, "--purge"], { encoding: "utf8", env: ENV });
assert.strictEqual(r2.status, 0, "purge uninstall exits 0: " + (r2.stderr || ""));
assert.ok(!fs.existsSync(IDIR), "purge removes the whole install dir");

fs.rmSync(CFG, { recursive: true, force: true });
console.log("PASS — uninstall: soft keeps tokens/wrappers + restores statusline, --purge removes everything");
