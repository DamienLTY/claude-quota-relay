// Unit tests for the proxy's compaction DECISION (deterministic, no network, no server).
// proxy.js exports decideCompaction and only boots the server when run directly.
// Run: node test/proxy-decide.test.js
const assert = require("assert");
const { decideCompaction, pickRoute, noteOverload, overloadActive, clearOverload } = require("../src/proxy.js");

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

// --- pickRoute : model-aware effective threshold, fixes the switchAtPercent vs
// per-model-compaction-threshold misalignment (haiku 95% was unreachable when
// switchAtPercent=94%; this closes that gap without touching non-compaction users) ---
const twoTokens = (h5a, h5b) => ({
  tokens: [{ name: "a", token: "sk-ant-oat01-fake-a", enabled: true }, { name: "b", token: "sk-ant-oat01-fake-b", enabled: true }],
  switchAtPercent: 94, sevenDayBlockPercent: 99, waitAtSoftPercent: null,
  compaction: { enabled: true, thresholds: {} },
});
const rState = (h5a, h5b) => ({ activeIndex: 0, exhausted: {}, pct: { a: { h5: h5a }, b: { h5: h5b } }, reset5h: {}, reset7d: {} });

{
  // haiku: static threshold (95) > switchAtPercent (94) -> at 94.x%, a plain global switch
  // would already have moved away, but with model-awareness pickRoute keeps hysteresis a
  // bit longer (up to ~95%) since haiku is cheap and dynamic context here is tiny.
  const conf = twoTokens();
  const st = rState(94.5, 40);
  const body = { model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] };
  const route = pickRoute(conf, st, body);
  assert.strictEqual(route.idx, 0, "haiku @94.5% with small context: effective threshold ~95 -> stays on 'a' (hysteresis)");
}
{
  // fable: static threshold (85) < switchAtPercent (94) -> switches EARLIER than the old
  // flat 94% would have, giving Fable (biggest single-request risk) more safety margin.
  const conf = twoTokens();
  const st = rState(90, 40);
  const body = { model: "claude-fable-5", messages: [{ role: "user", content: "x" }] };
  const route = pickRoute(conf, st, body);
  assert.strictEqual(route.idx, 1, "fable @90%: switches away well before the old flat 94% threshold");
}
{
  // pickRoute ALWAYS switches at the STATIC per-model threshold now (89% Opus), whether or not
  // dynamic is on -- the reported "switched at 68% instead of 89%" is fixed: a huge Opus context
  // no longer causes an early SWITCH. (The dynamic effect moved to in-place compaction below.)
  const bigOpus = { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(Math.round(829_000 * 3.5)) }] };
  const off = twoTokens();                                              // dynamic off
  const on = twoTokens(); on.compaction = { enabled: true, dynamicThreshold: true, thresholds: {} }; // dynamic on
  assert.strictEqual(pickRoute(off, rState(68, 40), bigOpus).idx, 0, "dynamic off: Opus @68% huge context STAYS (static 89)");
  assert.strictEqual(pickRoute(on,  rState(68, 40), bigOpus).idx, 0, "dynamic on: Opus @68% huge context STILL stays (no early switch anymore)");
  assert.strictEqual(pickRoute(off, rState(90, 40), bigOpus).idx, 1, "Opus @90% (>=89) switches either way");
}
{
  // Task 3: dynamic ON triggers IN-PLACE compaction on the SAME account (no switch) when the
  // context is big and the current account is between the dynamic point (~68%) and the static
  // switch threshold (89%). from==to (newIdx===prevActive), inPlace flag set, no memory marker.
  const conf = twoTokens(); conf.compaction = { enabled: true, dynamicThreshold: true, mode: "native", thresholds: {} };
  const bigOpus = { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(Math.round(829_000 * 3.5)) }] };
  const d = decideCompaction(conf, rState(75, 40), bigOpus, 0, 0, { resumed: false }, false); // not switching
  assert.ok(d && d.compact && d.inPlace, "dynamic on, big context, current @75%: compacts IN PLACE without switching");
  assert.ok(d.reason.startsWith("dynamic-inplace"), "reason marks in-place: " + d.reason);
}
{
  // dynamic OFF: same situation -> NO in-place compaction (only switch/resume compacts).
  const conf = twoTokens(); // dynamic off
  const bigOpus = { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(Math.round(829_000 * 3.5)) }] };
  const d = decideCompaction(conf, rState(75, 40), bigOpus, 0, 0, { resumed: false }, false);
  assert.strictEqual(d, null, "dynamic off: no in-place compaction");
}
{
  // in-place only BELOW the static switch threshold; at/above it, the normal switch+compact path
  // takes over (so we don't in-place-compact when we should be switching).
  const conf = twoTokens(); conf.compaction = { enabled: true, dynamicThreshold: true, mode: "native", thresholds: {} };
  const bigOpus = { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(Math.round(829_000 * 3.5)) }] };
  const d = decideCompaction(conf, rState(92, 40), bigOpus, 0, 0, { resumed: false }, false);
  assert.strictEqual(d, null, "current @92% (>=89 static) is not in-place territory -- switching handles it");
}
{
  // compaction disabled entirely -> behavior is EXACTLY the old flat switchAtPercent (94%),
  // zero change for installs that don't use the compaction feature.
  const conf = twoTokens(); conf.compaction = { enabled: false, dryRun: false };
  const st = rState(90, 40); // 90 < 94 -> hysteresis keeps 'a' under the OLD flat rule
  const body = { model: "claude-fable-5", messages: [{ role: "user", content: "x" }] };
  const route = pickRoute(conf, st, body);
  assert.strictEqual(route.idx, 0, "compaction off: unaffected by model, uses flat switchAtPercent (94) unchanged");
}
{
  // no model on the request body (e.g. an endpoint without one) -> falls back to flat switchAtPercent
  const conf = twoTokens();
  const st = rState(90, 40);
  const route = pickRoute(conf, st, { messages: [{ role: "user", content: "x" }] });
  assert.strictEqual(route.idx, 0, "no model known: falls back to flat switchAtPercent (94)");
}

