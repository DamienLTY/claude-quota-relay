// Tests for the compact status line (no network). Run: node test/statusline.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");
const lib = require("../src/lib.js");

const SCRIPT = p.join(__dirname, "..", "src", "cqr-statusline.js");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, ""); // remove ANSI colors

// fmtDur shape (used by cqr preflight)
assert.strictEqual(lib.fmtDur(null), "?", "unknown -> ?");
assert.ok(/^\d+min$/.test(lib.fmtDur(Date.now() + 30 * 60000)), "30min -> Nmin");
assert.ok(/^\dh\d\dmin$/.test(lib.fmtDur(Date.now() + 65 * 60000)), ">1h -> XhYYmin");
assert.ok(/^\dj\d\dh$/.test(lib.fmtDur(Date.now() + (4 * 24 + 9) * 3600000)), ">24h -> XjYYh");

function setup(statusline, over) {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-sl-"));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify(Object.assign({ tokens: [
    { name: "compte1", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000", enabled: true },
    { name: "compte2", token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000001", enabled: true },
  ] }, (over || {}).conf)));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify(Object.assign({
    pct: { compte1: { h5: 40, d7: 12 }, compte2: { h5: 73, d7: 55 } },
    reset5h: { compte1: Date.now() + 65 * 60000, compte2: Date.now() + 20 * 60000 },
    reset7d: { compte1: Date.now() + 3 * 3600000, compte2: Date.now() + 5 * 3600000 },
  }, (over || {}).state)));
  fs.writeFileSync(p.join(DIR, "statusline.json"), JSON.stringify(statusline));
  return DIR;
}
const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + "h" + String(d.getMinutes()).padStart(2, "0"); };
function run(DIR) {
  return cp.spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ session_id: "x", model: { id: "claude-opus-4-8" } }), env: Object.assign({}, process.env, { CQR_DIR: DIR }), encoding: "utf8" }).stdout;
}

// Case A: reset en tete (avec le compte concerne), puis UN BLOC PAR COMPTE (5h a gauche, 7j a
// droite). L'ancienne barre 5h cumulee sur toute la flotte est supprimee : des 3 comptes, elle
// empechait de savoir qui avait consomme quoi.
{
  const out = strip(run(setup({ original: null })));
  assert.ok(out.startsWith("↻ "), "commence par l'heure du prochain reset: " + out);
  assert.ok(/^↻ \d\dh\d\d ②/.test(out), "l'heure est suivie du compte qui repart (ici ②, reset le plus proche): " + out);
  assert.ok(out.includes("① 5h/40%") && out.includes("② 5h/73%"), "chaque compte affiche SON 5h: " + out);
  assert.ok(out.includes("7J/12%") && out.includes("7J/55%"), "chaque compte affiche SON 7j");
  assert.ok(out.includes("█"), "has progress bars");
  assert.ok(!/57%/.test(out), "plus de moyenne de flotte (illisible a 3 comptes)");
  assert.ok(!/Reset à/.test(out), "no verbose 'Reset à' text");
}

