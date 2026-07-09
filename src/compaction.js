"use strict";
/* Auto-compaction helpers (proxy side).
 *
 * Goal: when the proxy is about to switch to a fresh account (or resume after a
 * quota wait), shrink the request it sends to that account WITHOUT any
 * summarization model call, so the fresh account's 5h window is spent slowly.
 *
 * Two modes:
 *   - "native" (default): inject Anthropic's context-editing `clear_tool_uses`
 *     edit + beta header. The API drops old tool results server-side (0 token),
 *     keeping the N most recent. Proven: 18830 -> 377 input tokens in tests.
 *   - "strip" (fallback): the proxy itself stubs the content of old tool_result
 *     blocks. The response shape is unchanged, so Claude Code can't choke on it.
 *
 * The persistent per-project memory file (task list + notes) is produced by
 * memory-hook.js on the client side; this module only reduces tokens + flags the
 * switch via a marker in state.json.
 */

const BETA = "context-management-2025-06-27";
const EDIT_TYPE = "clear_tool_uses_20250919";

// Per-model 5h threshold (%) at which we compact before switching. Fable can jump
// 85% -> 100% in one big request, hence the lowest bar; Haiku is cheap, highest bar.
const DEFAULT_THRESHOLDS = { fable: 85, opus: 89, sonnet: 90, haiku: 95, default: 88 };

function modelThreshold(model, thr) {
  const t = Object.assign({}, DEFAULT_THRESHOLDS, thr || {});
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return t.haiku;
  if (m.includes("opus")) return t.opus;
  if (m.includes("sonnet")) return t.sonnet;
  if (m.includes("fable")) return t.fable;
  return t.default;
}

// ----- seuil dynamique, tenant compte du contexte deja rempli -----
// Mesure reelle (labo, juil-2026, vraie API) : ~148 000 tokens d'entree Haiku ont fait
// bouger l'utilisation unifiee 5h de +1 point (11% -> 12%). Le quota "unifie" est partage
// entre tous les modeles d'un compte ; on n'a pas la formule exacte de ponderation
// d'Anthropic, mais le tarif publie par modele (voir skill claude-api) est un proxy
// raisonnable de son "cout" relatif dans ce quota partage.
const HAIKU_TOKENS_PER_POINT = 148000; // mesure reelle : ~148k tokens haiku = +1 point de 5h
// Poids = ratio de prix vs Haiku (Opus $5/$25, Sonnet $3/$15, Haiku $1/$5, Fable $10/$50 par MTok).
const MODEL_WEIGHT = { haiku: 1, sonnet: 3, opus: 5, fable: 10, default: 3 };

function modelWeight(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return MODEL_WEIGHT.haiku;
  if (m.includes("opus")) return MODEL_WEIGHT.opus;
  if (m.includes("sonnet")) return MODEL_WEIGHT.sonnet;
  if (m.includes("fable")) return MODEL_WEIGHT.fable;
  return MODEL_WEIGHT.default;
}

// Estimation rapide (sans appel API, doit rester dans le chemin synchrone de la requete)
// du nombre de tokens du corps de la conversation. ~3.5 caracteres/token : legerement
// PESSIMISTE (surestimer la taille ne fait que rendre le seuil calcule plus prudent).
function estimateTokens(bodyObj) {
  try {
    const json = JSON.stringify((bodyObj && bodyObj.messages) || []);
    return Math.ceil(json.length / 3.5);
  } catch (e) { return 0; }
}

// Seuil de securite dynamique : jusqu'a quel % de 5h peut-on rester sur le compte ACTUEL
// avant qu'il faille imperativement switcher/compacter, etant donne le modele en cours et
// la taille DEJA connue de la conversation (donc de la PROCHAINE requete, puisque Claude
// Code renvoie tout l'historique a chaque fois) ? Plus le contexte est deja rempli, plus le
// saut d'utilisation que provoquerait un futur gros message est important -> il faut
// switcher plus tot. safetyBufferPoints couvre l'appel Haiku de compaction lui-meme
// (negligeable, ~1000 tokens) + l'imprecision de mesure (polling non temps-reel).
function dynamicThreshold(model, bodyObj, opts) {
  const o = opts || {};
  const weight = modelWeight(model);
  const contextTokens = estimateTokens(bodyObj);
  const pointsPerToken = weight / (o.haikuTokensPerPoint || HAIKU_TOKENS_PER_POINT);
  const projectedJump = contextTokens * pointsPerToken;
  const buffer = o.safetyBufferPoints == null ? 4 : o.safetyBufferPoints;
  const t = 100 - projectedJump - buffer;
  return Math.max(50, Math.min(99, Math.round(t)));
}

