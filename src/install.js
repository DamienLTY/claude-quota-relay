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

// Default auto-compaction config: ON (native context-editing, 0 token). It only acts ON a
// switch/resume, so normal single-account use is untouched. dynamicThreshold is OPT-IN (the
// static per-model thresholds below are the switch points; the dynamic one is too aggressive
// once compaction shrinks the request anyway).
const COMPACTION_DEFAULT = {
  enabled: true, dryRun: false, mode: "native", dynamicThreshold: false,
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
    info("mode non-interactif : tokens.json créé avec des emplacements vides");
    info("à remplir plus tard avec : cqr login <nom> (navigateur) ou cqr set <nom> <token> (coller)");
    info("ou en éditant directement " + p.join(INSTALL_DIR, "tokens.json") + ", puis : cqr sync-env");
    return example;
  }
  section("Comptes");
  console.log("  Vous pouvez faire tourner autant de comptes Claude que vous voulez (2, 3, 5...). Pour");
  console.log("  chacun, vous vous connecterez via votre navigateur (token récupéré automatiquement) ou");
  console.log("  collerez un token que vous avez déjà — au choix, compte par compte.\n");
  let n = parseInt(await prompt1("  Combien de comptes voulez-vous faire tourner ? [2] "), 10);
  if (!Number.isFinite(n) || n < 1) n = 2;

  const tokens = [];
  for (let i = 0; i < n; i++) {
    console.log("\n  " + bold("Compte " + (i + 1) + "/" + n));
    const name = (await prompt1(`  Nom [account-${i + 1}]: `)) || `account-${i + 1}`;
    const how = (await prompt1("  Connexion automatique par navigateur, ou coller un token vous-même ? [auto/paste] [auto]: ")).toLowerCase();
    let tok;
    if (how.startsWith("p")) {
      tok = await lib.pasteTokenManually("  Collez le token pour '" + name + "' (obtenu via : claude setup-token) — sk-ant-oat01-...: ");
    } else {
      if (i > 0) await prompt1("  Déconnectez-vous du compte précédent dans votre navigateur, puis appuyez sur Entrée pour continuer... ");
      tok = await lib.captureSetupToken(); // runs `claude setup-token`, captures the token (paste fallback)
    }
    if (tok) { ok("token récupéré pour '" + name + "' (" + lib.mask(tok) + ")"); tokens.push({ name, token: tok, enabled: true }); }
    else { warn("'" + name + "' ignoré — ajoutez-le plus tard avec : cqr login " + name + " (ou cqr set " + name + " <token>)"); tokens.push({ name, token: "PASTE_TOKEN_FROM_claude_setup-token", enabled: true }); }
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
    try { settings = JSON.parse(raw); } catch (e) { throw new Error("settings.json n'est pas un JSON valide — corrigez-le ou déplacez-le, puis relancez.\n  " + e.message); }
    const bak = SETTINGS + ".bak-" + Date.now();
    fs.writeFileSync(bak, raw);
    backupName = p.basename(bak);
  }
  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + PORT;
  for (const [k, v] of Object.entries(TIMEOUTS)) settings.env[k] = v;
  const tok = firstRealToken(conf);
  if (tok) settings.env.ANTHROPIC_AUTH_TOKEN = tok;
  // Reseau d'entreprise : si cette variable est deja presente (ex. api.anthropic.com bloque,
  // l'utilisateur passe par son propre relais), on ne la touche pas -- le proxy la lira lui-meme
  // au demarrage (voir resolveUpstream dans proxy.js/lib.js). On informe juste que c'est detecte.
  const targetApiUrl = settings.env.ANTHROPIC_TARGET_API_URL || null;

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
  return { hasToken: !!tok, backupName, hooksAdded, statusline: sl, targetApiUrl };
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
  console.log(bold("claude-quota-relay") + dim("  —  installeur"));
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
    tokensLine = (conf.tokens || []).length + " compte(s), conservés";
  } else {
    conf = await collectTokens();
    conf.compaction = Object.assign({}, COMPACTION_DEFAULT, conf.compaction || {});
    conf.workflowGuard = Object.assign({}, WORKFLOW_GUARD_DEFAULT, conf.workflowGuard || {});
    fs.writeFileSync(tokensPath, JSON.stringify(conf, null, 2));
    tokensLine = (conf.tokens || []).length + " compte(s), configurés";
  }

  const res = patchSettings(conf);
  // CQR_SKIP_PATH_REGISTER=1 is a test seam: writes the wrapper scripts but never touches the
  // real registry / shell rc file (used by the automated test suite; never set this yourself).
  const alias = setupPath.ensureAlias(INSTALL_DIR, process.env.CQR_SKIP_PATH_REGISTER ? { skipRegister: true } : undefined);

  section("Installation");
  ok("fichiers du proxy copiés (" + COPY_FILES.length + ")");
  ok("comptes : " + tokensLine);
  if (res.backupName) info("settings.json sauvegardé -> " + res.backupName);
  ok("Claude Code configuré : routage, timeouts" + (res.hooksAdded ? ", hooks" : "") + " (tout automatique)");
  ok("statusline " + (res.statusline === "kept" ? "déjà en place" : res.statusline === "wrapped" ? "ajoutée (la vôtre est conservée)" : "ajoutée"));
  ok("commande `cqr` " + (alias.skipped ? "scripts prêts" : alias.changed ? "ajoutée à votre PATH" : "déjà disponible"));
  if (res.targetApiUrl) ok("réseau d'entreprise détecté (ANTHROPIC_TARGET_API_URL = " + res.targetApiUrl + ") — le proxy passera automatiquement par là");

  section("Prochaines étapes");
  if (!res.hasToken) {
    console.log("  1. " + bold("Redémarrez Claude Code") + ", puis lancez : " + bold("cqr login <nom>") + " pour chaque compte.");
  } else {
    console.log("  1. " + bold("Redémarrez Claude Code") + " (nécessaire pour prendre en compte les nouveaux réglages).");
  }
  if (alias.changed) console.log("  2. Ouvrez un " + bold("nouveau terminal") + " et lancez : " + bold("cqr status"));
  else console.log("  2. Lancez : " + bold("cqr status"));
  console.log("");
  info("l'auto-compaction est ACTIVE par défaut (réduit les tokens lors d'un changement de compte, 0 token). Réglages : cqr compact — pour la couper : cqr compact off");
})().catch((e) => { console.error("\nÉchec de l'installation : " + e.message); process.exit(1); });
