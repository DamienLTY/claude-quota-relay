#!/usr/bin/env node
/*
 * Claude auth failover proxy  (v2 : routage + waiting anti-"continue")
 * ===================================================================
 * Ecoute en local et relaie vers api.anthropic.com en reecrivant le Bearer
 * avec le token choisi. Lit les en-tetes anthropic-ratelimit-unified-* pour :
 *   - preferer un token <switchAtPercent (5h),
 *   - JAMAIS router vers un token >= sevenDayBlockPercent (7j),
 *   - sur 401/429 : marquer le token + rejouer sur un autre,
 *   - si aucun token disponible : RETENIR la requete (hold) jusqu'a ce qu'une
 *     fenetre se reinitialise (le token "qui revient a zero en premier"),
 *     puis forwarder -> Claude croit que le serveur est lent et reprend seul.
 * Aucune dependance externe.
 *
 * Procedures (resumé, detail dans README.md) :
 *   P1 il existe un token frais (<switch, 7j<bloc, non rejeté)        -> route (meilleur)
 *   P2 tous >=switch mais non rejetés, waitAtSoftPercent=null (defaut)-> on utilise la marge jusqu'au rejet
 *   P2'waitAtSoftPercent=N et tous >=N                                -> WAIT reset 5h le plus proche
 *   P3 un/des token(s) rejeté(s), un autre frais éligible            -> route l'autre (rejeu)
 *   P4 tous les éligibles (7j<bloc) rejetés                          -> WAIT reset 5h le plus proche, puis route
 *   P5 cible potentielle a 7j>=bloc                                  -> exclue ; on attend le token éligible
 *   P6 tous les tokens a 7j>=bloc                                    -> WAIT reset 7j le plus proche (plafonné maxWaitMs)
 *   P7 401 (token invalide)                                          -> cooldown court (5min), pas d'attente de plusieurs heures
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const comp = require("./compaction.js");
const lib = require("./lib.js"); // overageUsable : meme regle "credits utilisables" pour le routage et l'affichage

const DIR = __dirname;
const CONF = path.join(DIR, "tokens.json");
const STATE = path.join(DIR, "state.json");
const LOG = path.join(DIR, "proxy.log");
// Upstream cible : api.anthropic.com par defaut. Deux facons de le changer :
//   - CQR_UPSTREAM_HOST/PORT/HTTP : couture de test (mock upstream local), priorite max.
//   - ANTHROPIC_TARGET_API_URL : reglage REEL pour les reseaux d'entreprise ou
//     api.anthropic.com est bloque -- l'utilisateur passe alors par son propre relais
//     (ex. un Cloudflare Worker). Claude Code lui-meme ne lit PAS cette variable (verifie
//     dans le binaire) ; c'est ce proxy qui doit la respecter pour que TOUT (bascule,
//     sondes, statusline) fonctionne derriere ce blocage.
function resolveUpstream() {
  if (process.env.CQR_UPSTREAM_HOST) {
    return { host: process.env.CQR_UPSTREAM_HOST, port: Number(process.env.CQR_UPSTREAM_PORT) || 443, mod: process.env.CQR_UPSTREAM_HTTP ? require("http") : https, pathPrefix: "" };
  }
  const target = process.env.ANTHROPIC_TARGET_API_URL;
  if (target) {
    try {
      const u = new URL(target);
      return { host: u.hostname, port: Number(u.port) || (u.protocol === "http:" ? 80 : 443), mod: u.protocol === "http:" ? require("http") : https, pathPrefix: u.pathname.replace(/\/$/, "") };
    } catch (e) { log("ANTHROPIC_TARGET_API_URL invalide, ignore :", target, e.message); }
  }
  return { host: "api.anthropic.com", port: 443, mod: https, pathPrefix: "" };
}
const _upstream = resolveUpstream();
const UPSTREAM_HOST = _upstream.host;
const UPSTREAM_PORT = _upstream.port;
const UPSTREAM = _upstream.mod;
const UPSTREAM_PATH_PREFIX = _upstream.pathPrefix;
const FIVE_H_MS = 5 * 60 * 60 * 1000;
const AUTH_COOLDOWN_MS = 5 * 60 * 1000; // 401 -> petit cooldown
const TRANSIENT_COOLDOWN_MS = 90 * 1000; // 429 sans aucune info de fenetre -> transitoire, pas un epuisement
// Refus administratif (conditions a accepter sur claude.ai) : seule une action humaine le
// repare, donc une quarantaine LONGUE -- juste assez courte pour re-essayer et re-alerter
// dans la journee si personne n'a rien fait. Voir DR-010.
const TERMS_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Surcharge Anthropic (529) : la pause s'ALLONGE a chaque refus consecutif. Sans ca, on retentait
// toutes les 90 s pendant toute la surcharge -- et la sonde de quota (8 tokens) annulait meme cette
// pause, puisqu'elle passe alors que les vraies requetes sont refusees (releve le 29/07/2026 :
// PROBE OK -> deblocage -> 529 -> pause -> PROBE OK -> ... en boucle toutes les 45 s).
const OVERLOAD_BASE_MS = 90 * 1000;               // 1er 529 : 90 s (inchange)
// Plafond a 5 min : au-dela, la pause depasse la duree de vie d'une requete cliente (Claude Code
// abandonne vers 5 min sur les requetes non-stream) -- attendre plus longtemps ne sert plus a rien.
const OVERLOAD_MAX_MS = 5 * 60 * 1000;            // 90 s, 3 min, puis 5 min
const OVERLOAD_STREAK_RESET_MS = 10 * 60 * 1000;  // 10 min sans 529 = surcharge passee, compteur remis a zero

function ts() { return new Date().toISOString(); }
function now() { return Date.now(); }
function log(...a) {
  const line = `[${ts()}] ${a.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch (e) {}
  try { const st = fs.statSync(LOG); if (st.size > 2_000_000) rotateLog(); } catch (e) {}
}
// Journal de vie (DR-012) : demarrage, sortie, signal, arret brutal, erreur imprevue. Ce sont les
// seules lignes qui permettent de compter les redemarrages, donc la coupe du journal les GARDE
// (les 300 dernieres) au lieu de les jeter avec le reste. Une ligne de vie = une seule ligne.
const VIE_RE = /^\[[^\]]*\] VIE /;
const VIE_ERREUR_RE = /^\[[^\]]*\] VIE erreur /;
function logVie(...a) { log("VIE", ...a); }
// Pile d'erreur sur UNE ligne (survit a la coupe du journal), tronquee : sans ca, une rafale d'erreurs
// repasse aussitot le seuil de coupe et chaque ligne gardee pese plusieurs Ko.
const stackOf = (e) => String((e && e.stack) || e).replace(/\s*\n\s*/g, " | ").slice(0, 1500);
function rotateLog() {
  const txt = fs.readFileSync(LOG, "utf8");
  const cut = txt.indexOf("\n", txt.length - 500_000) + 1; // ne coupe pas une ligne en deux
  const vie = txt.slice(0, cut).split("\n").filter((l) => VIE_RE.test(l));
  // Au-dela de 300, les plus vieilles ERREURS partent d'abord : une rafale d'erreurs ne doit pas chasser
  // les demarrages et les sorties, seuls a permettre de compter les redemarrages.
  let trop = vie.length - 300;
  const gardees = vie.filter((l) => { if (trop > 0 && VIE_ERREUR_RE.test(l)) { trop--; return false; } return true; }).slice(-300);
  fs.writeFileSync(LOG, (gardees.length ? gardees.join("\n") + "\n" : "") + txt.slice(cut));
}

function readConf() {
  const c = JSON.parse(fs.readFileSync(CONF, "utf8"));
  c.tokens = Array.isArray(c.tokens) ? c.tokens : [];
  c.port = c.port || 8787;
  c.switchAtPercent = num(c.switchAtPercent, 98);          // 5h : seuil de preference
  c.sevenDayBlockPercent = num(c.sevenDayBlockPercent, 99); // 7j : on ne route jamais au-dela
  c.waitAtSoftPercent = c.waitAtSoftPercent == null ? null : num(c.waitAtSoftPercent, null); // null=utiliser la marge
  // credits d'usage supplementaire : OFF par defaut (ils peuvent etre payants -> jamais depenses
  // sans accord explicite). `cqr credits on` les autorise, en DERNIER recours seulement.
  c.overage = Object.assign({ use: false, maxPercent: 100 }, c.overage || {});
  c.pollMs = num(c.pollMs, 15000);
  c.maxWaitMs = num(c.maxWaitMs, 6 * 60 * 60 * 1000);       // plafond d'attente d'une requete
  // panne serveur Anthropic (500/502/503/504) : duree pendant laquelle on retente avant de
  // rendre l'erreur au client. 0 = desactive (on relaie l'erreur tout de suite, comportement v1).
  c.serverErrorMaxMs = num(c.serverErrorMaxMs, 15 * 60 * 1000);
  // Anthropic injoignable (aucune reponse HTTP : wifi coupe, VPN/Zscaler qui se reconnecte,
  // certificat intercepte, connexion muette...) : on retente pendant ce delai, compte a partir
  // de la PREMIERE erreur, puis l'erreur remonte au client. Voir DR-011.
  c.networkErrorMaxMs = num(c.networkErrorMaxMs, 60 * 60 * 1000);
  // Reponse en streaming sans le moindre octet d'Anthropic pendant ce delai : connexion tenue
  // pour morte (veille, changement de reseau) et refaite. 0 = desactive. Doit rester SOUS la
  // fenetre de premier octet du client : 120 s (CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, pose par
  // install.js) + 1 s par 32 Ko de corps -- le meme supplement est ajoute plus bas.
  c.upstreamIdleMs = num(c.upstreamIdleMs, 90 * 1000);
  return c;
}
function num(v, d) { const n = Number(v); return isNaN(n) ? d : n; }
function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { return { activeIndex: 0, exhausted: {}, pct: {}, reset5h: {}, reset7d: {} }; } }
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (e) { log("writeState err", e.message); } }
function isPlaceholder(t) { return !t || !t.token || /^(PASTE|REMPLACE|<)/i.test(t.token); }

