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

console.log("PASS — compaction.js unit tests (threshold, injectNative, mergeBeta, stripOldToolResults)");
