#!/usr/bin/env node
"use strict";
/* claude-quota-relay — status line (compact, colored).
 *
 *   5h ██████░░░░ 58% ↻15h04  7j ①███░92% ②████99%
 *
 * - 5h = ONE cumulative bar across all accounts: each account owns 1/N of the bar and
 *   fills it with its own 5h usage (2 keys -> 50%/50%, 3 keys -> 33% each...). So the whole
 *   bar reading = total fleet 5h consumed. After it: the mean %, then the REAL CLOCK TIME of
 *   the next account to reset (absolute, because a status line does not refresh on its own).
 * - 7j = one small bar per account (colored) with its %.
 * Colors: green <60% used, yellow 60-85%, red >85%. Set NO_COLOR to disable.
 *
 * If the user already had a status line, its output is kept as a prefix (see statusline.json).
 */
const fs = require("fs");
const p = require("path");
const cp = require("child_process");
const lib = require("./lib.js");

const DIR = process.env.CQR_DIR || __dirname;
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch (e) { return d; } }

const USE_COLOR = !process.env.NO_COLOR;
const col = (code, s) => (USE_COLOR ? "\x1b[" + code + "m" + s + "\x1b[0m" : s);
const hcol = (pct) => (pct == null ? 90 : pct < 60 ? 32 : pct < 85 ? 33 : 31); // green / yellow / red
function bar(pct, w) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const f = Math.round((v / 100) * w);
  return col(hcol(pct), "█".repeat(f)) + col(90, "░".repeat(w - f));
}
function clock(ms) {
  if (ms == null) return "--h--";
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + "h" + String(d.getMinutes()).padStart(2, "0");
}
// Un reset 7j peut tomber dans plusieurs JOURS : l'heure seule serait ambigue -> jour + heure.
const DAYS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
function clockDay(ms) {
  if (ms == null) return "--h--";
  return DAYS[new Date(ms).getDay()] + " " + clock(ms);
}
const CIRC = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
const tag = (i) => CIRC[i] || "(" + (i + 1) + ")";

let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch (e) {}

const conf = readJson(p.join(DIR, "tokens.json"), {});
const state = readJson(p.join(DIR, "state.json"), {});
const sl = readJson(p.join(DIR, "statusline.json"), { original: null });

// Keep the user's original status line as a prefix (feed it the same stdin).
let prefix = "";
if (sl.original && sl.original.command) {
  try { prefix = String(cp.execSync(sl.original.command, { input: stdin, encoding: "utf8", timeout: 4000, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })).split(/\r?\n/)[0].trim(); } catch (e) {}
}

const accts = lib.accounts(conf, state).filter((a) => a.enabled);
let ours = "";
if (accts.length) {
  const W5 = 10, segW = Math.max(2, Math.round(W5 / accts.length));
  const bar5 = accts.map((a) => bar(a.h5, segW)).join("");                    // cumulative 5h bar
  const h5s = accts.map((a) => a.h5).filter((v) => v != null);
  const mean = h5s.length ? Math.round(h5s.reduce((x, y) => x + y, 0) / h5s.length) : null;
  // Heure de reset affichee : elle ne doit porter QUE sur les comptes qui ont encore du quota
  // HEBDOMADAIRE. Un compte a 100% de 7j ne redevient pas utilisable a son reset 5h -> afficher
  // son heure donne un faux espoir (c'est le bug signale). Si AUCUN compte n'a de quota hebdo,
  // la vraie echeance est le reset 7j le plus proche : on l'affiche, marque "7j" et date (jour +
  // heure), parce qu'il peut tomber dans plusieurs jours.
  const block7 = conf.sevenDayBlockPercent == null ? 99 : Number(conf.sevenDayBlockPercent);
  const soonest = (arr, key) => { const v = arr.map((a) => a[key]).filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[0] : null; };
  const withWeekly = accts.filter((a) => a.d7 == null || a.d7 < block7);
  let nextReset = null, weeklyWait = false;
  if (withWeekly.length) nextReset = soonest(withWeekly, "reset5");
  else { nextReset = soonest(accts, "reset7"); weeklyWait = nextReset != null; }
  const sep = col(90, " │ ");
  const seg7 = accts.map((a) => tag(a.idx) + " " + bar(a.d7, 4) + " " + col(hcol(a.d7), (a.d7 == null ? "?" : a.d7) + "%")).join(sep);
  // Credits d'usage supplementaire : affiches seulement s'ils sont AUTORISES (cqr credits on) et
  // connus -- sinon aucun bruit visuel pour ceux qui ne s'en servent pas.
  const ovMax = (conf.overage || {}).maxPercent;
  const ovU = conf.overage && conf.overage.use
    ? accts.map((a) => (lib.overageUsable(a.ov, ovMax) ? (a.ov.u == null ? 0 : a.ov.u) : null)).filter((v) => v != null).sort((x, y) => y - x)[0]
    : undefined;
  const crSeg = ovU == null ? "" : sep + col(hcol(ovU), "cr " + ovU + "%");
  ours = "5h " + bar5 + " " + col(hcol(mean), (mean == null ? "?" : mean) + "%") + " " + col(90, "↻" + (weeklyWait ? "7j" : "")) + " "
    + (weeklyWait ? clockDay(nextReset) : clock(nextReset)) + sep + "7j " + seg7 + crSeg;
}

const line = prefix ? (ours ? prefix + " │ " + ours : prefix) : ours;
process.stdout.write(line);
