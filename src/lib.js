"use strict";
// Shared helpers for cli.js and install.js (token capture, config, settings sync).
const fs = require("fs");
const os = require("os");
const p = require("path");
const cp = require("child_process");
const readline = require("readline");
const https = require("https");

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

// Ask the user to paste a token directly -- for people who don't want the automated browser
// login (or are on a headless/remote box where a browser can't open). Retries once on an
// obviously-invalid paste. Returns the token string, or null if left blank.
async function pasteTokenManually(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pasted = await ask(rl, promptText || "  Paste the token (sk-ant-oat01-...): ");
  if (pasted && !TOKEN_RE.test(pasted)) {
    pasted = await ask(rl, "  That doesn't look like a sk-ant-oat01-... token. Paste again (or leave blank to skip): ");
  }
  rl.close();
  const m = (pasted || "").match(TOKEN_RE);
  return m ? m[0] : null;
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

// Pick the enabled, non-placeholder token with the lowest 5h utilization (from proxy
// state). Used by the memory hook to run its cheap Haiku summary on the freshest account.
function healthiestToken(conf, state) {
  const cands = (conf.tokens || []).filter((t) => t.enabled && !isPlaceholder(t));
  if (!cands.length) return null;
  const pct = (state && state.pct) || {};
  cands.sort((a, b) => {
    const ha = (pct[a.name] || {}).h5; const hb = (pct[b.name] || {}).h5;
    return (ha == null ? 50 : ha) - (hb == null ? 50 : hb);
  });
  return cands[0];
}

// The compaction Haiku call should spend the OLD account's last sliver of margin (it's
// about to be abandoned anyway) rather than the fresh one's pristine quota. Use
// `preferName` (state.compaction.from) if that account is still enabled and not currently
// marked exhausted/blocked; otherwise fall back to the freshest account (it likely WAS
// exhausted -- the exact scenario a user hit: proxy held the request, then resumed fresh).
function preferredCompactionToken(conf, state, preferName) {
  if (preferName) {
    const t = (conf.tokens || []).find((x) => x.name === preferName);
    const exhausted = state && state.exhausted && state.exhausted[preferName];
    const stillBlocked = exhausted && Date.now() < exhausted;
    if (t && t.enabled && !isPlaceholder(t) && !stillBlocked) return t;
  }
  return healthiestToken(conf, state);
}

// Minimal POST to api.anthropic.com. Resolves {status, json, raw} (never rejects).
function anthropicPost(pathname, token, body, extraHeaders, timeoutMs) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const headers = Object.assign({
      "authorization": "Bearer " + token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": data.length,
    }, extraHeaders || {});
    const req = https.request({ hostname: "api.anthropic.com", port: 443, path: pathname, method: "POST", headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.setTimeout(timeoutMs || 60000, () => { try { req.destroy(new Error("timeout")); } catch (e) {} });
    req.on("error", (e) => resolve({ status: 0, err: e.message }));
    req.write(data); req.end();
  });
}

// One cheap Haiku call. Returns {text, usage} or {err}.
async function haikuSummarize(token, system, user, maxTokens, timeoutMs) {
  const r = await anthropicPost("/v1/messages", token, {
    model: "claude-haiku-4-5", max_tokens: maxTokens || 1200, system,
    messages: [{ role: "user", content: user }],
  }, null, timeoutMs);
  if (r.status !== 200) return { err: (r.status || "0") + " " + String(r.raw || r.err || "").slice(0, 300) };
  return { text: (r.json.content || []).map((b) => b.text || "").join(""), usage: r.json.usage };
}

// Human duration until an epoch-ms reset: "4j09h" / "1h05min" / "45min" / "?" / "0min".
function fmtDur(ms) {
  if (ms == null) return "?";
  const d = ms - Date.now(); if (d <= 0) return "0min";
  const totalMin = Math.round(d / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h >= 24) return Math.floor(h / 24) + "j" + String(h % 24).padStart(2, "0") + "h";
  return h >= 1 ? h + "h" + String(m).padStart(2, "0") + "min" : m + "min";
}

// One row per configured (non-placeholder) account, numbered by its original index, with the
// quota view from proxy state. Used by the statusline, the workflow guard, and `cqr preflight`.
function accounts(conf, state) {
  const pct = (state && state.pct) || {}, r5 = (state && state.reset5h) || {}, r7 = (state && state.reset7d) || {};
  return (conf.tokens || []).map((t, i) => ({
    idx: i, name: t.name, enabled: t.enabled !== false, placeholder: isPlaceholder(t),
    h5: (pct[t.name] || {}).h5, d7: (pct[t.name] || {}).d7, reset5: r5[t.name], reset7: r7[t.name],
  })).filter((x) => !x.placeholder);
}

// Lowest 5h utilization among usable accounts (the "freshest" account), or null if unknown.
function bestHeadroom(conf, state) {
  const vals = accounts(conf, state).filter((a) => a.enabled && a.h5 != null).map((a) => a.h5);
  return vals.length ? Math.min.apply(null, vals) : null;
}

module.exports = { TOKEN_RE, isPlaceholder, mask, configDir, settingsPath, readConf, writeConf, ask, findClaude, captureSetupToken, pasteTokenManually, syncAuthToken, healthiestToken, preferredCompactionToken, anthropicPost, haikuSummarize, fmtDur, accounts, bestHeadroom };