// --- reserve de compaction : compaction ON ne route/ride JAMAIS au-dela de RESERVE_CEILING (97%),
// meme si waitAtSoftPercent=null (=utiliser la marge jusqu'au rejet). Garantit que la requete
// compactee arrive sur un compte qui l'accepte (sinon 429 -> compaction perdue avec la requete). ---
const { COMPACTION_RESERVE_CEILING } = require("../src/compaction.js");
assert.strictEqual(COMPACTION_RESERVE_CEILING, 97, "plafond de reserve = 97%");
const bigBody = { model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] };
{
  // les deux comptes au plafond (>=97) -> ATTENTE (aucune cible), pas de ping-pong de 429
  const route = pickRoute(twoTokens(), rState(98, 99), bigBody);
  assert.ok(route.wait, "compaction on: deux comptes >=97% -> attente (reserve), pas de route qui rejetterait");
}
{
  // un compte au plafond, l'autre frais -> route vers le frais (la compaction y atterrit proprement)
  const route = pickRoute(twoTokens(), rState(98, 50), bigBody);
  assert.strictEqual(route.idx, 1, "compaction on: compte a 98% exclu -> route vers le frais (50%)");
}
{
  // juste SOUS le plafond (96 < 97) : encore utilisable (la reserve ne bride pas trop tot)
  const route = pickRoute(twoTokens(), rState(96, 99), bigBody);
  assert.strictEqual(route.idx, 0, "96% < plafond -> encore routable");
}
{
  // compaction OFF : waitAtSoftPercent=null ride jusqu'au rejet -> a 98% on ROUTE (aucune reserve).
  const conf = twoTokens(); conf.compaction = { enabled: false };
  const route = pickRoute(conf, rState(98, 99), bigBody);
  assert.ok(!route.wait && route.idx != null, "compaction off: pas de reserve, ride jusqu'a 100%");
}
{
  // dry-run ne doit PAS modifier le routage (reserve gated sur enabled, pas dryRun)
  const conf = twoTokens(); conf.compaction = { enabled: false, dryRun: true };
  const route = pickRoute(conf, rState(98, 99), bigBody);
  assert.ok(!route.wait && route.idx != null, "dry-run: pas de reserve (routage inchange)");
}

