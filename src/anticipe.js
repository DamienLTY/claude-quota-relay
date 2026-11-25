"use strict";

/**
 * Compactage anticipe (DR-980, DR-985) : decision et reecriture de l'usage, fonctions pures.
 *
 * Claude Code decide l'auto-compactage sur l'usage du dernier message assistant (input + cache_creation +
 * cache_read, pris sur la derniere iteration `message` si `usage.iterations` existe). Quand l'agent principal
 * attend des sous-agents de fond et que son contexte approche du seuil, le relais releve cet usage au
 * `message_delta` de fin de tour : Claude Code compacte alors au controle d'avant la requete suivante, avant
 * de relire les rapports. Prouve par l'essai du 23/11/2026 (claude 2.1.330) : le controle passe aussi bien au
 * reveil par notification qu'au message de l'utilisateur ; sans reecrire l'iteration, rien ne se passe.
 *
 * Aucune fonction ne leve d'exception : en cas de doute, le flux passe octet pour octet.
 * Modules natifs seulement.
 */

const { Transform } = require("node:stream");

// Seuil reel de Claude Code = fenetre - min(sortie max, 20 000) - 13 000 (binaire 2.1.330, `rne`/`SY`).
const RESERVE_SORTIE = 20000;
const RESERVE_FIXE = 13000;
const RATIO_DEFAUT = 0.94; // DR-985
// Au-dela de ce tampon sans separateur, ce n'est pas du SSE lisible : on relache tel quel.
const TAMPON_MAX = 4 * 1024 * 1024;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const estObjet = (v) => v !== null && typeof v === "object";

// ----- detection des sous-agents de fond -----
function aplatir(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const out = [];
  for (const b of c) {
    if (typeof b === "string") out.push(b);
    else if (estObjet(b)) out.push(typeof b.text === "string" ? b.text : b.content != null ? aplatir(b.content) : "");
  }
  return out.join("\n");
}

