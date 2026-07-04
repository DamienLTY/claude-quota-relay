#!/usr/bin/env node
"use strict";
/* claude-quota-relay — status line.
 *
 * Renders one condensed segment per configured account:
 *   API-1 | 5h X% - Reset à XhYmin | 7j X% - Reset à XhYmin || API-2 | ...
 *
 * If the user already had a status line, we WRAP it: their original command is saved in
 * statusline.json at install time; this script runs it (feeding it the same stdin) and
 * prepends its output, so nothing is lost:  <their line> || API-1 | ... || API-2 | ...
 *
 * Because Claude Code's settings.json points at THIS file, updating the package updates the
 * status line automatically, and re-installing never adds a second copy.
 */
const fs = require("fs");
const p = require("path");
const cp = require("child_process");
const lib = require("./lib.js");

const DIR = process.env.CQR_DIR || __dirname;
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch (e) { return d; } }

let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch (e) {}

const conf = readJson(p.join(DIR, "tokens.json"), {});
const state = readJson(p.join(DIR, "state.json"), {});
const sl = readJson(p.join(DIR, "statusline.json"), { original: null });

// Run the user's original status line (if any), feeding it the same stdin, and take its first line.
let prefix = "";
if (sl.original && sl.original.command) {
  try {
    const out = cp.execSync(sl.original.command, { input: stdin, encoding: "utf8", timeout: 4000, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    prefix = String(out).split(/\r?\n/)[0].trim();
  } catch (e) { /* if their status line fails, we still show ours */ }
}

const segs = lib.accounts(conf, state).map((a) =>
  "API-" + (a.idx + 1) + " | 5h " + (a.h5 == null ? "?" : a.h5) + "% - Reset à " + lib.fmtDur(a.reset5) +
  " | 7j " + (a.d7 == null ? "?" : a.d7) + "% - Reset à " + lib.fmtDur(a.reset7));
const ours = segs.join(" || ");

const line = prefix ? (ours ? prefix + " || " + ours : prefix) : ours;
process.stdout.write(line);
