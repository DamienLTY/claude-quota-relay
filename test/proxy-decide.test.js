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

// --- cooldown : evite le ping-pong "compte1<->compte2 tous deux chauds -> recompacte a chaque
// requete" que l'utilisateur a repere par le calcul avant d'activer la compaction ---
const body = { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] };
{
  const st = stateWith(95); // pas de lastCompactAt -> 1ere decision jamais bloquee
  const d = decideCompaction(baseConf(), st, body, 0, 1, { resumed: false }, true);
  assert.ok(d && d.compact, "1ere compaction (pas de cooldown actif) -> compacte");
}
{
  const st = Object.assign(stateWith(96), { lastCompactAt: Date.now() - 1000 }); // compacte il y a 1s
  const d = decideCompaction(baseConf(), st, body, 0, 1, { resumed: false }, true);
  assert.strictEqual(d, null, "ping-pong immediat (1s apres) -> bloque par le cooldown (defaut 10min)");
}
{
  // resume path doit AUSSI respecter le cooldown (pas de contournement via ctx.resumed)
  const st = Object.assign(stateWith(40), { lastCompactAt: Date.now() - 1000 });
  const d = decideCompaction(baseConf(), st, body, 1, 1, { resumed: true }, false);
  assert.strictEqual(d, null, "resume trop proche d'une compaction recente -> bloque aussi");
}
{
  const st = Object.assign(stateWith(97), { lastCompactAt: Date.now() - 700000 }); // 700s > 600s (defaut)
  const d = decideCompaction(baseConf(), st, body, 0, 1, { resumed: false }, true);
  assert.ok(d && d.compact, "cooldown ecoule (700s > 600s par defaut) -> recompacte");
}
{
  const conf = baseConf({ compaction: { enabled: true, thresholds: { haiku: 95 }, compactionCooldownMs: 0 } });
  const st = Object.assign(stateWith(96), { lastCompactAt: Date.now() - 500 });
  const d = decideCompaction(conf, st, body, 0, 1, { resumed: false }, true);
  assert.ok(d && d.compact, "compactionCooldownMs=0 desactive le garde-fou -> compacte a chaque fois");
}
{
  // le cooldown s'applique pareil en dry-run (les logs doivent refleter ce qui se passerait pour de vrai)
  const conf = baseConf({ compaction: { enabled: false, dryRun: true, thresholds: { haiku: 95 } } });
  const st = Object.assign(stateWith(96), { lastCompactAt: Date.now() - 1000 });
  const d = decideCompaction(conf, st, body, 0, 1, { resumed: false }, true);
  assert.strictEqual(d, null, "cooldown applique aussi en dry-run (logs representatifs)");
}

console.log("PASS — proxy decideCompaction: switch/threshold/resume/dry-run/strip/disabled/cooldown");
