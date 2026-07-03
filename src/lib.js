"use strict";
// Shared helpers for cli.js and install.js (token capture, config, settings sync).
const fs = require("fs");
const os = require("os");
const p = require("path");
const cp = require("child_process");
const readline = require("readline");

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_\-]{20,}/;

function isPlaceholder(t) { return !t || !t.token || /^(PASTE|REMPLACE|<)/i.test(t.token); }
function mask(tok) { return isPlaceholder({ token: tok }) ? "(vide)" : tok.slice(0, 14) + "..." + tok.slice(-4); }

function configDir() { return process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), ".claude"); }
function settingsPath() { return p.join(configDir(), "settings.json"); }

function readConf(confPath) { return JSON.parse(fs.readFileSync(confPath, "utf8")); }
function writeConf(confPath, c) { fs.writeFileSync(confPath, JSON.stringify(c, null, 2)); }

function ask(rl, q) { return new Promise((res) => rl.question(q, (a) => res(a.trim()))); }

// Find the `claude` executable: PATH first, then common install locations.
function findClaude() {
  const candidates = [];
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const out = cp.execFileSync(which, ["claude"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    candidates.push(...out);
  } catch (e) {}
  candidates.push(
    p.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    p.join(os.homedir(), ".claude", "local", "claude"),
    "/usr/local/bin/claude", "/opt/homebrew/bin/claude"
  );
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  return "claude"; // last resort: rely on PATH at spawn time
}

// Run `claude setup-token` interactively, tee its output so the user sees the browser
// prompts, and capture the printed token. Falls back to asking the user to paste it if
// the token can't be scraped from the output. Returns the token string, or null.
function captureSetupToken(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    // opts.spawnCmd/spawnArgs : couture de test (permet de rejouer un faux setup-token).
    const bin = opts.spawnCmd || findClaude();
    const args = opts.spawnArgs || ["setup-token"];
    console.log("\n  Opening `claude setup-token` — follow the browser login for THIS account...\n");
    let buf = "";
    let child;
    // Env propre : setup-token fait son propre flux OAuth vers Anthropic. Si on laisse
    // ANTHROPIC_BASE_URL (notre proxy) ou un token dans l'env, le proxy peut reecrire/router
    // ses requetes et casser l'echange OAuth. On les retire pour ce sous-process uniquement.
    const childEnv = Object.assign({}, process.env);
    delete childEnv.ANTHROPIC_BASE_URL;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      child = cp.spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"], env: childEnv });
    } catch (e) {
      console.log("  ! Could not launch `claude setup-token` (" + e.message + ").");
      return resolve(null);
    }
    child.stdout.on("data", (d) => { buf += d.toString(); process.stdout.write(d); });
    child.stderr.on("data", (d) => { buf += d.toString(); process.stderr.write(d); });
    child.on("error", () => resolve(null));
    child.on("close", async () => {
      const m = buf.match(TOKEN_RE);
      if (m) return resolve(m[0]);
      // Fallback: ask the user to paste it (the token was shown but not scrapable).
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const pasted = await ask(rl, "\n  Could not auto-detect the token. Paste it here (sk-ant-oat01-...): ");
      rl.close();
      const mm = (pasted || "").match(TOKEN_RE);
      resolve(mm ? mm[0] : null);
    });
  });
}

// Copy the first usable token into settings.json's ANTHROPIC_AUTH_TOKEN so Claude Code has
// a token to start with (the proxy rewrites the Authorization header per request anyway).
function syncAuthToken(conf, sp) {
  sp = sp || settingsPath();
  if (!fs.existsSync(sp)) return false;
  const first = (conf.tokens || []).find((t) => !isPlaceholder(t));
  if (!first) return false;
  const raw = fs.readFileSync(sp, "utf8").replace(/^﻿/, "");
  const s = JSON.parse(raw);
  s.env = s.env || {};
  s.env.ANTHROPIC_AUTH_TOKEN = first.token;
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));
  return true;
}

module.exports = { TOKEN_RE, isPlaceholder, mask, configDir, settingsPath, readConf, writeConf, ask, findClaude, captureSetupToken, syncAuthToken };