// --- credits d'usage supplementaire (extra usage / overage) ---
// Anthropic SERT la requete quand le forfait est epuise si le compte a des credits : la reponse
// est un 200 avec unified-status:rejected ET overage-status:allowed. Le relais doit (1) ne pas
// mettre ce compte en quarantaine, (2) pouvoir router dessus plutot que d'attendre -- mais
// seulement si l'utilisateur l'a autorise, et jamais avant d'avoir epuise le forfait gratuit.
const { readQuotaHeaders } = require("../src/proxy.js");
const lib = require("../src/lib.js");
{
  const q = readQuotaHeaders({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "anthropic-ratelimit-unified-7d-utilization": "0.62",
    "anthropic-ratelimit-unified-overage-status": "allowed",
    "anthropic-ratelimit-unified-overage-utilization": "0.07",
    "anthropic-ratelimit-unified-overage-reset": "1785542400",
    "anthropic-ratelimit-unified-overage-in-use": "true",
  });
  assert.strictEqual(q.ovAllowed, true, "overage-status allowed -> credits utilisables");
  assert.strictEqual(q.ovU, 7, "overage-utilization 0.07 -> 7%");
  assert.strictEqual(q.ovInUse, true, "overage-in-use lu");
  assert.strictEqual(q.ovReset, 1785542400000, "overage-reset en ms");
  assert.ok(q.statuses.indexOf("rejected") >= 0, "le forfait est bien annonce epuise");
}
{
  const q = readQuotaHeaders({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  });
  assert.strictEqual(q.ovAllowed, false, "overage rejected -> pas de credits");
  assert.strictEqual(q.ovReason, "org_level_disabled", "raison conservee");
  assert.ok(/claude\.ai\/settings\/usage/.test(lib.overageReasonFr(q.ovReason)), "raison traduite avec la marche a suivre");
}
{ // en-tetes sans aucun champ overage (ancienne reponse) -> tout null, rien ne casse
  const q = readQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" });
  assert.strictEqual(q.ovStatus, null);
  assert.strictEqual(q.ovAllowed, false);
  assert.strictEqual(q.ovU, null);
}

// pickRoute : palier credits
const ovState = (h5a, h5b, ovA, ovB) => ({
  activeIndex: 0, exhausted: {}, pct: { a: { h5: h5a, d7: 0 }, b: { h5: h5b, d7: 0 } },
  reset5h: { a: Date.now() + 3600000, b: Date.now() + 7200000 }, reset7d: {},
  overage: Object.assign({}, ovA ? { a: ovA } : null, ovB ? { b: ovB } : null),
});
const ALLOWED = { status: "allowed", u: 0 };
{
  // credits NON autorises (defaut) : comportement strictement inchange -> on attend
  const conf = twoTokens(); // compaction ON (defaut) -> plafond 97% : a 100% aucun compte n'est "frais"
  const route = pickRoute(conf, ovState(100, 100, ALLOWED, ALLOWED), bigBody);
  assert.ok(route.wait, "credits off (defaut) : on attend le reset, jamais de depense");
}
{
  // credits autorises : plutot que d'attendre, on route sur le compte qui a des credits
  const conf = twoTokens(); conf.overage = { use: true, maxPercent: 100 };
  const route = pickRoute(conf, ovState(100, 100, null, ALLOWED), bigBody);
  assert.ok(!route.wait, "credits on : ne doit plus attendre");
  assert.strictEqual(route.idx, 1, "route vers le compte qui a des credits");
  assert.strictEqual(route.overage, true, "marque le routage 'credits'");
}
{
  // jamais de credits tant qu'un compte a du forfait gratuit
  const conf = twoTokens(); conf.overage = { use: true };
  const route = pickRoute(conf, ovState(100, 30, ALLOWED, ALLOWED), bigBody);
  assert.strictEqual(route.idx, 1, "forfait dispo -> on l'utilise, pas les credits");
  assert.ok(!route.overage, "pas marque credits");
}
{
  // quota HEBDOMADAIRE epuise sur les deux comptes : sans credits on attend des JOURS ; avec
  // credits on continue (c'est le cas que l'utilisateur voulait couvrir).
  const conf = twoTokens(); conf.overage = { use: true };
  const st = ovState(20, 20, null, ALLOWED);
  st.pct.a.d7 = 100; st.pct.b.d7 = 100;
  st.reset7d = { a: Date.now() + 4 * 86400000, b: Date.now() + 5 * 86400000 };
  const without = pickRoute(Object.assign({}, conf, { overage: { use: false } }), st, bigBody);
  assert.ok(without.wait && without.reason === "7d", "sans credits : attente du reset hebdo");
  const route = pickRoute(conf, st, bigBody);
  assert.strictEqual(route.idx, 1, "avec credits : le blocage 7j est franchi sur le compte qui en a");
  assert.strictEqual(route.overage, true, "marque credits");
}
{
  // plafond de credits atteint -> on retombe sur l'attente (l'utilisateur garde la main)
  const conf = twoTokens(); conf.overage = { use: true, maxPercent: 50 };
  const route = pickRoute(conf, ovState(100, 100, null, { status: "allowed", u: 50 }), bigBody);
  assert.ok(route.wait, "credits a 50% avec plafond 50% -> attente");
  assert.ok(!pickRoute(conf, ovState(100, 100, null, { status: "allowed", u: 49 }), bigBody).wait, "49% < 50% -> encore utilisable");
}
{
  // un VRAI 429 (credits epuises cote serveur, plafond de depense...) met le compte en cooldown :
  // le palier credits ne doit pas le contourner, sinon boucle de rejets.
  const conf = twoTokens(); conf.overage = { use: true };
  const st = ovState(100, 100, null, ALLOWED);
  st.exhausted = { b: Date.now() + 600000 };
  assert.ok(pickRoute(conf, st, bigBody).wait, "compte en cooldown apres 429 : exclu meme avec credits");
}
{
  // credits refuses par l'API (usage supplementaire desactive sur le compte) -> attente
  const conf = twoTokens(); conf.overage = { use: true };
  const route = pickRoute(conf, ovState(100, 100, { status: "rejected", reason: "org_level_disabled" }, { status: "rejected", reason: "out_of_credits" }), bigBody);
  assert.ok(route.wait, "aucun credit utilisable -> attente (comportement d'origine)");
}

