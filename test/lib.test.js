// Unit tests for src/lib.js helpers not covered elsewhere (no network). Run: node test/lib.test.js
const assert = require("assert");
const lib = require("../src/lib.js");

const conf = {
  tokens: [
    { name: "compte1", token: "sk-ant-oat01-fake1", enabled: true },
    { name: "compte2", token: "sk-ant-oat01-fake2", enabled: true },
  ],
};

// --- preferredCompactionToken : spend the OLD account's leftover margin, not the fresh one's ---
{
  // 'from' account (compte1) still has margin, not blocked -> preferred even though compte2 is fresher
  const state = { pct: { compte1: { h5: 90 }, compte2: { h5: 20 } }, exhausted: {} };
  const t = lib.preferredCompactionToken(conf, state, "compte1");
  assert.strictEqual(t.name, "compte1", "prefers the just-abandoned account when it still has margin");
}
{
  // 'from' account is currently blocked (exhausted, in the future) -> falls back to freshest
  const state = { pct: { compte1: { h5: 99 }, compte2: { h5: 20 } }, exhausted: { compte1: Date.now() + 60000 } };
  const t = lib.preferredCompactionToken(conf, state, "compte1");
  assert.strictEqual(t.name, "compte2", "falls back to freshest when the old account is actually exhausted");
}
{
  // exhausted entry in the past (already expired) -> old account usable again, preferred
  const state = { pct: { compte1: { h5: 99 }, compte2: { h5: 20 } }, exhausted: { compte1: Date.now() - 1000 } };
  const t = lib.preferredCompactionToken(conf, state, "compte1");
  assert.strictEqual(t.name, "compte1", "expired exhaustion entry -> old account usable again");
}
{
  // no 'from' given -> behaves exactly like healthiestToken (freshest)
  const state = { pct: { compte1: { h5: 90 }, compte2: { h5: 20 } }, exhausted: {} };
  const t = lib.preferredCompactionToken(conf, state, null);
  assert.strictEqual(t.name, "compte2", "no preferred name -> freshest account");
}
{
  // 'from' names an unknown/disabled account -> falls back to freshest
  const state = { pct: { compte1: { h5: 90 }, compte2: { h5: 20 } }, exhausted: {} };
  const t = lib.preferredCompactionToken(conf, state, "does-not-exist");
  assert.strictEqual(t.name, "compte2", "unknown preferred name -> falls back to freshest");
}

console.log("PASS — lib.js: preferredCompactionToken prefers the abandoned account, falls back when it's blocked");
