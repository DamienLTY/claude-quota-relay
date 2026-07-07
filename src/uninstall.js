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
const setupPath = require("./setup-path.js");

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const CONFIG_DIR = arg("--config-dir", process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), ".claude"));
const PURGE = process.argv.includes("--purge");
const INSTALL_DIR = p.join(CONFIG_DIR, "claude-quota-relay");
const SETTINGS = p.join(CONFIG_DIR, "settings.json");

const OUR_ENV = ["ANTHROPIC_BASE_URL", "API_TIMEOUT_MS", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS", "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS"];

function ok(s) { console.log("  ✓ " + s); }

// Stop the proxy if running.
try { cp.execFileSync(process.execPath, [p.join(INSTALL_DIR, "cli.js"), "stop"], { stdio: "ignore" }); ok("proxy arrêté"); } catch (e) {}

let s = null;
if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
  fs.writeFileSync(SETTINGS + ".bak-" + Date.now(), raw);
  try { s = JSON.parse(raw); } catch (e) { console.error("  ! settings.json n'est pas un JSON valide — laissé tel quel (sauvegarde conservée)."); }
}
if (s) {
  if (s.env) {
    for (const k of OUR_ENV) delete s.env[k];
    // Note: we intentionally KEEP ANTHROPIC_AUTH_TOKEN (removing it could log you out of the CLI).
  }
  // Remove all our hooks (proxy autostart + memory hook) from every event they touch.
  if (s.hooks && typeof s.hooks === "object") {
    for (const event of Object.keys(s.hooks)) {
      if (!Array.isArray(s.hooks[event])) continue;
      s.hooks[event] = s.hooks[event].filter((g) => { const j = JSON.stringify(g); return !j.includes("ensure-proxy.js") && !j.includes("memory-hook.js") && !j.includes("cqr-workflow-guard.js"); });
      if (!s.hooks[event].length) delete s.hooks[event];
    }
  }
  // restore the user's original status line if we wrapped it
  try {
    const curCmd = (s.statusLine && (typeof s.statusLine === "string" ? s.statusLine : s.statusLine.command)) || "";
    if (curCmd.includes("cqr-statusline.js")) {
      let orig = null; try { orig = JSON.parse(fs.readFileSync(p.join(INSTALL_DIR, "statusline.json"), "utf8")).original; } catch (e) {}
      if (orig) s.statusLine = orig; else delete s.statusLine;
      ok("votre statusline d'origine a été restaurée");
    }
  } catch (e) {}
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  ok("variables d'env + hooks (autostart/mémoire/garde-fou) retirés de settings.json (sauvegarde conservée)");
}

if (PURGE) {
  try { setupPath.removeAlias(INSTALL_DIR, process.env.CQR_SKIP_PATH_REGISTER ? { skipRegister: true } : undefined); ok("`cqr` retiré du PATH"); } catch (e) {}
  try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); ok(INSTALL_DIR + " supprimé (tokens.json inclus)"); } catch (e) { console.error("  ! impossible de supprimer " + INSTALL_DIR + " : " + e.message); }
} else {
  console.log("\nDossier d'installation conservé : " + INSTALL_DIR + " (tokens.json préservé). Utilisez --purge pour le supprimer.");
}
console.log("\nTerminé. Redémarrez Claude Code pour qu'il arrête d'utiliser le proxy. Pour rappel : ANTHROPIC_BASE_URL a été retiré, Claude Code repasse donc en connexion directe.");
