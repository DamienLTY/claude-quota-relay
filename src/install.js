#!/usr/bin/env node
/*
 * claude-quota-relay — installer (cross-platform: macOS / Linux / Windows).
 *
 * What it does (idempotent, safe to re-run):
 *   1. Copies proxy.js / cli.js / ensure-proxy.js into <claude-config>/claude-quota-relay/
 *   2. Creates tokens.json (interactive token entry, or placeholders if non-interactive)
 *   3. Patches <claude-config>/settings.json:
 *        - env: ANTHROPIC_BASE_URL + the timeouts that make the "hold until reset" behaviour work
 *        - env: ANTHROPIC_AUTH_TOKEN = first real token (Claude Code needs a token to start;
 *               the proxy rewrites the Authorization header per request anyway)
 *        - hooks.SessionStart: starts the proxy automatically on every session (portable autostart)
 *   4. Backs up settings.json before touching it.
 *
 * Flags: --port <n>   --no-interactive   --config-dir <path>
 *
 * Get your per-account tokens with:  claude setup-token   (run once per Claude subscription/account)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const p = require("path");
const readline = require("readline");
const lib = require("./lib.js");
const setupPath = require("./setup-path.js");

// Minimal, NO_COLOR-aware console styling for a clean install experience.
const COLOR = !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? "\x1b[" + code + "m" + s + "\x1b[0m" : s);
const bold = (s) => c(1, s), dim = (s) => c(90, s), green = (s) => c(32, s), yellow = (s) => c(33, s);
function section(title) { console.log("\n" + bold(title)); }
function ok(s) { console.log("  " + green("✓") + " " + s); }
function info(s) { console.log("  " + dim("· " + s)); }
function warn(s) { console.log("  " + yellow("!") + " " + s); }

const SRC_DIR = __dirname; // repo/src
const REPO_ROOT = p.dirname(SRC_DIR);
const EXAMPLE_TOKENS = p.join(REPO_ROOT, "config", "tokens.example.json");
const COPY_FILES = ["proxy.js", "cli.js", "ensure-proxy.js", "lib.js", "compaction.js", "memory-hook.js", "cqr-statusline.js", "cqr-workflow-guard.js"];

// Default workflow guard: warn (ask) before a Workflow when the freshest account is >=50% (5h),
// because the Workflow tool's per-agent stall can't be extended by the relay.
const WORKFLOW_GUARD_DEFAULT = { enabled: true, mode: "ask", percent: 50 };

// Default auto-compaction config: OFF + dry-run so the user opts in after observing.
const COMPACTION_DEFAULT = {
  enabled: false, dryRun: true, mode: "native",
  thresholds: { fable: 85, opus: 89, sonnet: 90, haiku: 95, default: 88 },
  keepToolUses: 10, triggerTokens: 2000, compactBeforeResume: true, compactionCooldownMs: 600000,
  memoryFile: ".cqr-memory.md", memoryMaxLines: 400, archiveDir: ".cqr-archive",
};

// Timeouts injected into settings.json env. These are what let a held request survive until a 5h
// window resets instead of being cut. CLAUDE_STREAM_IDLE_TIMEOUT_MS is the critical one (the CLI's
// semantic idle watchdog defaults to a 5-minute floor that SSE keepalive does NOT reset).
const TIMEOUTS = {
  API_TIMEOUT_MS: "605400000",                    // ~7 days, overall HTTP request timeout
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: "605400000",      // ~7 days, semantic stream idle (THE fix)
  CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "605400000",// ~7 days, subagent stall watchdog
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "120000",    // 2 min, byte-level idle (fed by 20s keepalive)
};

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const NO_INTERACTIVE = process.argv.includes("--no-interactive") || !process.stdin.isTTY;
const CONFIG_DIR = arg("--config-dir", process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), ".claude"));
const PORT_EXPLICIT = process.argv.includes("--port");
let PORT = String(arg("--port", "8787"));
const INSTALL_DIR = p.join(CONFIG_DIR, "claude-quota-relay");
const SETTINGS = p.join(CONFIG_DIR, "settings.json");

// One-shot prompt (open+ask+close) so it never conflicts with captureSetupToken's own readline.
function prompt1(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res((a || "").trim()); });
  });
}

async function collectTokens() {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_TOKENS, "utf8"));
  example.port = Number(PORT);
  if (NO_INTERACTIVE) {
    info("non-interactive: tokens.json written with placeholders");
    info("fill them in later with: cqr login <name>");
    return example;
  }
  section("Accounts");
  console.log("  You can rotate as many Claude accounts as you like (2, 3, 5...). For each one, log in");
  console.log("  through your browser — the token is captured automatically, no copy-paste needed.\n");
  let n = parseInt(await prompt1("  How many accounts do you want to rotate? [2] "), 10);
  if (!Number.isFinite(n) || n < 1) n = 2;

  const tokens = [];
  for (let i = 0; i < n; i++) {
    console.log("\n  " + bold("Account " + (i + 1) + "/" + n));
    if (i > 0) await prompt1("  Log OUT of the previous account in your browser, then press Enter to continue... ");
    const name = (await prompt1(`  Name [account-${i + 1}]: `)) || `account-${i + 1}`;
    const tok = await lib.captureSetupToken(); // runs `claude setup-token`, captures the token (paste fallback)
    if (tok) { ok("captured token for '" + name + "' (" + lib.mask(tok) + ")"); tokens.push({ name, token: tok, enabled: true }); }
    else { warn("skipped '" + name + "' — add it later with: cqr login " + name); tokens.push({ name, token: "PASTE_TOKEN_FROM_claude_setup-token", enabled: true }); }
  }
  example.tokens = tokens;
  return example;
}

function firstRealToken(conf) {
  const t = (conf.tokens || []).find((x) => x && x.token && !/^(PASTE|REMPLACE|<)/i.test(x.token));
  return t ? t.token : null;
}

function patchSettings(conf) {
  let settings = {};
  let backupName = null;
  if (fs.existsSync(SETTINGS)) {
    const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
    try { settings = JSON.parse(raw); } catch (e) { throw new Error("settings.json is not valid JSON — fix it or move it aside, then re-run.\n  " + e.message); }
    const bak = SETTINGS + ".bak-" + Date.now();
    fs.writeFileSync(bak, raw);
    backupName = p.basename(bak);
  }
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + PORT;
  for (const [k, v] of Object.entries(TIMEOUTS)) settings.env[k] = v;
  const tok = firstRealToken(conf);
  if (tok) settings.env.ANTHROPIC_AUTH_TOKEN = tok;

  settings.hooks = settings.hooks || {};
  let hooksAdded = 0;
  // Register a command hook once (keyed by the script filename in its command).
  function registerHook(event, matcher, script) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (JSON.stringify(settings.hooks[event]).includes(script)) return;
    const entry = { hooks: [{ type: "command", command: 'node "' + p.join(INSTALL_DIR, script) + '"' }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
    hooksAdded++;
  }
  registerHook("SessionStart", "startup|resume|clear", "ensure-proxy.js");          // proxy autostart
  registerHook("SessionStart", "startup|resume|clear", "memory-hook.js");           // inject project memory
  registerHook("UserPromptSubmit", null, "memory-hook.js");                        // refresh memory on switch
  registerHook("PreCompact", null, "memory-hook.js");                              // enrich memory on manual /compact
  registerHook("PreToolUse", "Workflow", "cqr-workflow-guard.js");                 // workflow quota guard

  const sl = setupStatusline(settings);

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  return { hasToken: !!tok, backupName, hooksAdded, statusline: sl };
}

// Add our quota status line. If the user already has one, WRAP it (save the original so our
// wrapper can call it + uninstall can restore it). Idempotent: never wraps twice.
function setupStatusline(settings) {
  const slPath = p.join(INSTALL_DIR, "statusline.json");
  const cur = settings.statusLine;
  const curCmd = (cur && (typeof cur === "string" ? cur : cur.command)) || "";
  if (curCmd.includes("cqr-statusline.js")) return "kept";
  const original = cur ? (typeof cur === "string" ? { type: "command", command: cur } : cur) : null;
  fs.writeFileSync(slPath, JSON.stringify({ original }, null, 2));
  settings.statusLine = { type: "command", command: 'node "' + p.join(INSTALL_DIR, "cqr-statusline.js") + '"' };
  return original ? "wrapped" : "added";
}

(async () => {
  console.log(bold("claude-quota-relay") + dim("  —  installer"));
  info(CONFIG_DIR + "  (port " + PORT + ")");

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  for (const f of COPY_FILES) fs.copyFileSync(p.join(SRC_DIR, f), p.join(INSTALL_DIR, f));

  const tokensPath = p.join(INSTALL_DIR, "tokens.json");
  let conf, tokensLine;
  if (fs.existsSync(tokensPath)) {
    conf = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    // keep the user's custom port unless --port was explicitly passed
    if (PORT_EXPLICIT) conf.port = Number(PORT); else if (conf.port) PORT = String(conf.port); else conf.port = Number(PORT);
    // backfill any missing compaction/guard defaults (older configs gain new keys)
    conf.compaction = Object.assign({}, COMPACTION_DEFAULT, conf.compaction || {});
    conf.workflowGuard = Object.assign({}, WORKFLOW_GUARD_DEFAULT, conf.workflowGuard || {});
    fs.writeFileSync(tokensPath, JSON.stringify(conf, null, 2));
    tokensLine = (conf.tokens || []).length + " account(s), kept";
  } else {
    conf = await collectTokens();
    conf.compaction = Object.assign({}, COMPACTION_DEFAULT, conf.compaction || {});
    conf.workflowGuard = Object.assign({}, WORKFLOW_GUARD_DEFAULT, conf.workflowGuard || {});
    fs.writeFileSync(tokensPath, JSON.stringify(conf, null, 2));
    tokensLine = (conf.tokens || []).length + " account(s), just set up";
  }

  const res = patchSettings(conf);
  // CQR_SKIP_PATH_REGISTER=1 is a test seam: writes the wrapper scripts but never touches the
  // real registry / shell rc file (used by the automated test suite; never set this yourself).
  const alias = setupPath.ensureAlias(INSTALL_DIR, process.env.CQR_SKIP_PATH_REGISTER ? { skipRegister: true } : undefined);

  section("Setup");
  ok("proxy files copied (" + COPY_FILES.length + ")");
  ok("accounts: " + tokensLine);
  if (res.backupName) info("settings.json backed up -> " + res.backupName);
  ok("Claude Code wired up: routing, timeouts" + (res.hooksAdded ? ", hooks" : "") + " (all done automatically)");
  ok("status line " + (res.statusline === "kept" ? "already set up" : res.statusline === "wrapped" ? "added (kept your existing one)" : "added"));
  ok("`cqr` command " + (alias.skipped ? "wrapper scripts ready" : alias.changed ? "added to your PATH" : "already on your PATH"));

  section("Next steps");
  if (!res.hasToken) {
    console.log("  1. " + bold("Restart Claude Code") + ", then run: " + bold("cqr login <name>") + " for each account.");
  } else {
    console.log("  1. " + bold("Restart Claude Code") + " (it needs to pick up the new settings).");
  }
  if (alias.changed) console.log("  2. Open a " + bold("new terminal") + " and run: " + bold("cqr status"));
  else console.log("  2. Run: " + bold("cqr status"));
  console.log("");
  info("auto-compaction (saves tokens on the 2nd account) is off by default — try: cqr compact dry-run");
})().catch((e) => { console.error("\nInstall failed: " + e.message); process.exit(1); });
