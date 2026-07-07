"use strict";
/* claude-quota-relay — automatic `cqr` command setup (no manual shell alias needed).
 *
 * Writes two tiny wrapper scripts into <installDir>/bin/ (both just call `node cli.js`):
 *   - `cqr`      (POSIX shell, for macOS/Linux/Git-Bash/WSL)
 *   - `cqr.cmd`  (Windows cmd.exe AND PowerShell both resolve external .cmd files via PATH)
 * then registers <installDir>/bin on the user's PATH so `cqr` works in any NEW terminal:
 *   - Windows  : the per-user PATH via the .NET Environment API (NOT `setx`, which silently
 *                truncates PATH values over 1024 chars and can corrupt an already-long PATH).
 *   - macOS/Linux : an idempotent, clearly-marked block appended to a shell rc file.
 * Both paths are pure-logic-friendly (an injectable `exec`/fs for tests) and fully reversible
 * (see removeAlias, used by uninstall.js). Never touches PATH if `cqr`'s bin dir is already in it.
 */
const fs = require("fs");
const os = require("os");
const p = require("path");
const cp = require("child_process");

function binDir(installDir) { return p.join(installDir, "bin"); }

// Pure: is `dir` already one of the ';'-separated entries of a Windows PATH string? (Only used
// on the Windows branch; POSIX uses a marked-block check instead, see ensurePosixPath.)
function hasDir(pathVar, dir) {
  if (!pathVar) return false;
  const norm = (s) => s.replace(/[\\/]+$/, "").toLowerCase();
  const target = norm(dir);
  return pathVar.split(";").some((seg) => seg && norm(seg) === target);
}

// Wrapper scripts forward to cli.js by its ABSOLUTE path (baked in at write time) — simpler and
// more reliable than resolving argv[0]/$0, which some shells don't set to a full path.
function writeWrappers(installDir) {
  const dir = binDir(installDir);
  fs.mkdirSync(dir, { recursive: true });
  const cliJs = p.join(installDir, "cli.js");
  const posixPath = p.join(dir, "cqr");
  const cmdPath = p.join(dir, "cqr.cmd");
  fs.writeFileSync(posixPath, '#!/usr/bin/env sh\nexec node "' + cliJs.replace(/\\/g, "/") + '" "$@"\n');
  try { fs.chmodSync(posixPath, 0o755); } catch (e) {}
  fs.writeFileSync(cmdPath, "@echo off\r\nnode \"" + cliJs + "\" %*\r\nexit /b %errorlevel%\r\n");
  return { posixPath, cmdPath, dir };
}