function parseEpochMs(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!isNaN(n)) return n > 1e12 ? n : n * 1000; // epoch s ou ms
  const d = Date.parse(v);
  return isNaN(d) ? null : d;
}

// ----- selection du token -----
// renvoie {idx} pour router maintenant, ou {wait:true, idx, untilMs, reason}
function pickRoute(conf, state, bodyObj) {
  const t0 = now();
  state.exhausted = state.exhausted || {}; state.reset5h = state.reset5h || {}; state.reset7d = state.reset7d || {}; state.pct = state.pct || {};
  // Si la compaction est active et qu'on connait le modele, on switche au seuil STATIQUE par
  // modele plutot qu'au seuil global fixe -- evite (1) qu'un modele au seuil de compaction >
  // switchAtPercent (ex. haiku 95% > 94%) ne bascule jamais assez tard pour que la compaction
  // se declenche, et (2) qu'un modele risque (fable, seuil 85%) attende trop avant de switcher.
  // Le seuil DYNAMIQUE ne sert PLUS a avancer la bascule (trop agressif -> switchait un gros
  // contexte Opus a ~68%) : il declenche desormais une compaction EN PLACE (meme compte, voir
  // decideCompaction). Ne change RIEN pour les installs sans compaction (comportement inchange).
  const compActive = conf.compaction && (conf.compaction.enabled || conf.compaction.dryRun);
  const SW = (compActive && bodyObj && bodyObj.model) ? comp.modelThreshold(bodyObj.model, conf.compaction.thresholds) : conf.switchAtPercent;
  const BLOCK = conf.sevenDayBlockPercent;
  // Reserve de compaction (plafond non-desactivable) : quand la compaction agit REELLEMENT (enabled ;
  // pas dry-run, qui ne doit rien changer au routage), un compte a >= RESERVE_CEILING% de 5h n'est
  // plus une cible immediate -> on bascule vers un compte plus frais, sinon on ATTEND. Sans ca,
  // waitAtSoftPercent=null ("utiliser la marge jusqu'au rejet 100%") ferait rejeter (429) la requete
  // qui PORTE la compaction -> compaction perdue. On peut abaisser waitAtSoftPercent (plus prudent)
  // mais pas depasser ce plafond. Aucun effet si la compaction est off (comportement inchange).
  let SOFT = conf.waitAtSoftPercent;
  if (conf.compaction && conf.compaction.enabled) SOFT = Math.min(SOFT == null ? 100 : SOFT, comp.COMPACTION_RESERVE_CEILING);

  // override manuel (claude-auth use) : on force ce token, sans regle ni attente
  if (state.forceIndex != null) {
    const ft = conf.tokens[state.forceIndex];
    if (ft && ft.enabled && !isPlaceholder(ft)) return { idx: state.forceIndex, forced: true };
  }

  const items = conf.tokens.map((t, i) => {
    const name = t.name;
    const p = state.pct[name] || {};
    const r5 = state.reset5h[name] || null;
    const r7 = state.reset7d[name] || null;
    // fenetre rolled -> utilisation consideree remise a zero
    let u5 = p.h5 == null ? null : p.h5;
    let u7 = p.d7 == null ? null : p.d7;
    if (r5 && t0 >= r5) u5 = 0;
    if (r7 && t0 >= r7) u7 = 0;
    let exUntil = state.exhausted[name] || 0;
    if (exUntil && t0 >= exUntil) exUntil = 0; // expiré -> dispo
    // wake5h : quand ce token redevient utilisable cote 5h
    const wake5h = exUntil ? exUntil : (r5 && (u5 != null && u5 >= (SOFT != null ? SOFT : 101)) ? r5 : null);
    return { t, i, name, u5, u7, exUntil, r5, r7, wake5h, ok: t.enabled && !isPlaceholder(t) };
  }).filter((x) => x.ok);

  if (!items.length) return { none: true };

  const eligible = items.filter((x) => x.u7 == null || x.u7 < BLOCK); // securite 7j

  // fresh = eligible, non rejeté, et (si SOFT) sous le seuil soft 5h
  let fresh = eligible.filter((x) => !x.exUntil);
  if (SOFT != null) fresh = fresh.filter((x) => x.u5 == null || x.u5 < SOFT);

  if (fresh.length) {
    // hysteresis : garder l'actif s'il est encore "bon" (<switch)
    const act = fresh.find((x) => x.i === (state.activeIndex || 0));
    if (act && (act.u5 == null || act.u5 < SW)) return { idx: act.i };
    fresh.sort((a, b) => (a.u5 == null ? -1 : a.u5) - (b.u5 == null ? -1 : b.u5));
    return { idx: fresh[0].i };
  }

  // --- palier "credits d'usage supplementaire" (avant d'attendre) ---
  // Aucun compte n'a de forfait disponible. Si l'utilisateur a explicitement autorise les credits
  // (conf.overage.use), un compte dont l'API annonce overage-status=allowed peut ENCORE servir :
  // Anthropic facture la requete aux credits au lieu de la refuser. On passe donc par la plutot
  // que d'attendre des heures. Deux points volontaires :
  //   - ce palier n'est JAMAIS prefere a un compte avec du forfait (il est apres le bloc "fresh"),
  //     donc on ne depense jamais de credits tant qu'il reste du quota gratuit ;
  //   - il ignore sevenDayBlockPercent : les credits couvrent aussi la limite HEBDOMADAIRE, c'est
  //     precisement le cas ou attendre couterait plusieurs JOURS. Les comptes en cooldown apres un
  //     VRAI 429 restent exclus (le serveur a refuse pour de bon : credits epuises, plafond...).
  // conf.overage.use absent/false -> ce bloc ne s'execute pas : routage strictement inchange.
  const ovConf = conf.overage || {};
  if (ovConf.use) {
    const ovMax = num(ovConf.maxPercent, 100);
    const credit = items.filter((x) => !x.exUntil && lib.overageUsable((state.overage || {})[x.name], ovMax));
    if (credit.length) {
      // le compte dont les credits sont le moins entames d'abord, puis le moins charge en 5h
      credit.sort((a, b) => {
        const ua = ((state.overage || {})[a.name] || {}).u, ub = ((state.overage || {})[b.name] || {}).u;
        return (ua == null ? 0 : ua) - (ub == null ? 0 : ub) || (a.u5 == null ? 0 : a.u5) - (b.u5 == null ? 0 : b.u5);
      });
      return { idx: credit[0].i, overage: true };
    }
  }

  // il faut attendre : cible = eligible dont la fenetre 5h revient en premier
  if (eligible.length) {
    const cand = eligible.map((x) => ({ i: x.i, until: x.wake5h || x.r5 || (t0 + FIVE_H_MS) }));
    cand.sort((a, b) => a.until - b.until);
    return { wait: true, idx: cand[0].i, untilMs: cand[0].until, reason: "5h" };
  }

  // aucun eligible : tous a 7j>=bloc -> attendre le reset 7j le plus proche
  const cand7 = items.map((x) => ({ i: x.i, until: x.r7 || (t0 + 7 * 24 * 3600 * 1000) }));
  cand7.sort((a, b) => a.until - b.until);
  return { wait: true, idx: cand7[0].i, untilMs: cand7[0].until, reason: "7d", weekly: true };
}

// Enregistre un 529 et renvoie la fin de pause (backoff exponentiel plafonne).
function noteOverload(st, name, t) {
  t = t || now();
  st.overload = st.overload || {};
  const prev = st.overload[name];
  const streak = (prev && (t - (prev.at || 0)) < OVERLOAD_STREAK_RESET_MS) ? (prev.n || 0) + 1 : 1;
  const until = t + Math.min(OVERLOAD_MAX_MS, OVERLOAD_BASE_MS * Math.pow(2, streak - 1));
  st.overload[name] = { n: streak, at: t, until };
  return until;
}
// Surcharge encore en cours ? -> la sonde ne doit PAS lever la pause : elle est minuscule
// (8 tokens) et passe meme quand le serveur refuse les vraies requetes.
function overloadActive(st, name, t) { const o = (st.overload || {})[name]; return !!(o && o.until > (t || now())); }
function clearOverload(st, name) { if (st.overload && st.overload[name]) delete st.overload[name]; }

