// Unit tests for the token-reduction helpers (pure, no network). Run: node test/compaction.test.js
const assert = require("assert");
const comp = require("../src/compaction.js");

// --- modelThreshold ---
assert.strictEqual(comp.modelThreshold("claude-opus-4-8", null), 89, "opus -> 89");
assert.strictEqual(comp.modelThreshold("claude-sonnet-5", null), 90, "sonnet -> 90");
assert.strictEqual(comp.modelThreshold("claude-haiku-4-5", null), 95, "haiku -> 95");
assert.strictEqual(comp.modelThreshold("claude-fable-5", null), 85, "fable -> 85");
assert.strictEqual(comp.modelThreshold("something-else", null), 88, "unknown -> default 88");
assert.strictEqual(comp.modelThreshold("claude-opus-4-8", { opus: 70 }), 70, "custom override");
assert.strictEqual(comp.modelThreshold(undefined, null), 88, "no model -> default");

// --- injectNative ---
{
  const body = { model: "x", messages: [] };
  const r = comp.injectNative(body, 10);
  assert.strictEqual(r.added, true, "adds edit on a fresh body");
  const e = body.context_management.edits[0];
  assert.strictEqual(e.type, comp.EDIT_TYPE, "edit type set");
  assert.strictEqual(e.keep.value, 10, "keep value = 10");
  assert.strictEqual(e.trigger.type, "input_tokens", "explicit trigger present");
  assert.strictEqual(e.trigger.value, 2000, "default trigger 2000 (fires below the API's ~100k default)");
}
{
  // explicit trigger override threads through
  const body = { messages: [] };
  comp.injectNative(body, 5, 500);
  assert.strictEqual(body.context_management.edits[0].trigger.value, 500, "custom triggerTokens honored");
}
{
  const body = { context_management: { edits: [{ type: comp.EDIT_TYPE }], foo: 1 } };
  const r = comp.injectNative(body, 5);
  assert.strictEqual(r.added, false, "does not duplicate an existing clear_tool_uses edit");
  assert.strictEqual(body.context_management.foo, 1, "preserves other context_management fields");
  assert.strictEqual(body.context_management.edits.length, 1, "no second edit added");
}
{
  const body = { context_management: { edits: [{ type: "other_edit" }] } };
  const r = comp.injectNative(body, 7);
  assert.strictEqual(r.added, true, "adds alongside a different edit type");
  assert.strictEqual(body.context_management.edits.length, 2, "both edits present");
}

// --- mergeBeta ---
{
  const h = {}; comp.mergeBeta(h);
  assert.strictEqual(h["anthropic-beta"], comp.BETA, "sets beta when absent");
}
{
  const h = { "anthropic-beta": "foo-1,bar-2" }; const changed = comp.mergeBeta(h);
  assert.strictEqual(changed, true, "reports change");
  assert.ok(h["anthropic-beta"].includes("foo-1") && h["anthropic-beta"].includes(comp.BETA), "appends, keeps existing");
}
{
  const h = { "anthropic-beta": comp.BETA }; const changed = comp.mergeBeta(h);
  assert.strictEqual(changed, false, "no duplicate");
  assert.strictEqual(h["anthropic-beta"], comp.BETA, "unchanged");
}

// --- stripOldToolResults ---
{
  const mk = (i) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "BIG RESULT " + i }] });
  const body = { messages: [{ role: "user", content: "hi" }, mk(0), mk(1), mk(2), mk(3), mk(4)] };
  const r = comp.stripOldToolResults(body, 2);
  assert.strictEqual(r.stubbed, 3, "stubs all but the last 2 tool_results");
  // first 3 tool_results stubbed
  assert.ok(String(body.messages[1].content[0].content).startsWith("[resultat"), "old result stubbed");
  // last 2 intact
  assert.strictEqual(body.messages[5].content[0].content, "BIG RESULT 4", "most recent result kept raw");
  assert.strictEqual(body.messages[4].content[0].content, "BIG RESULT 3", "2nd most recent kept raw");
  // tool_use_id preserved on stubbed (keeps request valid)
  assert.strictEqual(body.messages[1].content[0].tool_use_id, "t0", "tool_use_id preserved");
}

// --- modelWeight (relative price vs Haiku -- see claude-api pricing table) ---
assert.strictEqual(comp.modelWeight("claude-haiku-4-5"), 1, "haiku weight 1");
assert.strictEqual(comp.modelWeight("claude-sonnet-5"), 3, "sonnet weight 3");
assert.strictEqual(comp.modelWeight("claude-opus-4-8"), 5, "opus weight 5");
assert.strictEqual(comp.modelWeight("claude-fable-5"), 10, "fable weight 10");
assert.strictEqual(comp.modelWeight("unknown-model"), 3, "unknown -> default weight 3");

