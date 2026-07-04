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

module.exports = { BETA, EDIT_TYPE, DEFAULT_THRESHOLDS, modelThreshold, buildEdit, injectNative, mergeBeta, stripOldToolResults };