// ----- sonde de quota quasi gratuite -----
// Requete max_tokens:0 sur haiku : ~8 tokens d'input, 0 output, mais renvoie
// tous les en-tetes anthropic-ratelimit-unified-*. Sert de "half-open" du
// circuit breaker : verifier l'etat REEL d'un token sans lacher une vraie requete.
const PROBE_BODY = JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 0, messages: [{ role: "user", content: "ping" }] });
const PROBE_REFRESH_MS = 2 * 60 * 1000; // pendant une attente de quota : une sonde / 2 min / compte
const lastProbeAt = {};

// http.request LEVE en synchrone quand un en-tete est invalide (jeton abime : ERR_INVALID_CHAR sur
// "authorization"). Appele depuis un minuteur ou un gestionnaire, cela tuait le relais (DR-012) :
// l'appelant recoit l'erreur dans onThrow et la traite comme un echec de CE compte.
function safeRequest(opts, cb, onThrow) {
  try { return UPSTREAM.request(opts, cb); } catch (e) { onThrow(e); return null; }
}

function probeToken(conf, idx, done) {
  const tok = conf.tokens[idx];
  // done() n'agit qu'UNE fois : une sonde lente repondait (en-tetes) puis expirait, et le second
  // appel relancait la requete du client -- une seconde requete amont facturee pour rien.
  let finished = false;
  const finish = (ok) => { if (finished) return; finished = true; if (done) done(ok); };
  if (!tok || isPlaceholder(tok)) { finish(false); return; }
  lastProbeAt[tok.name] = now();
  const req = safeRequest({
    hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: UPSTREAM_PATH_PREFIX + "/v1/messages", method: "POST",
    headers: {
      "authorization": "Bearer " + tok.token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(PROBE_BODY),
    },
  }, (pres) => {
    pres.resume();
    const q = readQuotaHeaders(pres.headers);
    const st = readState();
    applyQuota(st, tok.name, q);
    st.exhausted = st.exhausted || {};
    // forfait epuise MAIS credits disponibles = le compte repond encore (voir readQuotaHeaders)
    const onCredits = q.statuses.indexOf("rejected") >= 0 && q.ovAllowed;
    const allowed = pres.statusCode === 200 && (q.statuses.indexOf("rejected") < 0 || onCredits);
    if (allowed) {
      // le compte repond de nouveau : le refus administratif a donc ete leve (conditions
      // acceptees) -> le marqueur de la statusline disparait sans intervention.
      if (st.blocked && st.blocked[tok.name]) { delete st.blocked[tok.name]; log("PROBE", tok.name, "OK -> blocage conditions leve"); }
      // journal sans accents : lu tel quel par PowerShell/cmd (encodage ANSI -> "Ã©")
      const cr = onCredits ? " [forfait epuise -> credits" + (q.ovU == null ? "" : " " + q.ovU + "% utilises") + "]" : "";
      if (st.exhausted[tok.name] && overloadActive(st, tok.name)) {
        log("PROBE", tok.name, "OK mais surcharge serveur en cours -> pause maintenue jusqu'a", new Date(st.overload[tok.name].until).toISOString());
      } else if (st.exhausted[tok.name]) { delete st.exhausted[tok.name]; log("PROBE", tok.name, "OK -> deblocage anticipe (5h=" + q.u5h + "% 7j=" + q.u7d + "%)" + cr); }
      else log("PROBE", tok.name, "5h=" + q.u5h + "% 7j=" + q.u7d + "%" + cr);
    } else if (pres.statusCode === 429) {
      const until = q.retryAfterMs || q.r5 || (now() + TRANSIENT_COOLDOWN_MS);
      st.exhausted[tok.name] = until;
      log("PROBE", tok.name, "encore bloque -> cooldown jusqu'a", new Date(until).toISOString());
    } else {
      log("PROBE", tok.name, "http" + pres.statusCode);
    }
    writeState(st);
    finish(allowed);
  }, (e) => { log("PROBE err", tok.name, e.message); finish(false); });
  if (!req) return;
  req.setTimeout(10000, () => { try { req.destroy(new Error("probe timeout")); } catch (e) {} });
  req.on("error", (e) => { log("PROBE err", tok.name, e.message); finish(false); });
  req.write(PROBE_BODY);
  req.end();
}

// ----- rafraichissement en arriere-plan (statusline "live") -----
// Sans ca, l'utilisation d'un compte dans state.json ne bouge QUE quand une vraie requete
// passe par lui (ou lors d'une attente active sur LUI). Si les deux comptes sont a sec et
// que Claude Code est juste ouvert en attente d'un reset, les chiffres affiches restent
// figes. On sonde PERIODIQUEMENT tous les comptes actives (probeToken = ~8 tokens d'entree,
// 0 sortie -> quasi gratuit) pour que la statusline reste vivante sans jamais depenser de
// vrais tokens. Gate sur state.pct[name].at (rempli aussi bien par une vraie requete que par
// une sonde) pour ne jamais re-sonder un compte deja rafraichi tres recemment.
// Sonde periodique COUPEE par defaut. Claude Code ne redessine pas sa barre d'etat tout seul :
// elle est recalculee a chaque echange. Sonder en continu n'affichait donc rien de plus -- juste
// du trafic (mesure du 29/07/2026 : 3310 sondes pour 268 vraies requetes dans la journee).
// Les quotas sont rafraichis la ou ca compte : a chaque requete (voir refreshOthers) et pendant
// une attente de quota (voir enterWait). `cqr live <s>` reactive le mode continu si besoin.
const LIVE_POLL_DEFAULT_MS = 0;
// Anti-rafale : plusieurs sous-agents peuvent lancer 20 requetes en quelques secondes -- inutile
// de re-sonder les autres comptes a chacune.
const REFRESH_OTHERS_MS = 30000;

function startLivePolling(confInitial) {
  const ms = num(confInitial.livePollMs, LIVE_POLL_DEFAULT_MS);
  if (!ms || ms <= 0) return null;
  return setInterval(() => {
    let conf; try { conf = readConf(); } catch (e) { return; }
    let state; try { state = readState(); } catch (e) { state = {}; }
    const pct = state.pct || {};
    conf.tokens.forEach((t, i) => {
      if (!t.enabled || isPlaceholder(t)) return;
      const lastAt = Date.parse((pct[t.name] || {}).at || 0) || 0;
      if (now() - lastAt < ms * 0.9) return; // deja frais (vraie requete ou sonde recente)
      probeToken(conf, i);
    });
  }, ms);
}

// Rafraichit les comptes qui ne servent PAS la requete en cours : celui qui la sert renseigne
// deja son quota par les en-tetes de sa reponse. Une sonde par requete cliente, pas par seconde.
function refreshOthers(conf, activeIdx, state) {
  const pct = (state && state.pct) || {};
  conf.tokens.forEach((t, i) => {
    if (i === activeIdx || !t.enabled || isPlaceholder(t)) return;
    const lastAt = Date.parse((pct[t.name] || {}).at || 0) || 0;
    if (now() - lastAt < REFRESH_OTHERS_MS) return;
    probeToken(conf, i);
  });
}

function readQuotaHeaders(headers) {
  const u5 = Number(headers["anthropic-ratelimit-unified-5h-utilization"]);
  const u7 = Number(headers["anthropic-ratelimit-unified-7d-utilization"]);
  const ug = Number(headers["anthropic-ratelimit-unified-utilization"]);
  const utils = [u5, u7, ug].filter((x) => !isNaN(x));
  // Credits d'usage supplementaire ("extra usage"). Anthropic les expose sur CHAQUE reponse ;
  // overage-status=allowed veut dire "quand le forfait sera epuise, la requete passera quand
  // meme, sur les credits". overage-utilization = part des credits deja consommee (0.0 = intacts).
  const ovStatus = headers["anthropic-ratelimit-unified-overage-status"] ? String(headers["anthropic-ratelimit-unified-overage-status"]).toLowerCase() : null;
  const ovU = Number(headers["anthropic-ratelimit-unified-overage-utilization"]);
  return {
    statuses: [headers["anthropic-ratelimit-unified-status"], headers["anthropic-ratelimit-unified-5h-status"], headers["anthropic-ratelimit-unified-7d-status"]]
      .filter(Boolean).map((s) => String(s).toLowerCase()),
    u5h: isNaN(u5) ? null : Math.round(u5 * 100),
    u7d: isNaN(u7) ? null : Math.round(u7 * 100),
    max: utils.length ? Math.round(Math.max.apply(null, utils) * 100) : null,
    r5: parseEpochMs(headers["anthropic-ratelimit-unified-5h-reset"]),
    r7: parseEpochMs(headers["anthropic-ratelimit-unified-7d-reset"]),
    retryAfterMs: (() => { const ra = Number(headers["retry-after"]); return isNaN(ra) ? null : now() + ra * 1000; })(),
    ovStatus,
    ovAllowed: /^allowed/.test(ovStatus || ""), // allowed | allowed_warning
    ovU: isNaN(ovU) ? null : Math.round(ovU * 100),
    ovURaw: isNaN(ovU) ? null : ovU, // fraction brute : garde les centimes quand on convertit en argent
    ovReset: parseEpochMs(headers["anthropic-ratelimit-unified-overage-reset"]),
    ovReason: headers["anthropic-ratelimit-unified-overage-disabled-reason"] || null,
    ovInUse: String(headers["anthropic-ratelimit-unified-overage-in-use"] || "") === "true",
  };
}

