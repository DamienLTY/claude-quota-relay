// Tests for src/setup-path.js. NEVER calls the real Windows registry (exec is always injected)
// and NEVER touches the real user's shell rc files (temp dirs only). Run: node test/setup-path.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path");
const sp = require("../src/setup-path.js");

// --- hasDir (pure; Windows PATH is ';'-separated) ---
assert.strictEqual(sp.hasDir("", "C:\\a\\b"), false, "empty PATH -> false");
assert.strictEqual(sp.hasDir("C:\\x;C:\\a\\b;C:\\y", "C:\\a\\b"), true, "present");
assert.strictEqual(sp.hasDir("C:\\x;C:\\a\\b;C:\\y", "C:\\a\\b\\"), true, "trailing slash ignored");
assert.strictEqual(sp.hasDir("C:\\x;C:\\y", "C:\\a\\b"), false, "absent");
assert.strictEqual(sp.hasDir("C:\\x;C:\\A\\B;C:\\y", "C:\\a\\b"), true, "case-insensitive");

// --- writeWrappers ---
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-path-"));
  fs.writeFileSync(p.join(T, "cli.js"), "// stub");
  const { posixPath, cmdPath, dir } = sp.writeWrappers(T);
  assert.ok(fs.existsSync(posixPath), "posix wrapper created");
  assert.ok(fs.existsSync(cmdPath), "cmd wrapper created");
  const posixContent = fs.readFileSync(posixPath, "utf8");
  assert.ok(posixContent.startsWith("#!/usr/bin/env sh"), "posix wrapper has shebang");
  assert.ok(posixContent.includes(p.join(T, "cli.js").replace(/\\/g, "/")), "posix wrapper points at cli.js (absolute)");
  const cmdContent = fs.readFileSync(cmdPath, "utf8");
  assert.ok(cmdContent.includes("@echo off"), "cmd wrapper has @echo off");
  assert.ok(cmdContent.includes(p.join(T, "cli.js")), "cmd wrapper points at cli.js (absolute)");
  assert.ok(cmdContent.includes("exit /b %errorlevel%"), "cmd wrapper propagates exit code");
  if (process.platform !== "win32") {
    const mode = fs.statSync(posixPath).mode & 0o777;
    assert.strictEqual(mode, 0o755, "posix wrapper is executable");
  }
  fs.rmSync(T, { recursive: true, force: true });
}

// --- ensureWindowsPath / removeWindowsPath : exec is INJECTED, never touches the real registry ---
{
  let current = "C:\\Windows;C:\\Windows\\System32";
  const exec = (args) => {
    const cmd = args[args.length - 1];
    if (cmd.includes("GetEnvironmentVariable")) return current;
    const m = cmd.match(/SetEnvironmentVariable\('Path', '(.*)', 'User'\)/);
    if (m) { current = m[1].replace(/''/g, "'"); return ""; }
    throw new Error("unexpected command: " + cmd);
  };
  const r1 = sp.ensureWindowsPath("C:\\Users\\x\\cqr\\bin", { exec });
  assert.strictEqual(r1.changed, true, "adds dir when absent");
  assert.ok(current.includes("C:\\Users\\x\\cqr\\bin"), "registry (faked) now contains the bin dir");
  const before = current;
  const r2 = sp.ensureWindowsPath("C:\\Users\\x\\cqr\\bin", { exec });
  assert.strictEqual(r2.changed, false, "idempotent: no change on 2nd call");
  assert.strictEqual(current, before, "PATH unchanged on 2nd call");
  const r3 = sp.removeWindowsPath("C:\\Users\\x\\cqr\\bin", { exec });
  assert.strictEqual(r3.changed, true, "remove: reports change");
  assert.ok(!current.includes("cqr\\bin"), "remove: dir gone from (faked) registry");
  assert.ok(current.includes("C:\\Windows"), "remove: unrelated entries preserved");
}

// --- ensurePosixPath / removePosixPath : real fs calls but on a TEMP rc file only ---
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-rc-"));
  const rcFile = p.join(T, ".bashrc");
  fs.writeFileSync(rcFile, "# my existing bashrc\nexport FOO=bar\n");
  const r1 = sp.ensurePosixPath("/home/x/cqr/bin", { rcFile });
  assert.strictEqual(r1.changed, true, "adds block");
  let content = fs.readFileSync(rcFile, "utf8");
  assert.ok(content.includes("export FOO=bar"), "existing content preserved");
  assert.ok(content.includes(sp.MARK_BEGIN) && content.includes(sp.MARK_END), "marked block present");
  assert.ok(content.includes('export PATH="/home/x/cqr/bin:$PATH"'), "PATH export correct");
  const r2 = sp.ensurePosixPath("/home/x/cqr/bin", { rcFile });
  assert.strictEqual(r2.changed, false, "idempotent: no 2nd block");
  const content2 = fs.readFileSync(rcFile, "utf8");
  assert.strictEqual((content2.match(new RegExp(sp.MARK_BEGIN, "g")) || []).length, 1, "still exactly one marked block");
  const rm = sp.removePosixPath({ rcFiles: [rcFile] });
  assert.strictEqual(rm.touched.length, 1, "remove touches the file");
  const content3 = fs.readFileSync(rcFile, "utf8");
  assert.ok(!content3.includes(sp.MARK_BEGIN), "marked block removed");
  assert.ok(content3.includes("export FOO=bar"), "unrelated content still preserved after removal");
  fs.rmSync(T, { recursive: true, force: true });
}

// --- pickRcFile ---
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-pick-"));
  const existsSync = (f) => f === p.join(T, ".zshrc");
  assert.strictEqual(sp.pickRcFile(T, "/bin/zsh", existsSync), p.join(T, ".zshrc"), "picks existing .zshrc for zsh shell");
  fs.rmSync(T, { recursive: true, force: true });
}

console.log("PASS — setup-path: hasDir, wrappers, windows PATH (injected exec), posix rc (temp file), pickRcFile");
