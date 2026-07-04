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
  keepToolUses: 10, triggerTokens: 2000, compactBeforeResume: true,
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

function log(...a) { console.log(...a); }
function ok(s) { log("  ✓ " + s); }

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
    log("\nNon-interactive: writing tokens.json with placeholders.");
    log("Fill them in later with:  cqr login <name>   (guided) or  cqr set <name> <token>.");
    return example;
  }
  log("\n=== Accounts setup ===");
  log("You can rotate as many Claude accounts as you like (2, 3, 5...). For each one you'll log in");
  log("through your browser; the token is captured automatically. You DON'T need to copy-paste it.\n");
  let n = parseInt(await prompt1("How many accounts do you want to rotate? [2] "), 10);
  if (!Number.isFinite(n) || n < 1) n = 2;

  const tokens = [];
  for (let i = 0; i < n; i++) {
    log("\n--- Account " + (i + 1) + " / " + n + " ---");
    if (i > 0) {
      await prompt1("  IMPORTANT: log OUT of the previous account in your browser first, then press Enter to continue... ");
    }
    const name = (await prompt1(`  Name for account #${i + 1} [account-${i + 1}]: `)) || `account-${i + 1}`;
    const tok = await lib.captureSetupToken(); // runs `claude setup-token`, captures the token (paste fallback)
    if (tok) { log("  ✓ captured token for '" + name + "' (" + lib.mask(tok) + ")"); tokens.push({ name, token: tok, enabled: true }); }
    else { log("  ! skipped '" + name + "' (no token) — add it later with `cqr login " + name + "`."); tokens.push({ name, token: "PASTE_TOKEN_FROM_claude_setup-token", enabled: true }); }
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
  if (fs.existsSync(SETTINGS)) {
    const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
    try { settings = JSON.parse(raw); } catch (e) { throw new Error("settings.json is not valid JSON — fix it or move it aside, then re-run.\n  " + e.message); }
    const bak = SETTINGS + ".bak-" + Date.now();
    fs.writeFileSync(bak, raw);
    ok("backed up settings.json -> " + p.basename(bak));
  }
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + PORT;
  for (const [k, v] of Object.entries(TIMEOUTS)) settings.env[k] = v;
  const tok = firstRealToken(conf);
  if (tok) settings.env.ANTHROPIC_AUTH_TOKEN = tok;

  settings.hooks = settings.hooks || {};
  // Register a command hook once (keyed by the script filename in its command).
  function registerHook(event, matcher, script, label) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (JSON.stringify(settings.hooks[event]).includes(script)) { ok(label + " already present"); return; }
    const entry = { hooks: [{ type: "command", command: 'node "' + p.join(INSTALL_DIR, script) + '"' }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
    ok("added " + label);
  }
  // Proxy autostart.
  registerHook("SessionStart", "startup|resume|clear", "ensure-proxy.js", "SessionStart autostart hook");
  // Memory hook: inject the per-project memory + refresh it on switch / on manual /compact.
  registerHook("SessionStart", "startup|resume|clear", "memory-hook.js", "SessionStart memory hook");
  registerHook("UserPromptSubmit", null, "memory-hook.js", "UserPromptSubmit memory hook");
  registerHook("PreCompact", null, "memory-hook.js", "PreCompact memory hook");
  // Workflow quota guard (PreToolUse on the Workflow tool).
  registerHook("PreToolUse", "Workflow", "cqr-workflow-guard.js", "Workflow quota guard hook");

  setupStatusline(settings);

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  return !!tok;
}

// Add our quota status line. If the user already has one, WRAP it (save the original so our
// wrapper can call it + uninstall can restore it). Idempotent: never wraps twice.
function setupStatusline(settings) {
  const slPath = p.join(INSTALL_DIR, "statusline.json");
  const cur = settings.statusLine;
  const curCmd = (cur && (typeof cur === "string" ? cur : cur.command)) || "";
  if (curCmd.includes("cqr-statusline.js")) { ok("statusline already wrapped (kept)"); return; }
  const original = cur ? (typeof cur === "string" ? { type: "command", command: cur } : cur) : null;
  fs.writeFileSync(slPath, JSON.stringify({ original }, null, 2));
  settings.statusLine = { type: "command", command: 'node "' + p.join(INSTALL_DIR, "cqr-statusline.js") + '"' };
  ok(original ? "wrapped your existing statusline (kept + appended quota)" : "added quota statusline");
}

(async () => {
  log("claude-quota-relay installer");
  log("  config dir : " + CONFIG_DIR);
  log("  install dir: " + INSTALL_DIR);
  log("  port       : " + PORT);

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  for (const f of COPY_FILES) fs.copyFileSync(p.join(SRC_DIR, f), p.join(INSTALL_DIR, f));
  ok("copied proxy files");

  const tokensPath = p.join(INSTALL_DIR, "tokens.json");
  let conf;
  if (fs.existsSync(tokensPath)) {
    conf = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    // keep the user's custom port unless --port was explicitly passed
    if (PORT_EXPLICIT) conf.port = Number(PORT); else if (conf.port) PORT = String(conf.port); else conf.port = Number(PORT);
    // backfill any missing compaction/guard defaults (older configs gain new keys)
    conf.compaction = Object.assign({}, COMPACTION_DEFAULT, conf.compaction || {});
    conf.workflowGuard = Object.assign({}, WORKFLOW_GUARD_DEFAULT, conf.workflowGuard || {});
    fs.writeFileSync(tokensPath, JSON.stringify(conf, null, 2));
    ok("kept existing tokens.json (" + (conf.tokens || []).length + " tokens, port " + conf.port + ")");
  } else {
    conf = await collectTokens();
    conf.compaction = Object.assign({}, COMPACTION_DEFAULT, conf.compaction || {});
    conf.workflowGuard = Object.assign({}, WORKFLOW_GUARD_DEFAULT, conf.workflowGuard || {});
    fs.writeFileSync(tokensPath, JSON.stringify(conf, null, 2));
    ok("wrote tokens.json");
  }

  const haveToken = patchSettings(conf);

  log("\nDone.");
  log("\nNext steps:");
  if (!haveToken) {
    log("  1. Get a token per account:  claude setup-token   (switch account between each run)");
    log("  2. Put them in: " + tokensPath + "   (or:  node \"" + p.join(INSTALL_DIR, "cli.js") + "\" set <name> <token>)");
    log("  3. Re-run this installer (it will sync the first token into settings.json).");
    log("  4. Restart Claude Code.");
  } else {
    log("  1. Restart Claude Code (env vars are read at startup).");
    log("  2. Check status:  node \"" + p.join(INSTALL_DIR, "cli.js") + "\" status");
  }
  log("\nTip: add an alias so `cqr` works from anywhere, e.g.:");
  log("  alias cqr='node \"" + p.join(INSTALL_DIR, "cli.js") + "\"'");
  log("\nAuto-compaction (optional, saves tokens on the 2nd account) ships OFF in dry-run.");
  log("  cqr compact dry-run   # watch what it WOULD compact (proxy.log), no request change");
  log("  cqr compact on        # enable it, then: cqr restart");
})().catch((e) => { console.error("\nInstall failed: " + e.message); process.exit(1); });