// Recopie la vue quota d'une reponse dans l'etat partage (meme traitement pour une vraie
// requete et pour une sonde) -- sans ca, les credits ne seraient connus que d'un seul chemin.
function applyQuota(st, name, q) {
  if (q.max != null) { st.pct = st.pct || {}; st.pct[name] = { max: q.max, h5: q.u5h, d7: q.u7d, at: ts() }; }
  if (q.r5) { st.reset5h = st.reset5h || {}; st.reset5h[name] = q.r5; }
  if (q.r7) { st.reset7d = st.reset7d || {}; st.reset7d[name] = q.r7; }
  if (q.ovStatus) {
    st.overage = st.overage || {};
    // onCredits = meme calcul que Claude Code (isUsingOverage) : le forfait est annonce epuise ET
    // les credits couvrent -> cette reponse a ete facturee aux credits. C'est ce qui allume la
    // pastille verte de la statusline.
    st.overage[name] = { status: q.ovStatus, u: q.ovU, uRaw: q.ovURaw, reset: q.ovReset, reason: q.ovReason, inUse: q.ovInUse, onCredits: q.statuses.indexOf("rejected") >= 0 && q.ovAllowed, at: ts() };
  }
}
// DR-048 : ce que Claude Code annonce de sa requete (en-tetes x-claude-code-*, le type n'arrive que si
// CLAUDE_CODE_GATEWAY_HINT_HEADERS=1, pose par l'installeur). Valeurs reduites a [A-Za-z0-9_-] (une ligne de
// journal ne se laisse pas casser par un en-tete) ; la session n'est JAMAIS notee en entier : 8 caracteres.
const tag = (v, n) => String(v == null ? "" : v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, n) || "-";
// Les 6 en-tetes que seule la variable ajoute : le journal les lit sur la requete du client, l'amont n'a pas a les recevoir.
// x-claude-code-session-id / -agent-id / -parent-agent-id n'y sont PAS : Claude Code les envoie meme sans la variable.
const INDICES_CLAUDE_CODE = ["x-claude-code-request-class", "x-claude-code-agent-type", "x-claude-code-prompt-id",
  "x-claude-code-compaction", "x-claude-code-context-compacted", "x-claude-code-prev-tool-durations"];
function tagsRequete(h) {
  h = h || {};
  return ["classe=" + tag(h["x-claude-code-request-class"], 20), "session=" + tag(h["x-claude-code-session-id"], 8)];
}
function logRate(headers, statusCode, name, reqHeaders) {
  const rl = {}; for (const k of Object.keys(headers)) if (/^anthropic-ratelimit/i.test(k) || k === "retry-after") rl[k] = headers[k];
  if (Object.keys(rl).length || statusCode >= 400) log("RESP", statusCode, "token=" + name, ...tagsRequete(reqHeaders), "rl=", rl);
}

// ----- decision d'auto-compaction -----
// Compacte la requete sortante quand on bascule vers un autre compte parce que le
// compte quitte a atteint son seuil (par modele), OU quand on relache une requete
// apres une attente de quota. Ne fait rien si compaction desactivee.
function decideCompaction(conf, state, bodyObj, prevActive, newIdx, ctx, switching) {
  const cc = conf.compaction || {};
  if (!cc.enabled && !cc.dryRun) return null;
  // only compact requests that actually carry a conversation (not count_tokens, etc.)
  if (!bodyObj || !Array.isArray(bodyObj.messages) || !bodyObj.messages.length) return null;
  const model = bodyObj && bodyObj.model;
  const thr = comp.modelThreshold(model, cc.thresholds);
  const prevName = (conf.tokens[prevActive] || {}).name;
  const prevU5 = prevName && state.pct && state.pct[prevName] ? state.pct[prevName].h5 : null;
  let compact = false, reason = "", inPlace = false;
  if (ctx.resumed) { compact = true; reason = "resume"; ctx.resumed = false; }
  else if (switching && prevU5 != null && prevU5 >= thr) { compact = true; reason = "switch@" + prevU5 + ">=" + thr + "%"; }
  // Compaction dynamique EN PLACE (sans changer de compte) : quand le contexte est deja assez
  // gros pour risquer un gros saut d'utilisation, on reduit la requete sur le compte COURANT au
  // lieu de basculer -> le compte actif dure plus longtemps. Opt-in (cc.dynamicThreshold), mode
  // natif seulement (clear_tool_uses = 0 token, pas d'appel Haiku), pas de marqueur memoire
  // (aucun compte quitte a resumer). C'est ce que l'utilisateur veut : "rester sur la meme cle".
  if (!compact && cc.dynamicThreshold && cc.mode !== "strip") {
    const curName = (conf.tokens[newIdx] || {}).name;
    const curU5 = curName && state.pct && state.pct[curName] ? state.pct[curName].h5 : null;
    const dyn = comp.dynamicThreshold(model, bodyObj, { safetyBufferPoints: cc.dynamicSafetyBufferPoints });
    if (curU5 != null && curU5 >= dyn && curU5 < thr) { compact = true; inPlace = true; reason = "dynamic-inplace@" + curU5 + ">=" + dyn + "%"; }
  }
  if (!compact) return null;
  // Cooldown (uniquement pour la compaction liee a un SWITCH/resume) : une fois tous les comptes
  // au-dessus de leur seuil, pickRoute (a raison, pour le failover) continue d'alterner -> sans
  // ce garde-fou on recompacterait a CHAQUE requete. La compaction EN
  // PLACE n'a pas ce probleme (0 token, on veut justement reduire chaque requete),
  // donc elle n'est PAS soumise au cooldown.
  if (!inPlace) {
    const cooldownMs = num(cc.compactionCooldownMs, 600000);
    const last = state.lastCompactAt || 0;
    if (cooldownMs > 0 && now() - last < cooldownMs) return null;
  }
  return { compact: true, inPlace, reason, dryRun: !cc.enabled && !!cc.dryRun, mode: cc.mode === "strip" ? "strip" : "native", keepToolUses: num(cc.keepToolUses, 10), triggerTokens: num(cc.triggerTokens, 2000), clearAtLeast: num(cc.clearAtLeast, null) };
}

