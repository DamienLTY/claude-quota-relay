// Unit tests for the proxy's compaction DECISION (deterministic, no network, no server).
// proxy.js exports decideCompaction and only boots the server when run directly.
// Run: node test/proxy-decide.test.js
const assert = require("assert");
const { decideCompaction } = require("../src/proxy.js");

const baseConf = (over) => Object.assign({
  tokens: [{ name: "a" }, { name: "b" }],
  compaction: { enabled: true, thresholds: { fable: 85, opus: 89, sonnet: 90, haiku: 95, default: 88 }, keepToolUses: 10 },
}, over || {});
const stateWith = (h5a) => ({ pct: { a: { h5: h5a }, b: { h5: 40 } } });

// switch, previous account over its per-model threshold -> compact
{
  const d = decideCompaction(baseConf(), stateWith(95), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true);
  assert.ok(d && d.compact, "haiku 95 >= 95 -> compact");
  assert.ok(d.reason.startsWith("switch"), "reason=switch");
  assert.strictEqual(d.dryRun, false, "not dry-run");
  assert.strictEqual(d.mode, "native", "default mode native");
  assert.strictEqual(d.keepToolUses, 10, "keep 10");
}

// switch but under threshold -> no compaction
{
  const d = decideCompaction(baseConf(), stateWith(90), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true);
  assert.strictEqual(d, null, "haiku 90 < 95 -> no compaction");
}

// per-model: opus threshold 89
{
  assert.ok(decideCompaction(baseConf(), stateWith(89), { model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true), "opus 89 >= 89 -> compact");
  assert.strictEqual(decideCompaction(baseConf(), stateWith(88), { model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true), null, "opus 88 < 89 -> no compact");
}

// resume path: no switch, ctx.resumed set -> compact, and flag is consumed
{
  const ctx = { resumed: true };
  const d = decideCompaction(baseConf(), stateWith(40), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 1, 1, ctx, false);
  assert.ok(d && d.reason === "resume", "resume -> compact regardless of threshold");
  assert.strictEqual(ctx.resumed, false, "resumed flag consumed");
}

// disabled entirely -> null
{
  const d = decideCompaction(baseConf({ compaction: { enabled: false } }), stateWith(99), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true);
  assert.strictEqual(d, null, "compaction disabled -> null");
}

// dry-run only (enabled:false, dryRun:true) -> compact but dryRun true
{
  const d = decideCompaction(baseConf({ compaction: { enabled: false, dryRun: true, thresholds: {} } }), stateWith(99), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true);
  assert.ok(d && d.compact, "dry-run still decides to compact");
  assert.strictEqual(d.dryRun, true, "dryRun flagged");
}

// mode strip respected
{
  const d = decideCompaction(baseConf({ compaction: { enabled: true, mode: "strip", thresholds: {}, keepToolUses: 3 } }), stateWith(99), { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true);
  assert.strictEqual(d.mode, "strip", "strip mode carried");
  assert.strictEqual(d.keepToolUses, 3, "custom keep carried");
}

// no previous utilization known -> no compaction on switch
{
  const d = decideCompaction(baseConf(), { pct: {} }, { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }, 0, 1, { resumed: false }, true);
  assert.strictEqual(d, null, "unknown prev utilization -> no compaction");
}

// body without a messages array (count_tokens etc.) -> never compacted
{
  const d = decideCompaction(baseConf(), stateWith(99), { model: "claude-haiku-4-5" }, 0, 1, { resumed: false }, true);
  assert.strictEqual(d, null, "no messages[] -> no compaction");
}

console.log("PASS — proxy decideCompaction: switch/threshold/resume/dry-run/strip/disabled");