// Seuil EFFECTIF utilise a la fois par le routage (pickRoute) et la compaction. Par defaut :
// le seuil STATIQUE par modele (Opus 89%, etc.). Le seuil DYNAMIQUE (qui baisse le point de
// bascule quand le contexte est deja tres gros) est OPT-IN (cc.dynamicThreshold === true) car
// il est trop agressif une fois la compaction active : la compaction reduit deja la requete
// envoyee au compte frais, donc pas besoin de switcher aussi tot. Sur un gros contexte Opus
// (~800k tokens) le dynamique tombait a ~68% -> bascule surprenante, signalee par un
// utilisateur. Quand il est active, on prend le plus prudent (le plus bas) des deux.
function effectiveSwitchThreshold(cc, model, bodyObj, opts) {
  const stat = modelThreshold(model, cc && cc.thresholds);
  if (!cc || !cc.dynamicThreshold) return stat;
  const dyn = dynamicThreshold(model, bodyObj, Object.assign({ safetyBufferPoints: cc.dynamicSafetyBufferPoints }, opts));
  return Math.min(stat, dyn);
}

// The context-editing edit that clears old tool results, keeping the N most recent.
// An explicit low `trigger` is important: the API's DEFAULT trigger only fires around
// ~100k input tokens, so a switch below that would clear nothing. We inject this ONLY
// when we've decided to compact, so we want clearing to actually happen.
function buildEdit(keepToolUses, triggerTokens) {
  const keep = Number.isFinite(keepToolUses) ? keepToolUses : 10;
  const trig = Number.isFinite(triggerTokens) ? triggerTokens : 2000;
  return { type: EDIT_TYPE, trigger: { type: "input_tokens", value: trig }, keep: { type: "tool_uses", value: keep } };
}

// Merge our edit into body.context_management without duplicating a clear_tool_uses
// edit Claude Code may already have set. Mutates+returns bodyObj. {added} = did we add.
function injectNative(bodyObj, keepToolUses, triggerTokens) {
  const cm = bodyObj.context_management || {};
  const edits = Array.isArray(cm.edits) ? cm.edits.slice() : [];
  if (edits.some((e) => e && e.type === EDIT_TYPE)) return { body: bodyObj, added: false };
  edits.push(buildEdit(keepToolUses, triggerTokens));
  bodyObj.context_management = Object.assign({}, cm, { edits });
  return { body: bodyObj, added: true };
}

// Append our beta token to anthropic-beta (Node lowercases incoming header keys).
function mergeBeta(headers) {
  const cur = headers["anthropic-beta"];
  if (!cur) { headers["anthropic-beta"] = BETA; return false; }
  const vals = String(cur).split(",").map((s) => s.trim()).filter(Boolean);
  if (vals.includes(BETA)) return false;
  headers["anthropic-beta"] = vals.concat(BETA).join(",");
  return true;
}

// Fallback: stub the content of old tool_result blocks, keeping the last `keep`.
// Only the request is touched -> the response is a normal message, nothing to break.
function stripOldToolResults(bodyObj, keep) {
  const k = Number.isFinite(keep) ? keep : 10;
  const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
  const trIdx = [];
  msgs.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result")) trIdx.push(i); });
  const stubBefore = new Set(trIdx.slice(0, Math.max(0, trIdx.length - k)));
  let stubbed = 0;
  bodyObj.messages = msgs.map((m, i) => {
    if (!stubBefore.has(i)) return m;
    return { role: m.role, content: m.content.map((b) => {
      if (b && b.type === "tool_result") { stubbed++; return { type: "tool_result", tool_use_id: b.tool_use_id, content: "[resultat d'outil compacte -- voir .cqr-memory.md]" }; }
      return b;
    }) };
  });
  return { body: bodyObj, stubbed };
}

module.exports = { BETA, EDIT_TYPE, DEFAULT_THRESHOLDS, MODEL_WEIGHT, HAIKU_TOKENS_PER_POINT, modelThreshold, modelWeight, estimateTokens, dynamicThreshold, effectiveSwitchThreshold, buildEdit, injectNative, mergeBeta, stripOldToolResults };