// ----- coeur : route puis (forward | wait->forward), avec rejeu sur rejet -----
function serve(creq, cres) {
  // sans ecouteur, une erreur d'ecriture sur la reponse (client parti) tuait le relais (DR-012)
  cres.on("error", (e) => log("CLIENT res error", e.message));
  if (creq.url === "/__proxy_health") {
    cres.writeHead(200, { "content-type": "application/json" });
    cres.end(JSON.stringify({ ok: true, ts: ts(), state: readState() }));
    return;
  }
  const chunks = [];
  let clientGone = false;
  // requete amont en cours pour ce client : detruite des qu'il part (DR-012), sinon elle continue de
  // tirer (et de facturer) une reponse que personne ne lira, jusqu'a la fin du flux ou 90 s de silence.
  let upstreamReq = null;
  const abandon = () => { clientGone = true; if (upstreamReq) { try { upstreamReq.destroy(); } catch (e) {} } };
  const reqStart = now();
  creq.on("data", (c) => chunks.push(c));
  creq.on("error", (e) => { abandon(); log("CLIENT error", e.message, "elapsedMs=" + (now() - reqStart)); });
  creq.on("aborted", () => { abandon(); log("CLIENT aborted", "elapsedMs=" + (now() - reqStart)); });
  cres.on("close", () => { if (!cres.writableFinished) { abandon(); log("CLIENT close (writableFinished=false)", "elapsedMs=" + (now() - reqStart)); } });
  creq.on("end", () => {
    const body = Buffer.concat(chunks);
    let bodyObj = null;
    try { bodyObj = JSON.parse(body.toString("utf8")); } catch (e) {}
    const isStream = !!(bodyObj && bodyObj.stream === true);
    const ctx = { tried: new Set(), waitStart: 0, polls: 0, sse: false, ka: null, netRetries: 0, cutRetries: 0, resumed: false, sent: false, replayed: false };
    // DR-048 : Claude Code annonce lui-meme qu'il compacte (auto, manual, reactive). Une fois par requete, a son arrivee.
    // Ligne distincte de COMPACT, qui est la compaction du relais a la bascule de compte.
    if (creq.headers["x-claude-code-compaction"]) log("CLAUDE-COMPACT", "motif=" + tag(creq.headers["x-claude-code-compaction"], 20), ...tagsRequete(creq.headers), "model=" + tag(bodyObj && bodyObj.model, 60));
    function stopKeepalive() { if (ctx.ka) { clearInterval(ctx.ka); ctx.ka = null; } }
    // garde la connexion client ouverte pendant qu'on retente (quota, coupure reseau, panne
    // serveur) : en streaming, Claude coupe au bout de ~5 min sans octet -> commentaires SSE.
    function holdOpen(msg) {
      if (isStream && !ctx.sse) {
        ctx.sse = true;
        try { cres.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" }); } catch (e) {}
      }
      if (!ctx.sse || ctx.ka) return;
      // un octet TOUT DE SUITE, pas dans 20 s : a la reprise d'une attente, le client n'a peut-etre
      // rien recu depuis presque son delai de garde (120 s) -- attendre le 1er battement le ferait couper.
      try { cres.write(": claude-auth-proxy: " + msg + "\n\n"); } catch (e) {}
      ctx.ka = setInterval(() => {
        if (clientGone) { stopKeepalive(); return; }
        try { cres.write(": keepalive\n\n"); } catch (e) {}
      }, 20000);
    }
    // budget "Anthropic injoignable" : compte depuis la 1re erreur, remis a zero des qu'une
    // reponse HTTP arrive (le reseau marche de nouveau).
    function netBudgetLeft(conf) {
      if (!ctx.netStart) ctx.netStart = now();
      return now() - ctx.netStart < conf.networkErrorMaxMs;
    }
    function sseError(msg) {
      try {
        cres.write("event: error\ndata: " + JSON.stringify({ type: "error", error: { type: "overloaded_error", message: msg } }) + "\n\n");
        cres.end();
      } catch (e) {}
    }
    // erreur rendue au client, sur le chemin habituel (flux SSE deja ouvert, ou 502)
    function failClient(msg) {
      stopKeepalive();
      if (ctx.sse) { sseError(msg); return; }
      if (!cres.headersSent) { try { cres.writeHead(502, { "content-type": "text/plain" }); } catch (x) {} }
      try { cres.end("proxy: " + msg); } catch (x) {}
    }
    // Garde PAR REQUETE (DR-012). Une exception dans le trajet de cette requete (un callback, un minuteur de
    // reprise) laissait le relais vivant mais la requete orpheline : client sans reponse, battements SSE sans
    // fin (ctx.ka) -- jusqu'a API_TIMEOUT_MS, parfois des jours. Rien de la reponse amont n'est parti vers le
    // client -> la requete est conservee et REJOUEE une fois (Claude Code ne refait rien, ne rebrule rien).
    // Sinon (octets deja partis, ou le rejeu leve aussi) -> fin nette : il retente tout de suite.
    function guard(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { crashed(e); } }; }
    const after = (fn, ms) => setTimeout(guard(fn), ms);
    const committed = () => ctx.sent || cres.writableEnded || (!ctx.sse && cres.headersSent);
    function crashed(e) {
      const replay = !clientGone && !ctx.replayed && !committed();
      logVie("erreur en pleine requete", stackOf(e), replay ? "-> requete rejouee" : "-> requete terminee");
      if (clientGone) { stopKeepalive(); return; }
      if (replay) {
        ctx.replayed = true;
        // l'ancienne requete amont ne doit plus rien declencher (son 'error' relancerait un forward en double)
        const old = upstreamReq; upstreamReq = null;
        if (old) { old.removeAllListeners("error"); old.on("error", () => {}); try { old.destroy(); } catch (x) {} }
        try { return attempt(); } catch (e2) { logVie("erreur en pleine requete (rejeu)", stackOf(e2), "-> requete terminee"); }
      }
      if (!cres.writableEnded) { if (committed()) { try { cres.destroy(); } catch (x) {} } else failClient("erreur interne du relais, requete a refaire"); }
      stopKeepalive();
      abandon(); // plus aucun minuteur ne doit reprendre cette requete
    }
    guard(attempt)();

    function attempt() {
      if (clientGone) return;
      let conf, state;
      try { conf = readConf(); state = readState(); }
      catch (e) { try { cres.writeHead(500); cres.end("proxy: conf illisible: " + e.message); } catch (x) {} return; }

      const route = pickRoute(conf, state, bodyObj);
      if (route.none) { try { cres.writeHead(502); cres.end("proxy: aucun token configuré"); } catch (x) {} return; }

      if (route.wait) return enterWait(conf, state, route);

      // route immediate
      const prevActive = state.activeIndex || 0;
      const switching = prevActive !== route.idx;
      // routage sur les credits : trace une fois par requete (sinon 1 ligne par tentative)
      if (route.overage && !ctx.overageLogged) {
        ctx.overageLogged = true;
        const ovU = ((state.overage || {})[(conf.tokens[route.idx] || {}).name] || {}).u;
        log("OVERAGE route ->", (conf.tokens[route.idx] || {}).name, "aucun forfait dispo, credits autorises" + (ovU == null ? "" : " (" + ovU + "% consommes)"));
      }
      if (state.waiting) { delete state.waiting; }
      if (switching) { state.activeIndex = route.idx; }
      // decide compaction BEFORE overwriting the "previous account" utilization view.
      // Only for the real /v1/messages endpoint (never count_tokens or other JSON paths).
      const isMsgs = String(creq.url || "").split("?")[0] === "/v1/messages";
      const compactInfo = isMsgs ? decideCompaction(conf, state, bodyObj, prevActive, route.idx, ctx, switching) : null;
      if (compactInfo && compactInfo.compact && !compactInfo.inPlace) {
        // compaction liee a un SWITCH/resume : tamponne (reel ou dry-run) pour le cooldown, et
        // ecrit le marqueur de derniere compaction (state.compaction, affiche par `cqr compact`).
        state.lastCompactAt = now();
        if (!compactInfo.dryRun) {
          state.compaction = { at: now(), from: (conf.tokens[prevActive] || {}).name, to: (conf.tokens[route.idx] || {}).name, model: bodyObj && bodyObj.model, reason: compactInfo.reason };
        }
      }
      writeState(state);
      // PAS de stopKeepalive ici : si le flux est deja ouvert (reprise d'une attente), le client
      // doit continuer de recevoir ses battements pendant qu'Anthropic prepare sa reponse --
      // sinon une reponse lente ou une connexion morte le fait couper. Ils s'arretent a la reponse.
      refreshOthers(conf, route.idx, state); // en tache de fond : garde la barre d'etat juste
      // forced (pin manuel) -> pas de failover/attente, on rend le resultat brut
      forward(conf, route.idx, route.forced === true, compactInfo);
    }

    function enterWait(conf, state, route) {
      if (!ctx.waitStart) ctx.waitStart = now();
      ctx.cutStart = 0; // une attente de quota est passee entre deux coupures : le budget repart
      // non-stream : pas de keepalive applicatif possible, mais le TCP keepalive (setKeepAlive
      // plus bas) couvre le risque NAT/firewall ; le client tolere un hold jusqu'a API_TIMEOUT_MS
      // (meme plafond que le stream), donc meme capMs pour les deux.
      const deadline = ctx.waitStart + conf.maxWaitMs;
      if (now() >= deadline) {
        // plafond atteint : on forwarde quand meme pour rendre l'erreur reelle au client
        log("WAIT giveup maxWaitMs token=" + conf.tokens[route.idx].name);
        if (state.waiting) { delete state.waiting; writeState(state); }
        return forward(conf, route.idx, true);
      }
      const tName = conf.tokens[route.idx].name;
      const untilISO = new Date(route.untilMs).toISOString();
      state.waiting = { since: new Date(ctx.waitStart).toISOString(), until: untilISO, reason: route.reason, target: tName, polls: ctx.polls };
      writeState(state);
      if (ctx.polls === 0) log("WAIT", route.reason, "jusqu'a", untilISO, "(token", tName + ") - hold de la requete" + (isStream ? " (keepalive SSE)" : ""));
      ctx.polls++;
      // streaming : on garde la connexion vivante par des commentaires SSE (sinon Claude coupe ~5min)
      holdOpen("attente de quota, reprise automatique");
      // dort jusqu'au reset (borné par pollMs pour re-évaluer / detecter un override manuel)
      // jitter aleatoire : plusieurs requetes retenues ne doivent pas repartir au meme instant (rafale -> 429)
      const jitter = 1500 + Math.floor(Math.random() * 3000);
      const sleep = Math.max(1000, Math.min(conf.pollMs, route.untilMs - now() + jitter));
      after(() => {
        ctx.tried.clear();
        if (clientGone) { stopKeepalive(); return; }
        // half-open : au reveil (reset atteint) ou toutes les 5 min, sonder le token
        // cible (8 tokens haiku) pour verifier/corriger l'etat AVANT de relacher la requete
        const wakeReached = now() >= route.untilMs;
        // reprise apres attente de quota -> on compacte la requete qu'on relache
        if (wakeReached && conf.compaction && (conf.compaction.enabled || conf.compaction.dryRun) && conf.compaction.compactBeforeResume !== false) ctx.resumed = true;
        const probeDue = wakeReached || (now() - (lastProbeAt[tName] || 0)) >= PROBE_REFRESH_MS;
        if (probeDue) probeToken(conf, route.idx, guard(() => { if (!clientGone) attempt(); }));
        else attempt();
      }, sleep);
    }

    function forward(conf, idx, lastResort, compactInfo) {
      if (clientGone) return;
      const state = readState();
      const tok = conf.tokens[idx];
      if (!tok || isPlaceholder(tok)) { try { cres.writeHead(502); cres.end("proxy: token cible invalide"); } catch (x) {} return; }
      ctx.tried.add(tok.name);

      const headers = Object.assign({}, creq.headers);
      headers["host"] = UPSTREAM_HOST;
      headers["authorization"] = "Bearer " + tok.token;
      delete headers["x-api-key"];
      // we always send with an explicit content-length -> drop any chunked encoding from the client
      delete headers["transfer-encoding"];
      for (const h of INDICES_CLAUDE_CODE) delete headers[h];

      // --- auto-compaction : reduit les tokens envoyes au compte cible (0 token) ---
      let sendBody = body;
      if (compactInfo && compactInfo.compact && bodyObj) {
        if (compactInfo.dryRun) {
          log("COMPACT dry-run", compactInfo.reason, "model=" + (bodyObj.model || "?"), "token=" + tok.name, "(aucune modif)");
        } else {
          try {
            const clone = JSON.parse(JSON.stringify(bodyObj));
            if (compactInfo.mode === "strip") {
              const r = comp.stripOldToolResults(clone, compactInfo.keepToolUses);
              sendBody = Buffer.from(JSON.stringify(r.body));
              log("COMPACT strip", compactInfo.reason, "stubbed=" + r.stubbed, "token=" + tok.name);
            } else {
              const r = comp.injectNative(clone, compactInfo.keepToolUses, compactInfo.triggerTokens, { clearAtLeast: compactInfo.clearAtLeast });
              comp.mergeBeta(headers);
              sendBody = Buffer.from(JSON.stringify(r.body));
              log("COMPACT native", compactInfo.reason, r.added ? "clear_tool_uses(keep " + compactInfo.keepToolUses + ")" : "deja present", "token=" + tok.name);
            }
          } catch (e) { log("COMPACT err", e.message, "-> body inchange"); sendBody = body; }
        }
      }

      if (sendBody.length) headers["content-length"] = Buffer.byteLength(sendBody);
      // en mode keepalive SSE on a deja envoye nos en-tetes sans content-encoding :
      // on force une reponse upstream non compressee pour pouvoir la relayer telle quelle
      if (ctx.sse) delete headers["accept-encoding"];

      // Coupure PENDANT le corps de la reponse (cable ethernet debranche, bascule wifi, VPN qui
      // reconnecte) : le flux d'Anthropic s'arrete au milieu. Un simple pipe ne dit RIEN au client
      // dans ce cas -- il reste pendu, ou recoit un corps tronque qu'il n'arrive plus a
      // decompresser ("ZlibError", vecu le 01/09/2026 sur un debranchement) et la requete est
      // perdue. Deux cas, selon ce qui est deja parti :
      //  - AUCUN octet relaye -> on refait la requete, le client ne voit rien passer ;
      //  - des octets sont deja partis -> impossible de rejouer sans dupliquer la reponse : on
      //    coupe net la connexion, pour que le client voie une erreur RESEAU (qu'il sait retenter)
      //    plutot qu'un corps corrompu (qu'il ne sait pas retenter).
      function relay(pres) {
        let relayed = 0, cut = false;
        // en-tetes retenues jusqu'au PREMIER octet : tant que rien n'est parti, la requete reste
        // rejouable avec ses propres en-tetes. (En SSE, holdOpen les a deja envoyees.)
        const openOnce = () => { try { if (!cres.headersSent) cres.writeHead(pres.statusCode, pres.headers); } catch (x) {} };
        pres.on("data", (c) => { relayed += c.length; ctx.sent = true; openOnce(); });
        pres.on("end", openOnce);
        const onCut = guard(function onCut(e) {
          if (cut) return; cut = true;
          if (clientGone) { pres.destroy(); return; } // client parti (DR-012) : rien a rejouer ni a journaliser en coupure
          // Couper la SOURCE, pas seulement la debrancher. `unpipe` suppose que pres
          // alimente cres DIRECTEMENT ; le jour ou un maillon s'intercale (mesure,
          // decompression...), il ne debranche plus rien et le corps tronque continue de
          // couler -- sans qu'aucun test ne bronche. `destroy` ne depend pas du branchement.
          pres.unpipe(cres); pres.destroy(); // surtout pas de end() propre sur un corps incomplet
          // budget PROPRE aux coupures : celui des erreurs sans reponse (netBudgetLeft) repart a zero
          // des que des en-tetes arrivent, or ici ils arrivent a CHAQUE tentative -- il ne s'epuiserait jamais.
          if (!ctx.cutStart) ctx.cutStart = now();
          const retry = relayed === 0 && !clientGone && now() - ctx.cutStart < conf.networkErrorMaxMs;
          log("STREAM coupe", e.message, "token=" + tok.name, relayed + " octets relayes",
            retry ? "-> nouvelle tentative" : "-> connexion client coupee (erreur reseau franche)");
          if (!retry) { try { cres.destroy(e); } catch (x) {} return; }
          // compteur DEDIE : ctx.netRetries repart a zero des qu'une reponse arrive, il ne
          // ferait donc jamais grandir le delai si la coupure se repete a chaque tentative.
          ctx.cutRetries += 1;
          const delay = Math.min(30000, 2000 * Math.pow(2, ctx.cutRetries - 1));
          holdOpen("coupure reseau pendant la reponse, nouvelle tentative automatique");
          after(() => { if (!clientGone) forward(conf, idx, lastResort, compactInfo); }, delay);
        });
        pres.on("error", onCut);
        // selon la version de Node, une reponse tronquee emet "error", "aborted" ou juste
        // "close" : `complete` est le seul temoin fiable qu'on a bien recu tout le corps.
        pres.on("close", () => { if (!pres.complete) onCut(new Error("reponse upstream incomplete")); });
        pres.pipe(cres);
      }

      let answered = false;
      const preq = safeRequest({ hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: UPSTREAM_PATH_PREFIX + creq.url, method: creq.method, headers }, guard((pres) => {
        answered = true;
        ctx.netRetries = 0; ctx.netStart = 0; // une reponse (meme un rejet HTTP) prouve que le reseau fonctionne
        logRate(pres.headers, pres.statusCode, tok.name, creq.headers);
        const q = readQuotaHeaders(pres.headers);
        const st = readState();
        applyQuota(st, tok.name, q);

        // Panne serveur Anthropic (500/502/503/504) : aucun rapport avec le quota (la reponse
        // n'a meme pas d'en-tete ratelimit). C'est passager et souvent INTERMITTENT -- le
        // 29/07/2026, un 200 et un 500 a 10 s d'ecart pendant l'incident. Avant, on relayait
        // l'erreur telle quelle et la requete etait perdue (ex. une compaction qui echoue).
        // Maintenant : on retente le MEME compte avec un backoff court, sous keepalive, tant
        // que serverErrorMaxMs n'est pas epuise. Inutile de savoir quand la panne est reparee :
        // c'est la tentative qui aboutit qui le prouve (la page de statut, elle, retarde).
        // Borne volontaire : une requete que le serveur refuse SYSTEMATIQUEMENT (corps invalide,
        // trop grosse...) doit finir par rendre son erreur, pas rester suspendue indefiniment.
        // 529 (surcharge) garde son traitement propre : cooldown + bascule de compte.
        const serverError = pres.statusCode >= 500 && pres.statusCode !== 529;
        if (serverError && !lastResort && !clientGone) {
          if (!ctx.srvStart) ctx.srvStart = now();
          const budget = num(conf.serverErrorMaxMs, 15 * 60 * 1000);
          const elapsed = now() - ctx.srvStart;
          if (budget > 0 && elapsed < budget) {
            ctx.srvRetries = (ctx.srvRetries || 0) + 1;
            const delay = Math.min(60000, 2000 * Math.pow(2, ctx.srvRetries - 1));
            log("SERVER err http" + pres.statusCode, "token=" + tok.name, "panne Anthropic -> tentative #" + ctx.srvRetries, "dans", Math.round(delay / 1000) + "s");
            pres.resume(); // draine la reponse d'erreur
            holdOpen("erreur serveur Anthropic (http " + pres.statusCode + "), nouvelle tentative automatique");
            after(() => { if (!clientGone) forward(conf, idx, lastResort, compactInfo); }, delay);
            return;
          }
          log("SERVER err http" + pres.statusCode, "token=" + tok.name, "abandon apres", Math.round(elapsed / 1000) + "s et", ctx.srvRetries || 0, "tentatives -> erreur rendue au client");
        }

        // Refus administratif du compte : Anthropic rend un 400 dont le corps dit d'aller accepter
        // les nouvelles conditions sur claude.ai AVEC L'E-MAIL DE CE COMPTE. Ni quota, ni token
        // invalide -- aucun cooldown ne le repare. Et surtout : ce 400 ne tombait dans AUCUNE des
        // branches ci-dessous, donc il repartait au client a chaque requete pendant que le relais
        // continuait de croire le compte sain (vecu le 12/09/2026, travail perdu sans un mot).
        // Desormais : quarantaine longue, bascule immediate sur un autre compte, et alerte a
        // l'ecran. Le corps doit etre LU, donc bufferise -- un 400 est court, sans risque.
        if (pres.statusCode === 400) {
          const chunks = [];
          pres.on("data", (c) => chunks.push(c));
          // corps coupe en route : "end" ne vient jamais et le client resterait pendu. On coupe sa
          // connexion -- une erreur reseau, qu'il sait retenter (meme choix que relay()).
          pres.on("close", () => { if (!pres.complete) { try { cres.destroy(); } catch (x) {} } });
          pres.on("end", guard(() => {
            const raw = Buffer.concat(chunks);
            const txt = lib.decodeBody(raw, pres.headers["content-encoding"]);
            // TOUT 400 est journalise avec son corps : le jour ou Anthropic reformule ce message,
            // le motif ne le reconnaitra plus -- c'est cette ligne qui le dira, pas un silence.
            log("BAD REQUEST http400", "token=" + tok.name, txt.slice(0, 400).replace(/\s+/g, " "));
            const terms = lib.isTermsBlock(txt);
            // etat RELU : bufferiser le corps a coute un tour d'E/S, pendant lequel une sonde a
            // pu ecrire state.json. Reutiliser le `st` d'avant l'attente ecraserait son travail.
            const s2 = readState();
            applyQuota(s2, tok.name, q);
            clearOverload(s2, tok.name); // une reponse HTTP prouve que la surcharge est passee
            let alert = false;
            if (terms) {
              s2.exhausted = s2.exhausted || {}; s2.blocked = s2.blocked || {};
              const prev = s2.blocked[tok.name];
              const until = now() + TERMS_COOLDOWN_MS;
              s2.exhausted[tok.name] = until;
              s2.blocked[tok.name] = { reason: "terms", at: ts(), until: until };
              // une seule fenetre par blocage : un compte epingle (lastResort) en ouvrirait
              // sinon une par requete.
              alert = !prev || (prev.until || 0) <= now();
              log("BLOCKED(conditions)", tok.name, "http400 -> quarantaine jusqu'a", new Date(until).toISOString(), "; action humaine requise sur claude.ai");
            }
            writeState(s2);
            if (alert) lib.notifyWindows(
              "claude-quota-relay : compte " + tok.name + " bloque",
              "Anthropic refuse le compte " + tok.name + " jusqu'a acceptation de ses nouvelles" + "\n"
              + " conditions d'utilisation / de confidentialite." + "\n" + "\n"
              + "A FAIRE : ouvrir claude.ai, se connecter avec l'e-mail de CE compte," + "\n"
              + "puis accepter les conditions. Rien d'autre ne debloque ce compte." + "\n" + "\n"
              + "En attendant, le relais met ce compte de cote 6 h et travaille avec les autres comptes.",
              null, (e) => log("ALERTE fenetre impossible", e.message)); // wscript introuvable : une ligne au journal (DR-012)
            // bascule : la requete en cours part sur un autre compte, le client ne perd rien
            if (terms && !lastResort && !clientGone) return attempt();
            // 400 ordinaire (corps invalide, modele inconnu...) ou compte epingle : l'erreur
            // revient au client telle qu'Anthropic l'a rendue, corps intact.
            stopKeepalive();
            if (ctx.sse) return sseError(terms
              ? "compte " + tok.name + " bloque : conditions a accepter sur claude.ai (http 400)"
              : "requete refusee par Anthropic (http 400)");
            try { cres.writeHead(400, pres.headers); cres.end(raw); } catch (x) {}
          }));
          return;
        }

        // Forfait epuise MAIS credits disponibles : Anthropic a SERVI la requete (200) et l'a
        // facturee aux credits d'usage supplementaire. Le marquer "epuise" ici mettrait en
        // quarantaine un compte qui repond parfaitement -- et ferait attendre le reset 5h alors
        // qu'il n'y a rien a attendre. Un vrai 429 reste un vrai rejet (credits epuises, plafond
        // de depense, limite par minute...) et garde le comportement d'origine.
        const onCredits = pres.statusCode < 400 && q.statuses.indexOf("rejected") >= 0 && q.ovAllowed;
        if (onCredits) log("OVERAGE", tok.name, "forfait epuise -> servi sur les credits" + (q.ovU == null ? "" : " (" + q.ovU + "% consommes)") + (q.ovReset ? " reset " + new Date(q.ovReset).toISOString() : ""));
        const rejected = pres.statusCode === 429 || (q.statuses.indexOf("rejected") >= 0 && !onCredits);
        const authFail = pres.statusCode === 401 || pres.statusCode === 403;
        const overloaded = pres.statusCode === 529; // serveur Anthropic surcharge : rien a voir avec le quota

        if ((rejected || authFail || overloaded) && !lastResort) {
          // 429 SANS retry-after NI reset 5h = transitoire (surcharge, requete trop grosse...)
          // -> cooldown court, surtout pas 5h (sinon on bloque un compte encore frais)
          const transient = overloaded || (!authFail && q.retryAfterMs == null && q.r5 == null);
          const until = authFail ? now() + AUTH_COOLDOWN_MS
            : overloaded ? noteOverload(st, tok.name)   // surcharge : pause qui s'allonge, et que la sonde ne leve pas
            : transient ? now() + TRANSIENT_COOLDOWN_MS
            : (q.retryAfterMs || q.r5);
          st.exhausted = st.exhausted || {}; st.exhausted[tok.name] = until;
          writeState(st);
          log(authFail ? "AUTHFAIL" : overloaded ? "OVERLOADED(529) x" + st.overload[tok.name].n : (transient ? "REJECTED(transitoire)" : "REJECTED"), tok.name, "http" + pres.statusCode, "-> cooldown jusqu'a", new Date(until).toISOString());
          pres.resume(); // draine
          // re-pick (un autre token frais, sinon WAIT)
          return attempt();
        }

        // Le compte sert de nouveau : le refus administratif est leve (conditions acceptees), et
        // LA QUARANTAINE QU'IL AVAIT POSEE part avec lui. Sans cette seconde ligne, le marqueur
        // disparaissait de la barre d'etat pendant que le routage continuait d'ecarter le compte
        // en silence jusqu'a l'echeance des 6 h. On ne leve QUE l'echeance de ce refus (comparee
        // a l'identique) : un 429 survenu depuis a sa propre raison d'etre, qui ne nous regarde pas.
        if (st.blocked && st.blocked[tok.name] && pres.statusCode < 400) {
          if (st.exhausted && st.exhausted[tok.name] === st.blocked[tok.name].until) delete st.exhausted[tok.name];
          delete st.blocked[tok.name];
        }
        clearOverload(st, tok.name); // une vraie reponse servie = la surcharge est passee
        writeState(st);
        stopKeepalive();
        if (ctx.sse) {
          // flux SSE deja ouvert (keepalive) : on relaie seulement le corps si succes
          if (pres.statusCode >= 200 && pres.statusCode < 300) {
            relay(pres);
          } else {
            pres.resume();
            sseError((pres.statusCode >= 500 ? "erreur serveur Anthropic" : "limite atteinte") + " (http " + pres.statusCode + ")");
          }
        } else {
          relay(pres);
        }
      }), guard((e) => {
        // La requete n'a meme pas pu partir (jeton a caractere invalide...) : echec de CE compte, pas de
        // la requete. Comme un 401 : le compte est ecarte 5 min et la requete repart sur un autre ; sans
        // autre compte (ou compte epingle) elle suit le chemin d'erreur habituel (DR-012).
        log("REQUEST impossible", tok.name, e.message, "-> compte ecarte 5 min");
        const st = readState();
        st.exhausted = st.exhausted || {}; st.exhausted[tok.name] = now() + AUTH_COOLDOWN_MS;
        writeState(st);
        if (clientGone) return;
        if (lastResort) return failClient("requete impossible: " + e.message);
        attempt();
      }));
      if (!preq) return;
      upstreamReq = preq;
      // Connexion morte sans erreur (PC mis en veille, reseau change, VPN qui la laisse pendre) :
      // le systeme ne previent pas, on attendrait indefiniment. Un silence trop long devient une
      // erreur, traitee plus bas comme une coupure. Streaming seulement : une reponse non-stream
      // se tait legitimement pendant toute sa generation.
      // Delai : idle + 1 s par 32 Ko envoyes, comme la fenetre de premier octet de Claude Code --
      // un gros contexte met legitimement longtemps a demarrer, et le relancer en boucle serait pire
      // que la panne. Mesure : pendant la poignee de main TLS, Node declenche ce delai deux fois
      // plus tard (3 s demandees -> 6 s) ; une fois connecte, il est exact.
      // ponytail: non-stream sans garde (un silence y est legitime) ; une connexion morte y reste
      // pendue jusqu'a l'erreur TCP du systeme. Ajouter setKeepAlive cote amont si on l'observe.
      if (isStream && conf.upstreamIdleMs > 0) preq.setTimeout(conf.upstreamIdleMs + Math.ceil(sendBody.length / 32768) * 1000, () => preq.destroy(new Error("aucun octet d'Anthropic (connexion morte)")));
      preq.on("error", guard((e) => {
        // Aucune reponse HTTP n'est arrivee -- a distinguer d'un vrai rejet HTTP (429/401/529),
        // gere dans le callback pres ci-dessus. Coupure internet, wifi qui tombe, VPN ou Zscaler
        // qui se reconnecte, certificat intercepte, connexion muette : TOUTES retentees, car depuis
        // le PC on ne distingue pas une panne passagere d'un reseau pas encore pret. Avant, seule
        // une liste de codes l'etait -- un certificat intercepte rendait l'erreur tout de suite et
        // le sous-agent brulait ses 11 tentatives en 3 min (mesure le 2026-09-28, DR-011).
        // Node emet aussi cette erreur quand la connexion meurt APRES les en-tetes : c'est alors
        // relay() qui decide (rejouer ou couper) -- relancer ici doublerait la requete.
        if (answered) return;
        if (clientGone) { stopKeepalive(); return; } // client parti (DR-012) : on ne retente ni ne rend rien
        if (netBudgetLeft(conf)) {
          ctx.netRetries = (ctx.netRetries || 0) + 1;
          const delay = Math.min(30000, 2000 * Math.pow(2, ctx.netRetries - 1));
          log("NETWORK err", e.message, "token=" + tok.name, "retry #" + ctx.netRetries, "in", Math.round(delay / 1000) + "s");
          holdOpen("coupure reseau detectee, nouvelle tentative automatique");
          after(() => { if (!clientGone) forward(conf, idx, lastResort, compactInfo); }, delay);
          return;
        }
        log("UPSTREAM err", e.message, "token=" + tok.name, ctx.netRetries ? ("abandon apres " + ctx.netRetries + " tentatives") : "");
        failClient("erreur upstream: " + e.message);
      }));
      if (sendBody.length) preq.write(sendBody);
      preq.end();
    }
  });
}