// --- Windows: user PATH via .NET Environment API (avoids setx's 1024-char truncation bug) ---
function psExec(args) { return cp.execFileSync("powershell.exe", args, { encoding: "utf8", windowsHide: true }); }
const escPs = (s) => s.replace(/'/g, "''");

function ensureWindowsPath(dir, opts) {
  const exec = (opts && opts.exec) || psExec;
  const before = String(exec(["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"])).replace(/\r?\n$/, "");
  if (hasDir(before, dir)) return { changed: false, before, after: before };
  const after = before && before.length ? before.replace(/;$/, "") + ";" + dir : dir;
  exec(["-NoProfile", "-NonInteractive", "-Command", "[Environment]::SetEnvironmentVariable('Path', '" + escPs(after) + "', 'User')"]);
  return { changed: true, before, after };
}
function removeWindowsPath(dir, opts) {
  const exec = (opts && opts.exec) || psExec;
  const before = String(exec(["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"])).replace(/\r?\n$/, "");
  const norm = (s) => s.replace(/[\\/]+$/, "").toLowerCase();
  const target = norm(dir);
  const after = before.split(";").filter((seg) => seg && norm(seg) !== target).join(";");
  if (after === before) return { changed: false, before, after };
  exec(["-NoProfile", "-NonInteractive", "-Command", "[Environment]::SetEnvironmentVariable('Path', '" + escPs(after) + "', 'User')"]);
  return { changed: true, before, after };
}

// --- POSIX: append an idempotent PATH export to a shell rc file ---
const MARK_BEGIN = "# >>> claude-quota-relay PATH >>>";
const MARK_END = "# <<< claude-quota-relay PATH <<<";

function pickRcFile(home, shellEnv, existsSync) {
  existsSync = existsSync || fs.existsSync;
  const shell = (shellEnv || "").toLowerCase();
  const ordered = [];
  if (shell.includes("zsh")) ordered.push(p.join(home, ".zshrc"));
  if (shell.includes("bash")) ordered.push(p.join(home, ".bashrc"));
  ordered.push(p.join(home, ".bashrc"), p.join(home, ".zshrc"), p.join(home, ".profile"));
  for (const c of ordered) if (existsSync(c)) return c;
  return ordered[0]; // none exist yet -> create the most likely one
}

function ensurePosixPath(dir, opts) {
  opts = opts || {};
  const home = opts.home || os.homedir();
  const existsSync = opts.existsSync || fs.existsSync;
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const writeFileSync = opts.writeFileSync || fs.writeFileSync;
  const rcFile = opts.rcFile || pickRcFile(home, opts.shellEnv || process.env.SHELL, existsSync);
  let cur = "";
  if (existsSync(rcFile)) { try { cur = readFileSync(rcFile, "utf8"); } catch (e) {} }
  if (cur.includes(MARK_BEGIN)) return { changed: false, rcFile };
  const block = "\n" + MARK_BEGIN + "\nexport PATH=\"" + dir + ":$PATH\"\n" + MARK_END + "\n";
  writeFileSync(rcFile, cur + block);
  return { changed: true, rcFile };
}
function removePosixPath(opts) {
  opts = opts || {};
  const home = opts.home || os.homedir();
  const existsSync = opts.existsSync || fs.existsSync;
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const writeFileSync = opts.writeFileSync || fs.writeFileSync;
  const rcFiles = opts.rcFiles || [p.join(home, ".zshrc"), p.join(home, ".bashrc"), p.join(home, ".profile")];
  const re = new RegExp("\\n?" + MARK_BEGIN + "[\\s\\S]*?" + MARK_END + "\\n?");
  const touched = [];
  for (const f of rcFiles) {
    if (!existsSync(f)) continue;
    let cur; try { cur = readFileSync(f, "utf8"); } catch (e) { continue; }
    if (!cur.includes(MARK_BEGIN)) continue;
    writeFileSync(f, cur.replace(re, "\n"));
    touched.push(f);
  }
  return { touched };
}

// Top-level: write wrappers + register PATH for the current platform.
// opts.skipRegister: write the wrapper files but never touch the real registry/rc file — the
// test seam (also honored via the CQR_SKIP_PATH_REGISTER env var, checked by callers).
function ensureAlias(installDir, opts) {
  opts = opts || {};
  const { dir } = writeWrappers(installDir);
  if (opts.skipRegister) return { dir, platform: process.platform, changed: false, skipped: true };
  if (process.platform === "win32") { const r = ensureWindowsPath(dir, opts); return { dir, platform: "win32", changed: r.changed }; }
  const r = ensurePosixPath(dir, opts);
  return { dir, platform: process.platform, changed: r.changed, rcFile: r.rcFile };
}
function removeAlias(installDir, opts) {
  opts = opts || {};
  const dir = binDir(installDir);
  if (!opts.skipRegister) {
    const r = process.platform === "win32" ? removeWindowsPath(dir, opts) : removePosixPath(opts);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    return r;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return { changed: false, skipped: true };
}

module.exports = { binDir, hasDir, writeWrappers, ensureWindowsPath, removeWindowsPath, pickRcFile, ensurePosixPath, removePosixPath, ensureAlias, removeAlias, MARK_BEGIN, MARK_END };