// --- estimateTokens (rough, allocation-free; used synchronously in the request path) ---
{
  const empty = comp.estimateTokens({ messages: [] });
  assert.ok(empty <= 1, "no messages -> ~0 tokens: " + empty);
  const small = comp.estimateTokens({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(small > 0 && small < 20, "small message -> small estimate: " + small);
  const bigMsgs = { messages: [{ role: "user", content: "x".repeat(148000 * 3.5) }] };
  const big = comp.estimateTokens(bigMsgs);
  assert.ok(Math.abs(big - 148000) < 2000, "~148000-char content -> ~148000 tokens (3.5 chars/token): " + big);
  assert.ok(comp.estimateTokens(null) <= 1, "null bodyObj -> ~0 (never throws)");
}

// --- dynamicThreshold (grounded in the real calibration: ~148000 haiku tokens = 1 point) ---
{
  const tiny = { messages: [{ role: "user", content: "hi" }] };
  const t = comp.dynamicThreshold("claude-haiku-4-5", tiny);
  assert.ok(t >= 95, "near-empty context -> dynamic threshold near the ceiling (haiku): " + t);
}
{
  // ~148000 haiku tokens -> ~1 point projected jump -> threshold ~= 100 - 1 - 4(buffer) = 95
  const bodyObj = { messages: [{ role: "user", content: "x".repeat(148000 * 3.5) }] };
  const t = comp.dynamicThreshold("claude-haiku-4-5", bodyObj);
  assert.ok(t >= 93 && t <= 96, "full haiku context -> threshold ~95 (measured calibration): " + t);
}
{
  // same context size, but fable weighs 10x haiku -> ~10x the projected jump -> much lower threshold
  const bodyObj = { messages: [{ role: "user", content: "x".repeat(148000 * 3.5) }] };
  const tFable = comp.dynamicThreshold("claude-fable-5", bodyObj);
  const tHaiku = comp.dynamicThreshold("claude-haiku-4-5", bodyObj);
  assert.ok(tFable < tHaiku, "fable (10x weight) needs a lower/earlier threshold than haiku for the same context size");
}
{
  // clamped to a sane range even for a pathologically huge context
  const huge = { messages: [{ role: "user", content: "x".repeat(50_000_000) }] };
  const t = comp.dynamicThreshold("claude-fable-5", huge);
  assert.ok(t >= 50 && t <= 99, "clamped into [50,99]: " + t);
}

// --- effectiveSwitchThreshold : static per-model by DEFAULT; dynamic is opt-in ---
{
  // dynamic OFF (default): always the static per-model threshold, whatever the context size.
  const tiny = { messages: [{ role: "user", content: "hi" }] };
  const huge = { messages: [{ role: "user", content: "x".repeat(50_000_000) }] };
  assert.strictEqual(comp.effectiveSwitchThreshold({ thresholds: {} }, "claude-haiku-4-5", tiny), 95, "default: static 95 for haiku");
  assert.strictEqual(comp.effectiveSwitchThreshold({ thresholds: {} }, "claude-opus-4-8", huge), 89, "default: huge Opus context still switches at the STATIC 89 (no aggressive early switch)");
}
{
  // dynamic ON (opt-in): huge context lowers the effective threshold below static, never above.
  const huge = { messages: [{ role: "user", content: "x".repeat(50_000_000) }] };
  const stat = comp.modelThreshold("claude-fable-5", {});
  const t = comp.effectiveSwitchThreshold({ dynamicThreshold: true, thresholds: {} }, "claude-fable-5", huge);
  assert.ok(t < stat, "dynamic on + huge context: effective threshold drops below static: " + t + " < " + stat);
}
{
  // The exact reported case: Opus with ~829k tokens of context. With dynamic ON it lands ~68%
  // (the "switched at 68% instead of 89%" a user hit); with dynamic OFF it stays at 89%.
  const bigOpus = { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(Math.round(829_000 * 3.5)) }] };
  const withDyn = comp.effectiveSwitchThreshold({ dynamicThreshold: true, thresholds: {} }, "claude-opus-4-8", bigOpus);
  const noDyn = comp.effectiveSwitchThreshold({ thresholds: {} }, "claude-opus-4-8", bigOpus);
  assert.ok(withDyn >= 66 && withDyn <= 70, "dynamic on: ~829k Opus context -> ~68% (got " + withDyn + ")");
  assert.strictEqual(noDyn, 89, "dynamic off (default): same context stays at static 89%");
}

console.log("PASS — compaction.js unit tests (threshold, weight, estimate, dynamic opt-in, injectNative, mergeBeta, stripOldToolResults)");