// Pure decision helpers are exported for tests; the server only boots when run directly.
module.exports = { pickRoute, decideCompaction, readQuotaHeaders, startLivePolling, probeToken, noteOverload, overloadActive, clearOverload, LIVE_POLL_DEFAULT_MS, resolveUpstream, UPSTREAM_HOST, UPSTREAM_PORT, UPSTREAM_PATH_PREFIX };

// Horodatage de la derniere ligne du journal (ligne "[ISO] ..."), ou "inconnue".
function lastLogStamp() {
  try {
    const txt = fs.readFileSync(LOG, "utf8").trimEnd();
    const m = /^\[([^\]]+)\]/.exec(txt.slice(txt.lastIndexOf("\n") + 1));
    return m ? m[1] : "inconnue";
  } catch (e) { return "inconnue"; }
}
// PID ecrit dans proxy.pid s'il est MORT et n'est pas le notre, sinon 0.
// ponytail: Windows reutilise les PID. Un PID mort repris par un autre processus passe pour un relais
// vivant et masque la detection (arret brutal non signale) ; verifier le nom du processus
// couterait un appel externe (tasklist) pour un cas rare.
function deadPidInFile() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DIR, "proxy.pid"), "utf8").trim(), 10);
    if (!pid || pid === process.pid) return 0;
    try { process.kill(pid, 0); return 0; } catch (e) { return e.code === "EPERM" ? 0 : pid; }
  } catch (e) { return 0; }
}
// Version du relais : package.json a cote (copie installee) ou au-dessus (depot : src/..), sinon "inconnue".
function relayVersion() {
  for (const f of ["package.json", path.join("..", "package.json")]) {
    try { const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); if (j.name === "claude-quota-relay" && j.version) return j.version; } catch (e) {}
  }
  return "inconnue";
}

