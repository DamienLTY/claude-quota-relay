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

// --- accounts : une fenetre dont le reset est passe est ecoulee -> 0 %, reset ignore (DR-013) ---
// Meme semantique que le routeur (proxy.js: `if (r5 && t0 >= r5) u5 = 0`).
{
  const now = 1_000_000_000;
  const row = (state, name) => lib.accounts(conf, state, now).find((a) => a.name === name);
  // 5h ET 7j passes -> reset null, utilisation 0 (meme quand h5 etait inconnu : comme le routeur)
  let a = row({ pct: { compte1: { h5: 100, d7: 93 } }, reset5h: { compte1: now - 20 * 3600000 }, reset7d: { compte1: now - 1000 } }, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5, a.d7, a.reset7], [0, null, 0, null], "reset5/reset7 passes -> null et h5/d7 = 0");
  a = row({ pct: {}, reset5h: { compte1: now - 1 }, reset7d: { compte1: now - 1 } }, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5, a.d7, a.reset7], [0, null, 0, null], "h5 inconnu mais fenetre echue -> 0 quand meme");
  assert.strictEqual(row({ pct: { compte1: { h5: 100 } }, reset5h: { compte1: now } }, "compte1").h5, 0, "reset == maintenant : echu (>=, comme le routeur)");
  // moitie seulement : 5h echu / 7j futur, puis l'inverse -> chaque moitie est independante
  a = row({ pct: { compte1: { h5: 100, d7: 93 } }, reset5h: { compte1: now - 5 }, reset7d: { compte1: now + 7200000 } }, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5, a.d7, a.reset7], [0, null, 93, now + 7200000], "5h echu : seul le 5h est remis a zero");
  a = row({ pct: { compte1: { h5: 100, d7: 93 } }, reset5h: { compte1: now + 3600000 }, reset7d: { compte1: now - 5 } }, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5, a.d7, a.reset7], [100, now + 3600000, 0, null], "7j echu : seul le 7j est remis a zero");
  // reset futur ou absent : inchange
  a = row({ pct: { compte1: { h5: 40, d7: 12 } }, reset5h: { compte1: now + 1 }, reset7d: { compte1: now + 9e6 } }, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5, a.d7, a.reset7], [40, now + 1, 12, now + 9e6], "resets futurs : inchanges");
  a = row({ pct: { compte1: { h5: 40, d7: 12 } } }, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5, a.d7, a.reset7], [40, undefined, 12, undefined], "resets absents : inchanges (h5/d7 gardes)");
  a = row({}, "compte1");
  assert.deepStrictEqual([a.h5, a.reset5], [undefined, undefined], "etat vide : rien d'invente");
  // deux comptes, un seul perime : l'autre n'est pas touche
  const st = { pct: { compte1: { h5: 100, d7: 93 }, compte2: { h5: 73, d7: 55 } }, reset5h: { compte1: now - 20 * 3600000, compte2: now + 600000 }, reset7d: { compte1: now + 86400000, compte2: now + 86400000 } };
  assert.deepStrictEqual([row(st, "compte1").h5, row(st, "compte1").reset5], [0, null], "le compte perime est remis a zero");
  assert.deepStrictEqual([row(st, "compte2").h5, row(st, "compte2").reset5], [73, now + 600000], "le compte sain garde son 5h et son reset");
  // sans 3e argument : maintenant reel (un reset d'il y a 1 h est echu, un reset dans 1 h ne l'est pas)
  const real = lib.accounts(conf, { pct: { compte1: { h5: 90 }, compte2: { h5: 90 } }, reset5h: { compte1: Date.now() - 3600000, compte2: Date.now() + 3600000 } });
  assert.deepStrictEqual([real[0].h5, real[1].h5], [0, 90], "now par defaut = Date.now()");
  // bestHeadroom (garde de workflow) s'appuie sur accounts : un compte dont la fenetre est echue, SANS cooldown en cours, compte pour 0 %
  assert.strictEqual(lib.bestHeadroom(conf, { pct: { compte1: { h5: 100 }, compte2: { h5: 80 } }, reset5h: { compte1: Date.now() - 1000 } }), 0, "bestHeadroom voit la fenetre echue (sans cooldown) comme libre");
  // ... mais un compte refuse (cooldown en cours) n'est pas libre : le routeur l'exclut, le garde ne doit pas le croire a 0 %
  const stale = { pct: { compte1: { h5: 100 }, compte2: { h5: 70 } }, reset5h: { compte1: Date.now() - 1000 }, exhausted: { compte1: Date.now() + 60000 } };
  assert.strictEqual(lib.bestHeadroom(conf, stale), 70, "reset perime + cooldown en cours : compte pour 100, le compte a 70 % gagne");
  // cooldown echu : le compte redevient libre (0 %)
  assert.strictEqual(lib.bestHeadroom(conf, Object.assign({}, stale, { exhausted: { compte1: Date.now() - 1000 } })), 0, "cooldown echu : fenetre echue -> libre");
  // tous en cooldown : 100 (et non null, que le garde lit comme « inconnu -> laisser passer »)
  const allDown = { pct: { compte1: { h5: 100 }, compte2: { h5: 70 } }, reset5h: { compte1: Date.now() - 1000, compte2: Date.now() - 1000 }, exhausted: { compte1: Date.now() + 60000, compte2: Date.now() + 60000 } };
  assert.strictEqual(lib.bestHeadroom(conf, allDown), 100, "tous les comptes en cooldown : 100, pas null ni 0");
}

console.log("PASS — lib.js: preferredCompactionToken prefers the abandoned account, falls back when it's blocked ; accounts ignore un reset passe (fenetre echue -> 0 %)");