/** Ensemble des agentId de fond lances (ou repris) sans notification de fin posterieure. */
function agentsEnCours(messages) {
  const en = new Set();
  try {
    if (!Array.isArray(messages)) return en;
    for (const m of messages) {
      if (!estObjet(m) || m.role === "assistant") continue;
      const c = m.content;
      const blocs = Array.isArray(c) ? c : [];
      // lancement et reprise : seulement dans un tool_result d'un message utilisateur (un rapport cite parfois ces phrases)
      for (const b of m.role === "user" ? blocs : []) {
        if (!estObjet(b) || b.type !== "tool_result") continue;
        const tx = aplatir(b.content);
        for (const mm of tx.matchAll(/Async agent launched[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/g)) en.add(mm[1]);
        for (const mm of tx.matchAll(/"resumedAgentId"\s*:\s*"([A-Za-z0-9_-]+)"/g)) en.add(mm[1]);
      }
      // fin : partout hors assistant. Claude Code range la notification dans un message de role "system" (constate le 23/11), avec ou sans en-tete [SYSTEM NOTIFICATION]
      const tout = aplatir(c);
      for (const mm of tout.matchAll(/<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/g)) en.delete(mm[1]);
    }
  } catch (e) { /* entree non conforme : on rend ce qui a ete lu, jamais d'exception */ }
  return en;
}

// ----- fenetre, seuil, cible -----
function normaliser(modele) {
  return String(modele == null ? "" : modele).toLowerCase().replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
}
function table(conf, cle) {
  const a = conf && conf.compaction && conf.compaction.anticipe;
  return a && estObjet(a[cle]) ? a[cle] : {};
}
function chercher(modele, conf, cle) {
  const k = normaliser(modele);
  if (!k) return null;
  const t = table(conf, cle);
  for (const nom of Object.keys(t)) if (normaliser(nom) === k && typeof t[nom] === "number" && t[nom] > 0) return t[nom];
  return null;
}
/** Fenetre declaree pour ce modele dans la configuration, ou null. */
function fenetre(modele, conf) { try { return chercher(modele, conf, "fenetres"); } catch (e) { return null; } }
function seuil(f) { return f - RESERVE_SORTIE - RESERVE_FIXE; }
/** Valeur visee : `cibles[modele]` si posee, sinon fenetre - 13 000 (atteint le seuil quelle que soit la reserve de sortie). */
function cible(f, modele, conf) {
  let c = null; try { c = chercher(modele, conf, "cibles"); } catch (e) { c = null; }
  return c != null ? c : f - RESERVE_FIXE;
}
/** Contexte a partir duquel on gonfle : entier, calcule une fois (c'est lui qu'on journalise). */
function declenchement(f, ratio) {
  const r = typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : RATIO_DEFAUT;
  return Math.round(seuil(f) * r);
}

// ----- usage -----
function derniereIteration(usage) {
  if (!estObjet(usage) || !Array.isArray(usage.iterations)) return null;
  for (let i = usage.iterations.length - 1; i >= 0; i--) {
    const it = usage.iterations[i];
    if (estObjet(it) && it.type === "message") return it;
  }
  return null;
}
const entree = (u) => num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
/** Contexte tel que Claude Code le lit : derniere iteration `message` si elle existe, sinon le haut de usage. */
function contexte(usage) {
  if (!estObjet(usage)) return 0;
  return entree(derniereIteration(usage) || usage);
}

// ----- flux SSE -----
function reecrire(d, start, cibleVisee) {
  const u = estObjet(d.usage) ? d.usage : (d.usage = {});
  const pris = (k) => (num(u[k]) > 0 ? u[k] : num(start[k]));
  const inp = pris("input_tokens"), cc = pris("cache_creation_input_tokens");
  u.input_tokens = inp; u.cache_creation_input_tokens = cc;
  u.cache_read_input_tokens = Math.max(0, cibleVisee - inp - cc);
  let its = Array.isArray(u.iterations) ? u.iterations : Array.isArray(start.iterations) ? JSON.parse(JSON.stringify(start.iterations)) : null;
  if (its) {
    u.iterations = its;
    const it = derniereIteration({ iterations: its });
    if (it) {
      it.input_tokens = num(it.input_tokens); it.cache_creation_input_tokens = num(it.cache_creation_input_tokens);
      it.cache_read_input_tokens = Math.max(0, cibleVisee - it.input_tokens - it.cache_creation_input_tokens);
    }
  }
}

/**
 * Transform SSE : tout passe octet pour octet sauf le `message_delta` de fin de tour quand le contexte reel
 * atteint `declenchement(fenetre, ratio)` ; son usage est alors releve pour que l'entree totale atteigne `cible`.
 * surDecision({ gonfle, contexte, declenchement, cible }) est appele une fois par reponse (fin de tour seulement).
 */
function transformeSSE(params) {
  const p = estObjet(params) ? params : {};
  const actif = num(p.fenetre) > 0 && num(p.cible) > 0;
  const decl = actif ? declenchement(p.fenetre, p.ratio) : 0;
  let pending = Buffer.alloc(0), start = null, decide = false;

  function traiter(ev) {
    if (!actif || (!ev.includes("message_start") && !ev.includes("message_delta"))) return null;
    const txt = ev.toString("utf8");
    const lignes = txt.split(/(\r?\n)/); // separateurs gardes : la sortie garde les fins de ligne d'origine
    const i = lignes.findIndex((l) => /^data: ?/.test(l));
    if (i < 0) return null;
    let d; try { d = JSON.parse(lignes[i].replace(/^data: ?/, "")); } catch (e) { return null; }
    if (!estObjet(d)) return null;
    if (d.type === "message_start") { if (estObjet(d.message) && estObjet(d.message.usage)) start = d.message.usage; return null; }
    if (d.type !== "message_delta" || !estObjet(d.delta) || d.delta.stop_reason !== "end_turn" || decide || !start) return null;
    decide = true;
    const fusion = Object.assign({}, start);
    if (estObjet(d.usage)) {
      for (const k of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) if (num(d.usage[k]) > 0) fusion[k] = d.usage[k];
      if (d.usage.iterations != null) fusion.iterations = d.usage.iterations; // `iterations: o.iterations ?? e.iterations`
    }
    const ctx = contexte(fusion);
    const gonfle = ctx >= decl && p.cible > ctx;
    if (typeof p.surDecision === "function") {
      try { p.surDecision({ gonfle, contexte: ctx, declenchement: decl, cible: p.cible }); } catch (e) { /* le journal ne doit jamais casser le flux */ }
    }
    if (!gonfle) return null;
    reecrire(d, start, p.cible);
    lignes[i] = "data: " + JSON.stringify(d);
    return Buffer.from(lignes.join(""), "utf8");
  }

  function suivant() { // premiere frontiere d'evenement : \n\n ou \r\n\r\n
    const a = pending.indexOf("\n\n"), b = pending.indexOf("\r\n\r\n");
    if (a < 0 && b < 0) return null;
    if (b >= 0 && (a < 0 || b < a)) return { fin: b, sep: 4 };
    return { fin: a, sep: 2 };
  }

  return new Transform({
    transform(chunk, enc, cb) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
        let f;
        while ((f = suivant())) {
          const ev = pending.subarray(0, f.fin), sep = pending.subarray(f.fin, f.fin + f.sep);
          let sortie = null;
          try { sortie = traiter(ev); } catch (e) { sortie = null; } // illisible : l'evenement passe tel quel
          this.push(sortie ? Buffer.concat([sortie, sep]) : pending.subarray(0, f.fin + f.sep));
          pending = pending.subarray(f.fin + f.sep);
        }
        if (pending.length > TAMPON_MAX) { this.push(pending); pending = Buffer.alloc(0); }
      } catch (e) { this.push(chunk); }
      cb();
    },
    flush(cb) { if (pending.length) this.push(pending); pending = Buffer.alloc(0); cb(); },
  });
}

module.exports = { agentsEnCours, fenetre, seuil, cible, declenchement, contexte, transformeSSE, RESERVE_SORTIE, RESERVE_FIXE, RATIO_DEFAUT };