if (require.main === module) {
  // Gardes de processus (DR-012) : le relais ne s'arrete JAMAIS sur une erreur imprevue -- une requete
  // coupee, c'est Claude Code qui refait tout et rebrule ses jetons. Pile complete au journal, on continue.
  // Seule exception : tant que le relais n'est pas en ligne (conf illisible...), continuer n'a pas de sens.
  let up = false;
  process.on("uncaughtException", (e, origin) => {
    logVie("erreur imprevue", origin, stackOf(e), up ? "-> le relais continue" : "-> demarrage impossible, arret");
    if (!up) process.exit(1);
  });
  process.on("unhandledRejection", (r) => logVie("erreur imprevue unhandledRejection", stackOf(r), "-> le relais continue"));

  const conf0 = readConf();
  const server = http.createServer(serve);
  // pas de timeout : on doit pouvoir retenir une requete longtemps
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 75_000;
  server.on("connection", (s) => { try { s.setKeepAlive(true, 30_000); } catch (e) {} });
  server.on("error", (e) => { log("SERVER err", e.message); if (!up) process.exit(1); }); // port pris : on s'efface ; en ligne : on continue
  // PID file : permet un arret portable (sans netstat/taskkill/lsof) depuis le CLI.
  const PIDFILE = path.join(DIR, "proxy.pid");
  function cleanupPid() { try { if (fs.readFileSync(PIDFILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PIDFILE); } catch (e) {} }
  process.on("exit", (code) => { logVie("sortie code=" + code + " pid=" + process.pid); cleanupPid(); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => { logVie("signal " + sig + " recu pid=" + process.pid); process.exit(0); });

  server.listen(conf0.port, "127.0.0.1", () => {
    up = true;
    // A lire AVANT d'ecrire notre PID et notre premiere ligne : un PID mort dans proxy.pid = un relais
    // tue sans avoir pu nettoyer (TerminateProcess ne laisse aucune trace), et la derniere ligne du
    // journal date alors son dernier souffle.
    // `cqr stop` pose proxy.stopped avant de tuer le relais (sous Windows : TerminateProcess, donc
    // meme PID mort que d'un vrai plantage) : le marqueur, lu avant d'etre efface plus bas, les distingue.
    const dernier = lastLogStamp(), mort = deadPidInFile(), voulu = fs.existsSync(path.join(DIR, "proxy.stopped"));
    logVie("demarrage pid=" + process.pid, "version=" + relayVersion(), "node=" + process.version, "lance_par=" + (process.env.CQR_STARTED_BY || "inconnu"));
    if (mort) logVie(voulu ? "arret voulu precedent (cqr stop) pid=" + mort : "arret brutal precedent detecte pid=" + mort, "derniere_ligne_du_journal=" + dernier);
    // PID ecrit seulement maintenant : un second relais qui echoue sur le port (EADDRINUSE) effacait
    // celui du premier. Le marqueur "arret voulu" de `cqr stop` tombe aussi : un relais qui demarre l'annule.
    try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch (e) {}
    try { fs.unlinkSync(path.join(DIR, "proxy.stopped")); } catch (e) {}
    log("PROXY v3 up http://127.0.0.1:" + conf0.port,
      "switch=" + conf0.switchAtPercent + "% bloc7j=" + conf0.sevenDayBlockPercent + "% softWait=" + conf0.waitAtSoftPercent + " maxWait=" + Math.round(conf0.maxWaitMs / 60000) + "min",
      "credits=" + (conf0.overage.use ? "autorises (max " + conf0.overage.maxPercent + "%)" : "non utilises"),
      "tokens=" + conf0.tokens.map((t) => t.name + (isPlaceholder(t) ? "(vide)" : "")).join(","),
      "upstream=" + UPSTREAM_HOST + ":" + UPSTREAM_PORT);
    // sonde de demarrage : etat reel des quotas sans attendre la 1re vraie reponse
    conf0.tokens.forEach((t, i) => {
      if (t.enabled && !isPlaceholder(t)) setTimeout(() => probeToken(conf0, i), 500 + i * 2000);
    });
    // rafraichissement periodique pour TOUS les comptes -> statusline "live" (voir plus haut)
    const livePollTimer = startLivePolling(conf0);
    if (livePollTimer) log("LIVE POLL actif toutes les " + Math.round((conf0.livePollMs || LIVE_POLL_DEFAULT_MS) / 1000) + "s");
  });
}