// Case A2: couleur du NUMERO = etat du compte, sans avoir a lire les chiffres.
// VERT = actif avec du quota / JAUNE = en reserve / ORANGE = 5h fini mais la semaine tient /
// ROUGE = ni 5h ni 7j.
{
  const base = { reset5h: { compte1: Date.now() + 65 * 60000, compte2: Date.now() + 20 * 60000 }, reset7d: { compte1: Date.now() + 3 * 3600000, compte2: Date.now() + 5 * 3600000 } };
  const st = (pct, activeIndex) => Object.assign({ activeIndex: activeIndex || 0, pct }, base);
  const ok = run(setup({ original: null }, { state: st({ compte1: { h5: 40, d7: 12 }, compte2: { h5: 73, d7: 55 } }) }));
  assert.ok(/\x1b\[32m①/.test(ok), "compte actif avec du quota -> numero VERT: " + ok);
  assert.ok(/\x1b\[33m②/.test(ok), "compte en reserve avec du quota -> numero JAUNE");
  const dry5 = run(setup({ original: null }, { state: st({ compte1: { h5: 40, d7: 12 }, compte2: { h5: 100, d7: 55 } }) }));
  assert.ok(/\x1b\[38;5;208m②/.test(dry5), "5h epuise mais quota hebdo restant -> numero ORANGE: " + dry5);
  const dry7 = run(setup({ original: null }, { state: st({ compte1: { h5: 40, d7: 12 }, compte2: { h5: 100, d7: 100 } }) }));
  assert.ok(/\x1b\[31m②/.test(dry7), "ni 5h ni 7j -> numero ROUGE: " + dry7);
  // plusieurs comptes qui repartent a la meme minute -> ils sont tous listes derriere l'heure
  const same = Date.now() + 30 * 60000;
  const both = strip(run(setup({ original: null }, { state: Object.assign({}, st({ compte1: { h5: 40, d7: 12 }, compte2: { h5: 73, d7: 55 } }), { reset5h: { compte1: same, compte2: same + 900 } }) })));
  assert.ok(/^↻ \d\dh\d\d ① ②/.test(both), "meme heure de reset -> les deux numeros: " + both);
}

// Case B: wrapped -> original kept as prefix, ours after " │ "
{
  const out = strip(run(setup({ original: { type: "command", command: "echo MYLINE" } })));
  assert.ok(out.startsWith("MYLINE │ ↻ "), "original prefix kept then ours: " + out);
}

// Case C: un compte a 100% de quota HEBDO -> son reset 5h ne veut plus rien dire (il ne
// redeviendra pas utilisable). L'heure affichee doit etre celle de l'AUTRE compte.
{
  const r5a = Date.now() + 65 * 60000, r5b = Date.now() + 20 * 60000;
  const out = strip(run(setup({ original: null }, { state: {
    pct: { compte1: { h5: 40, d7: 12 }, compte2: { h5: 73, d7: 100 } }, // compte2 : semaine finie
    reset5h: { compte1: r5a, compte2: r5b },                            // mais reset 5h plus proche
    reset7d: { compte1: Date.now() + 3 * 3600000, compte2: Date.now() + 5 * 3600000 },
  } })));
  assert.ok(out.includes("↻ " + hhmm(r5a)), "affiche le reset du compte qui a encore du quota hebdo: " + out);
  assert.ok(!out.includes(hhmm(r5b)), "n'affiche PAS le reset 5h du compte a 100% de 7j");
}

// Case D: AUCUN compte n'a de quota hebdo -> on affiche le reset HEBDO le plus proche, marque 7j
// et date (il peut tomber dans plusieurs jours, l'heure seule serait ambigue).
{
  const r7a = Date.now() + 4 * 86400000, r7b = Date.now() + 2 * 86400000;
  const out = strip(run(setup({ original: null }, { state: {
    pct: { compte1: { h5: 90, d7: 100 }, compte2: { h5: 73, d7: 99 } },
    reset5h: { compte1: Date.now() + 65 * 60000, compte2: Date.now() + 20 * 60000 },
    reset7d: { compte1: r7a, compte2: r7b },
  } })));
  assert.ok(/↻7j/.test(out), "marque explicitement que l'attente est hebdomadaire: " + out);
  assert.ok(out.includes(hhmm(r7b)), "affiche le reset hebdo le PLUS PROCHE (compte2)");
  assert.ok(/↻7j (dim|lun|mar|mer|jeu|ven|sam) \d\dh\d\d/.test(out), "reset hebdo date (jour + heure)");
}

// Case E: pastille credits -- rien tant qu'ils ne sont pas autorises ; puis TROIS etats sur le
// compte ACTIF : VERT plein = servi sur les credits, JAUNE demi = credits disponibles mais pas
// encore utilises, ROUGE creux = plus rien d'utilisable. Sans les 3 etats, "57 EUR prets a
// servir" et "compte a sec" affichaient le meme rond rouge. Aucun pourcentage, aucun montant
// (l'API les refuse a nos cles). La FORME porte l'info, la couleur la double.
{
  const st = { activeIndex: 0, overage: { compte1: { status: "allowed", u: 8, onCredits: false }, compte2: { status: "allowed", u: 0, onCredits: true } } };
  assert.ok(!/crédits /.test(strip(run(setup({ original: null }, { state: st })))), "credits non autorises -> aucune pastille");
  const conf = { overage: { use: true, maxPercent: 100 } };
  // compte actif sur le forfait MAIS credits disponibles -> jaune, demi-pastille
  const ready = run(setup({ original: null }, { state: st, conf }));
  assert.ok(/\x1b\[33mcrédits ◐/.test(ready), "credits disponibles non utilises -> pastille JAUNE et demi: " + ready);
  assert.ok(!/\d+\s*%/.test(strip(ready).split("│").pop()), "aucun pourcentage dans le segment credits");
  // le compte actif (index 1) est servi sur les credits -> vert
  const green = run(setup({ original: null }, { state: Object.assign({}, st, { activeIndex: 1 }), conf }));
  assert.ok(/\x1b\[32mcrédits ●/.test(green), "compte actif sur les credits -> pastille VERTE et pleine");
  // overage-in-use suffit aussi (autre signal renvoye par l'API)
  const green2 = run(setup({ original: null }, { state: { activeIndex: 0, overage: { compte1: { status: "allowed", inUse: true } } }, conf }));
  assert.ok(/\x1b\[32mcrédits ●/.test(green2), "overage-in-use:true -> pastille VERTE aussi");
  // plus aucun credit utilisable (cas reel : out_of_credits) -> rouge, creux
  const dry = run(setup({ original: null }, { state: { activeIndex: 0, overage: { compte1: { status: "rejected", reason: "out_of_credits" } } }, conf }));
  assert.ok(/\x1b\[31mcrédits ○/.test(dry), "aucun credit utilisable -> pastille ROUGE et creuse: " + dry);
  // plafond atteint = plus utilisable non plus (l'utilisateur a limite la depense)
  const capped = run(setup({ original: null }, { state: { activeIndex: 0, overage: { compte1: { status: "allowed", u: 60 } } }, conf: { overage: { use: true, maxPercent: 50 } } }));
  assert.ok(/\x1b\[31mcrédits ○/.test(capped), "au-dela du plafond cqr credits max -> rouge (on n'y touchera pas)");
  // sans couleur (NO_COLOR), la FORME porte encore l'information
  const DIRp = setup({ original: null }, { state: st, conf });
  const plain = cp.spawnSync(process.execPath, [SCRIPT], { input: "{}", env: Object.assign({}, process.env, { CQR_DIR: DIRp, NO_COLOR: "1" }), encoding: "utf8" }).stdout;
  assert.ok(/crédits ◐/.test(plain) && !/\x1b\[/.test(plain), "NO_COLOR : les 3 formes restent distinctes sans couleur: " + plain);
}

// lib : conversion % -> argent (l'API ne donne pas le montant a nos tokens, l'utilisateur le saisit)
{
  assert.strictEqual(lib.fmtMoney(18.4, "EUR"), "18,40 €");
  assert.strictEqual(lib.fmtMoney(7, "USD"), "7,00 $");
  assert.strictEqual(lib.fmtMoney(3.5, null), "3,50 $", "devise par defaut USD");
  assert.strictEqual(lib.creditsRemaining({ uRaw: 0.25 }, { budget: 40 }, "x"), 30, "40 - 25% = 30");
  assert.strictEqual(lib.creditsRemaining({ u: 25 }, { budget: 40 }, "x"), 30, "repli sur le % entier si pas de fraction brute");
  assert.strictEqual(lib.creditsRemaining({ uRaw: 0.1 }, { budget: 40, budgets: { x: 100 } }, "x"), 90, "montant propre au compte prioritaire");
  assert.strictEqual(lib.creditsRemaining({ uRaw: 0.1 }, {}, "x"), null, "sans montant -> null (on affichera le %)");
  assert.strictEqual(lib.creditsRemaining({ uRaw: 1.4 }, { budget: 10 }, "x"), 0, "jamais negatif");
}

console.log("PASS — statusline: reset + comptes qui repartent, un bloc 5h/7j par compte, numero colore selon l'etat, wrapped ; reset ignore les comptes sans quota hebdo (sinon reset 7j date) ; credits visibles");
