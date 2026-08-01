#!/usr/bin/env node
"use strict";
/* claude-quota-relay — status line (compact, colored).
 *
 *   ↻ 14h10 ① │ ① 5h/40% ██░░░ █░░░░ 7J/12% │ ② 5h/73% ████░ ███░░ 7J/55% │ crédits ○
 *
 * - ↻ = REAL CLOCK TIME of the next reset (absolue : une barre d'etat ne se rafraichit pas
 *   toute seule), suivie du/des compte(s) qui repartent a ce moment-la.
 * - Puis UN BLOC PAR COMPTE : son 5h a gauche, son 7j a droite. Une barre cumulee sur toute la
 *   flotte etait illisible des 3 comptes (impossible de savoir qui a consomme quoi).
 * - Couleur du NUMERO = etat du compte : vert = en service et il reste du quota / jaune = en
 *   reserve, quota dispo / orange = 5h epuise mais la semaine tient / rouge = plus rien.
 * - Couleur des barres et des % : vert <60% consomme, jaune 60-85%, rouge >85%.
 * NO_COLOR desactive toutes les couleurs (les chiffres restent lisibles).
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
  const BW = 5; // largeur d'une barre (une par periode, par compte)
  // "Reste-t-il du quota ?" = exactement les seuils de ROUTAGE du proxy, pas des seuils
  // d'affichage inventes : un compte que le proxy refuse d'utiliser ne doit pas paraitre dispo.
  const sw5 = conf.switchAtPercent == null ? 98 : Number(conf.switchAtPercent);
  const block7 = conf.sevenDayBlockPercent == null ? 99 : Number(conf.sevenDayBlockPercent);
  const left5 = (a) => a.h5 == null || a.h5 < sw5;
  const left7 = (a) => a.d7 == null || a.d7 < block7;
  const actIdx = state.activeIndex || 0;
  // Couleur du numero de compte : l'etat se lit sans decoder les chiffres.
  // VERT = en service, quota dispo / JAUNE = en reserve, quota dispo /
  // ORANGE = 5h epuise mais la semaine tient (il revient a son reset 5h) / ROUGE = plus rien.
  const tagCol = (a) => (left5(a) && left7(a) ? (a.idx === actIdx ? 32 : 33) : left7(a) ? "38;5;208" : 31);
  const num = (a) => col(tagCol(a), tag(a.idx));
  // Heure de reset affichee : elle ne doit porter QUE sur les comptes qui ont encore du quota
  // HEBDOMADAIRE. Un compte a 100% de 7j ne redevient pas utilisable a son reset 5h -> afficher
  // son heure donne un faux espoir (c'est le bug signale). Si AUCUN compte n'a de quota hebdo,
  // la vraie echeance est le reset 7j le plus proche : on l'affiche, marque "7j" et date (jour +
  // heure), parce qu'il peut tomber dans plusieurs jours.
  const soonest = (arr, key) => { const v = arr.map((a) => a[key]).filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[0] : null; };
  const withWeekly = accts.filter(left7);
  let nextReset = null, weeklyWait = false;
  if (withWeekly.length) nextReset = soonest(withWeekly, "reset5");
  else { nextReset = soonest(accts, "reset7"); weeklyWait = nextReset != null; }
  // Plusieurs comptes peuvent repartir a la meme heure -> on les liste tous (↻ 14h10 ① ②).
  // Comparaison sur l'heure AFFICHEE : deux resets a la meme minute sont le meme evenement pour
  // l'utilisateur, meme si les millisecondes different.
  const fmtReset = weeklyWait ? clockDay : clock;
  const key = weeklyWait ? "reset7" : "reset5";
  const resetOn = nextReset == null ? [] : (weeklyWait ? accts : withWeekly).filter((a) => a[key] != null && fmtReset(a[key]) === fmtReset(nextReset));
  const sep = col(90, " │ ");
  const seg7 = accts.map((a) => num(a)
    + col(90, " 5h/") + col(hcol(a.h5), (a.h5 == null ? "?" : a.h5) + "%") + " " + bar(a.h5, BW)
    + " " + bar(a.d7, BW) + col(90, " 7J/") + col(hcol(a.d7), (a.d7 == null ? "?" : a.d7) + "%")).join(sep);
  // Pastille "crédits d'usage supplémentaire" : dit d'un coup d'oeil si le travail EN COURS est
  // facturé aux crédits. VERT = oui, le compte actif est servi sur les crédits ; ROUGE = non, on
  // consomme le forfait normal. Le montant, lui, n'est pas affichable : Anthropic refuse de le
  // donner a nos cles (403, scope user:profile) -- voir lib.creditsRemaining. Affichee seulement
  // si les credits sont autorises (cqr credits on), sinon aucun bruit visuel.
  const ovConf = conf.overage || {};
  let crSeg = "";
  if (ovConf.use) {
    const act = accts.find((a) => a.idx === (state.activeIndex || 0)) || accts[0];
    const ov = act && act.ov;
    const on = !!(ov && (ov.onCredits || ov.inUse));
    // "disponibles mais pas encore utilises" merite son propre etat : sinon un compte qui a de
    // quoi tenir et un compte a sec affichent le meme rond rouge.
    const ready = !on && lib.overageUsable(ov, ovConf.maxPercent == null ? 100 : Number(ovConf.maxPercent));
    // PLEINE (vert) = en cours / DEMI (jaune) = dispo, pas utilises / CREUSE (rouge) = plus rien.
    // La forme porte l'info meme sans couleur (NO_COLOR).
    crSeg = sep + col(on ? 32 : ready ? 33 : 31, "crédits " + (on ? "●" : ready ? "◐" : "○"));
  }
  ours = col(90, "↻" + (weeklyWait ? "7j" : "")) + " " + fmtReset(nextReset)
    + (resetOn.length ? " " + resetOn.map(num).join(" ") : "") + sep + seg7 + crSeg;
}

const line = prefix ? (ours ? prefix + " │ " + ours : prefix) : ours;
process.stdout.write(line);