// --- surcharge Anthropic (529) : la pause s'allonge et la sonde ne la leve pas ---
// Cas reel du 29/07/2026 : 529 -> pause 90 s -> la sonde (8 tokens) passe -> "deblocage
// anticipe" -> on relache la vraie requete -> 529 ... en boucle toutes les 45 s.
{
  const T = 1000000000000; // horloge figee (les fonctions acceptent un temps injecte)
  const st = {};
  const u1 = noteOverload(st, "a", T);
  assert.strictEqual(u1 - T, 90000, "1er 529 : 90 s (inchange)");
  const u2 = noteOverload(st, "a", T + 1000);
  assert.strictEqual(u2 - (T + 1000), 180000, "2e 529 d'affilee : 3 min");
  const u3 = noteOverload(st, "a", T + 2000);
  assert.strictEqual(u3 - (T + 2000), 360000, "3e : 6 min");
  noteOverload(st, "a", T + 3000); noteOverload(st, "a", T + 4000);
  const u6 = noteOverload(st, "a", T + 5000);
  assert.strictEqual(u6 - (T + 5000), 600000, "plafonne a 10 min (on n'attend jamais indefiniment)");

  // la sonde qui passe ne doit pas lever une pause de surcharge encore active
  assert.strictEqual(overloadActive(st, "a", T + 6000), true, "surcharge encore active -> pause maintenue");
  assert.strictEqual(overloadActive(st, "b", T + 6000), false, "l'autre compte n'est pas concerne");
  assert.strictEqual(overloadActive(st, "a", T + 700000), false, "pause expiree -> la sonde peut de nouveau debloquer");

  // 10 min sans 529 = surcharge passee : le compteur repart de zero (pas de punition a vie)
  const u7 = noteOverload(st, "a", T + 5000 + 10 * 60 * 1000 + 1);
  assert.strictEqual(u7 - (T + 5000 + 10 * 60 * 1000 + 1), 90000, "apres 10 min sans 529 : retour a 90 s");

  // une vraie reponse servie efface tout
  clearOverload(st, "a");
  assert.strictEqual(overloadActive(st, "a", T), false, "reponse servie -> plus aucune pause de surcharge");
  clearOverload(st, "inconnu"); // ne doit pas planter
}

console.log("PASS — proxy decideCompaction: switch/threshold/resume/dry-run/strip/disabled/cooldown + pickRoute model-aware threshold + reserve ceiling + credits (overage) + backoff surcharge 529");
