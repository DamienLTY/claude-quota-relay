#!/usr/bin/env node
/*
 * claude-quota-relay — uninstaller.
 * Reverses install.js: stops the proxy, removes our env vars + SessionStart hook from
 * settings.json (backing it up first), and optionally deletes the install dir.
 * Keeps a backup of settings.json. Does NOT touch your other settings.
 *
 * Flags: --config-dir <path>   --purge (also delete the install dir + tokens.json)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const p = require("path");
const cp = require("child_process");

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const CONFIG_DIR = arg("--config-dir", process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), ".claude"));
const PURGE = process.argv.includes("--purge");
const INSTALL_DIR = p.join(CONFIG_DIR, "claude-quota-relay");
const SETTINGS = p.join(CONFIG_DIR, "settings.json");

const OUR_ENV = ["ANTHROPIC_BASE_URL", "API_TIMEOUT_MS", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS", "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS"];

function ok(s) { console.log("  ✓ " + s); }

// Stop the proxy if running.
try { cp.execFileSync(process.execPath, [p.join(INSTALL_DIR, "cli.js"), "stop"], { stdio: "ignore" }); ok("stopped proxy"); } catch (e) {}

if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
  fs.writeFileSync(SETTINGS + ".bak-" + Date.now(), raw);
  const s = JSON.parse(raw);
  if (s.env) {
    for (const k of OUR_ENV) delete s.env[k];
    // Note: we intentionally KEEP ANTHROPIC_AUTH_TOKEN (removing it could log you out of the CLI).
  }
  if (s.hooks && Array.isArray(s.hooks.SessionStart)) {
    s.hooks.SessionStart = s.hooks.SessionStart.filter((g) => !JSON.stringify(g).includes("ensure-proxy.js"));
    if (!s.hooks.SessionStart.length) delete s.hooks.SessionStart;
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  ok("removed env vars + autostart hook from settings.json (backup kept)");
}

if (PURGE) {
  try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); ok("deleted " + INSTALL_DIR + " (including tokens.json)"); } catch (e) { console.error("  ! could not delete " + INSTALL_DIR + ": " + e.message); }
} else {
  console.log("\nInstall dir kept at " + INSTALL_DIR + " (tokens.json preserved). Use --purge to delete it.");
}
console.log("\nDone. Restart Claude Code so it stops using the proxy. Remember: ANTHROPIC_BASE_URL was removed, so Claude Code goes direct again.");
