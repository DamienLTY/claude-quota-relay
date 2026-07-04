#!/usr/bin/env node
"use strict";
/* claude-quota-relay — memory hook (client side).
 *
 * Maintains a persistent per-project memory file `.cqr-memory.md` (task list + notes)
 * and injects it back into Claude Code's context, so a fresh account picked up after a
 * quota switch keeps the project's long-running context without re-reading everything.
 *
 * Wired to three hook events (see install.js):
 *   - SessionStart / UserPromptSubmit : inject the memory file (instant). On
 *     UserPromptSubmit, if the proxy just switched accounts (marker in state.json),
 *     first refresh the memory via ONE cheap Haiku call (bounded), then inject.
 *   - PreCompact : when you run /compact manually, fold a fresh summary into the memory
 *     file (enrichment) — no account switch is forced.
 *
 * Safety: the Haiku refresh is bounded and serialized (a per-project lock stops two
 * sessions from double-summarizing); a failed refresh does NOT consume the switch marker
 * (so it retries); the memory file + archive are auto-added to the project .gitignore so
 * conversation content is never accidentally committed. Always exits 0. The full raw
 * transcript stays in ~/.claude/projects — we only summarize what to re-inject.
 */
const fs = require("fs");
const p = require("path");
const lib = require("./lib.js");

// Install dir (proxy tokens.json/state.json live here). CQR_DIR override = test seam.
const DIR = process.env.CQR_DIR || __dirname;
// Test seam: replace the Haiku call with a canned summary (no network in tests).
const summarize = process.env.CQR_FAKE_SUMMARY !== undefined
  ? async () => ({ text: process.env.CQR_FAKE_SUMMARY })
  : lib.haikuSummarize;

const MASTER_SYSTEM = (maxLines) => "Tu es le gestionnaire de memoire d'un tres long projet pilote par IA. " +
  "Tu recois la MEMOIRE actuelle du projet et la suite recente de la conversation. " +
  "Produis la MEMOIRE mise a jour, EN FRANCAIS, en conservant TOUTES les taches et decisions importantes. " +
  "Structure EXACTE en markdown : '# MEMOIRE PROJET', puis '## Taches faites', '## Taches en cours', '## Taches prevues', '## Decisions & notes'. " +
  "Fusionne sans dupliquer ; deplace les taches terminees vers 'faites'. " +
  "Pas d'introduction ni de conclusion. Reste sous ~" + maxLines + " lignes.";

function readJson(path, def) { try { return JSON.parse(fs.readFileSync(path, "utf8").replace(/^﻿/, "")); } catch (e) { return def; } }
function readStdin() {
  return new Promise((res) => {
    let d = "", done = false; const finish = () => { if (!done) { done = true; res(d); } };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", finish); process.stdin.on("error", finish);
    setTimeout(finish, 2000); // safety: never hang if stdin stays open
  });
}
function withTimeout(promise, ms) { return Promise.race([promise, new Promise((r) => setTimeout(() => r({ err: "timeout" }), ms))]); }
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function lineCount(s) { return (s.match(/\n/g) || []).length + 1; }

// If cwd is a git repo, make sure the memory file + archive are gitignored so the user
// never commits conversation content. Idempotent, best-effort.
function ensureGitignored(cwd) {
  try {
    if (!fs.existsSync(p.join(cwd, ".git"))) return;
    const gi = p.join(cwd, ".gitignore");
    let cur = ""; try { cur = fs.readFileSync(gi, "utf8"); } catch (e) {}
    const have = new Set(cur.split(/\r?\n/).map((l) => l.trim().replace(/\/$/, "")));
    const want = [".cqr-memory.md", ".cqr-archive"];
    const missing = want.filter((w) => !have.has(w));
    if (missing.length) fs.appendFileSync(gi, (cur && !cur.endsWith("\n") ? "\n" : "") + "\n# claude-quota-relay project memory (auto-added)\n" + missing.map((w) => (w === ".cqr-archive" ? w + "/" : w)).join("\n") + "\n");
  } catch (e) {}
}

// Read only the tail of the (possibly huge) transcript jsonl, then a size-bounded, readable
// digest of the recent turns. ponytail: last ~1.5MB is plenty; avoids loading a 100MB file.
function transcriptTail(transcriptPath, maxLines, maxChars) {
  if (!transcriptPath) return "";
  let size; try { size = fs.statSync(transcriptPath).size; } catch (e) { return ""; }
  const CAP = 1_500_000;
  const start = Math.max(0, size - CAP);
  let buf, fd;
  try { fd = fs.openSync(transcriptPath, "r"); const len = size - start; buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start); }
  catch (e) { return ""; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  let lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (start > 0 && lines.length) lines = lines.slice(1); // drop the partial first line
  const out = [];
  for (const ln of lines.slice(-maxLines)) {
    let obj; try { obj = JSON.parse(ln); } catch (e) { continue; }
    const msg = obj.message || (obj.type === "user" || obj.type === "assistant" ? obj : null);
    if (!msg || !msg.role) continue;
    let text;
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) text = msg.content.map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text") return b.text || "";
      if (b.type === "tool_use") return "[appel " + (b.name || "?") + "]";
      if (b.type === "tool_result") { const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content); return "[resultat: " + String(c).slice(0, 100) + "]"; }
      return "";
    }).filter(Boolean).join(" ");
    else text = "";
    if (text.trim()) out.push(msg.role.toUpperCase() + ": " + text.trim());
  }
  let joined = out.join("\n");
  if (joined.length > maxChars) joined = joined.slice(-maxChars);
  return joined;
}

// Rebuild/merge the memory file from (existing memory + recent conversation) via Haiku.
// allowCondense: run the extra size-condensation pass (only off the latency path).
async function updateMemory(cc, cwd, transcriptPath, memFile, archiveDir, markerAt, allowCondense) {
  const conf = readJson(p.join(DIR, "tokens.json"), {});
  const state = readJson(p.join(DIR, "state.json"), {});
  const token = lib.healthiestToken(conf, state);
  if (!token) return { err: "no token" };
  const maxLines = cc.memoryMaxLines || 400;
  const existing = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8") : "";
  const convo = transcriptTail(transcriptPath, 500, 14000);
  if (!convo && !existing) return { err: "nothing to summarize" };
  const user = "MEMOIRE ACTUELLE :\n" + (existing || "(vide)") + "\n\n---\nSUITE RECENTE DE LA CONVERSATION (a integrer) :\n" + (convo || "(rien)");
  const r = await withTimeout(summarize(token.token, MASTER_SYSTEM(maxLines), user, 1600, 11000), 12000);
  if (r.err || !r.text) return { err: r.err || "empty summary" };
  let text = r.text.trim();
  // self-condensation is a second Haiku call -> only off the prompt-blocking path (PreCompact).
  if (allowCondense && lineCount(text) > maxLines * 1.5) {
    const r2 = await withTimeout(summarize(token.token, "Condense ce fichier memoire EN FRANCAIS sous " + maxLines + " lignes, en gardant les 4 sections et TOUTES les taches. Pas d'intro/conclusion.", text, 1600, 11000), 12000);
    if (r2 && r2.text) text = r2.text.trim();
  }
  ensureGitignored(cwd);
  if (existing) { ensureDir(archiveDir); try { fs.writeFileSync(p.join(archiveDir, "memory-" + (markerAt || 0) + ".md"), existing); } catch (e) {} }
  fs.writeFileSync(memFile, text + "\n");
  return { ok: true, lines: lineCount(text) };
}

function emitInject(event, memFile) {
  if (!fs.existsSync(memFile)) return;
  let content; try { content = fs.readFileSync(memFile, "utf8"); } catch (e) { return; }
  if (!content.trim()) return;
  const additionalContext = "Memoire persistante de CE projet (maintenue par claude-quota-relay ; tu peux l'enrichir en ecrivant dans le fichier " + memFile + ") :\n\n" + content;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

(async () => {
  let raw = "";
  try { raw = await readStdin(); } catch (e) {}
  let hook = {}; try { hook = JSON.parse(raw); } catch (e) {}
  const event = hook.hook_event_name || hook.hookEventName || "";
  const cwd = hook.cwd || process.cwd();
  const transcriptPath = hook.transcript_path || hook.transcriptPath || "";

  const conf = readJson(p.join(DIR, "tokens.json"), {});
  const cc = conf.compaction || {};
  if (!(cc.enabled || cc.dryRun)) { process.exit(0); }

  const memFile = p.join(cwd, cc.memoryFile || ".cqr-memory.md");
  const archiveDir = p.join(cwd, cc.archiveDir || ".cqr-archive");
  const lastFile = p.join(archiveDir, ".last");
  const lockFile = p.join(archiveDir, ".lock");

  try {
    if (event === "PreCompact") {
      // /compact manuel : on enrichit la memoire (condensation autorisee), sans switch.
      await updateMemory(cc, cwd, transcriptPath, memFile, archiveDir, 0, true);
      process.exit(0);
    }

    if (event === "UserPromptSubmit") {
      const state = readJson(p.join(DIR, "state.json"), {});
      const marker = state.compaction;
      const last = Number(readJson(lastFile, { at: 0 }).at) || 0;
      if (marker && Number(marker.at) > last) {
        // Claim a per-project lock so two sessions in the same cwd don't double-summarize.
        ensureDir(archiveDir);
        let locked = false;
        try { fs.writeFileSync(lockFile, String(marker.at), { flag: "wx" }); locked = true; }
        catch (e) { try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 90000) { fs.writeFileSync(lockFile, String(marker.at)); locked = true; } } catch (e2) {} } // ponytail: steal a stale (>90s) lock
        if (locked) {
          try {
            const res = await updateMemory(cc, cwd, transcriptPath, memFile, archiveDir, marker.at, false);
            // only consume the marker on success -> a failed (offline/no-token) refresh retries next prompt.
            if (res.ok) fs.writeFileSync(lastFile, JSON.stringify({ at: marker.at }));
          } finally { try { fs.unlinkSync(lockFile); } catch (e) {} }
        }
      }
    }

    // SessionStart + UserPromptSubmit : injecter la memoire courante.
    emitInject(event || "SessionStart", memFile);
  } catch (e) { /* jamais bloquant */ }
  process.exit(0);
})();
