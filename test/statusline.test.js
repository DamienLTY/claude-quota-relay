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
  assert.ok(out.includes("① 5h/ 40%") && out.includes("② 5h/ 73%"), "chaque compte affiche SON 5h: " + out);
  assert.ok(out.includes("7J/ 12%") && out.includes("7J/ 55%"), "chaque compte affiche SON 7j");
  assert.ok(out.includes("█"), "has progress bars");
  assert.ok(!/57%/.test(out), "plus de moyenne de flotte (illisible a 3 comptes)");
  assert.ok(!/Reset à/.test(out), "no verbose 'Reset à' text");
}

// Case A3: UNE LIGNE PAR COMPTE. Tous les blocs sur une seule ligne se repliaient n'importe ou
// des 5 comptes. Chaque ligne de compte est bordee de │ des deux cotes, et toutes ont la MEME
// largeur : sans le cadrage des pourcentages, la bordure de droite danserait d'un compte a
// l'autre -- or cet alignement est la seule raison d'etre du multi-lignes.
{
  const lines = strip(run(setup({ original: null }))).split("\n");
  assert.strictEqual(lines.length, 3, "1 ligne d'en-tete + 1 par compte: " + JSON.stringify(lines));
  assert.ok(/ │$/.test(lines[0]), "l'en-tete se ferme aussi par une bordure: " + lines[0]);
  for (const l of lines.slice(1)) assert.ok(/^│ .* │$/.test(l), "ligne de compte bordee des deux cotes: " + l);
  assert.strictEqual(lines[1].length, lines[2].length, "toutes les lignes de compte ont la meme largeur");
  // 0% et 100% ne font pas le meme nombre de chiffres : c'est le cas qui casse l'alignement.
  const wide = strip(run(setup({ original: null }, { state: { pct: { compte1: { h5: 0, d7: 100 }, compte2: { h5: 100, d7: 7 } } } }))).split("\n");
  assert.strictEqual(wide[1].length, wide[2].length, "0% et 100% gardent la meme largeur: " + JSON.stringify(wide));
  // Au-dela du 9e compte il n'y a plus de chiffre entoure : tag() rend "(10)", quatre caracteres
  // la ou les autres en rendent un. Sans calage, cette ligne-la seule perd sa bordure de droite.
  const many = { tokens: [], pct: {} };
  for (let i = 1; i <= 10; i++) {
    many.tokens.push({ name: "c" + i, token: "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-" + String(i).padStart(6, "0"), enabled: true });
    many.pct["c" + i] = { h5: i * 3, d7: i * 5 };
  }
  const big = strip(run(setup({ original: null }, { conf: { tokens: many.tokens }, state: { pct: many.pct } }))).split("\n");
  assert.strictEqual(big.length, 11, "10 comptes -> 11 lignes: " + big.length);
  const widths = new Set(big.slice(1).map((l) => l.length));
  assert.strictEqual(widths.size, 1, "le 10e compte garde la largeur des neuf autres: " + JSON.stringify(big.slice(-2)));
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
  assert.ok(/crédits ◐ │$/.test(strip(ready).split("\n")[0]), "la pastille ferme la ligne d'en-tete, sans aucun pourcentage: " + ready);
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

// Case F: compte refuse par Anthropic tant que ses conditions ne sont pas acceptees (DR-010).
// Le pop-up du proxy peut etre manque ; ce marqueur reste jusqu'a ce que le compte reponde.
{
  const out = strip(run(setup({ original: null }, { state: { blocked: { compte2: { reason: "terms", at: "x", until: Date.now() + 3600000 } } } })));
  const lines = out.split("\n");
  assert.strictEqual(lines.length, 3, "une ligne d'en-tete + un bloc par compte, comme sans blocage: " + JSON.stringify(out));
  assert.ok(/CGU à accepter/.test(lines[2]), "le compte bloque porte le marqueur: " + lines[2]);
  assert.ok(!/CGU/.test(lines[1]), "le compte sain n'en porte pas: " + lines[1]);
  assert.ok(/│ ⚠ CGU à accepter$/.test(lines[2]), "le marqueur est APRES la bordure, donc aucun cadre n'est decale: " + lines[2]);
  // contre-epreuve du cas courant : sans blocage, aucune ligne ne porte le marqueur
  assert.ok(!/CGU/.test(strip(run(setup({ original: null })))), "aucun blocage -> aucun marqueur");
}

// Case G: un compte muet (ex. 403 sans en-tetes) garde dans state.json un reset PASSE et son 100 %.
// La fenetre est echue : 0 %, reset ignore, comme le routeur (DR-013). Avant : "↻ <heure d'hier> ③"
// au lieu de l'heure du vrai prochain reset, et ③ restait fige a 5h 100 %.
{
  const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
  const tokens = ["1", "2", "3"].map((name) => ({ name, token: FAKE, enabled: true }));
  const stale = Date.now() - 20 * 3600000, rNext = Date.now() + 20 * 60000, rLater = Date.now() + 65 * 60000;
  const out = strip(run(setup({ original: null }, { conf: { tokens }, state: {
    pct: { 1: { h5: 40, d7: 12 }, 2: { h5: 73, d7: 55 }, 3: { h5: 100, d7: 93 } },
    reset5h: { 1: rLater, 2: rNext, 3: stale },
    reset7d: { 1: Date.now() + 3 * 3600000, 2: Date.now() + 5 * 3600000, 3: Date.now() + 86400000 },
  } })));
  const lines = out.split("\n");
  assert.ok(out.startsWith("↻ " + hhmm(rNext) + " ②"), "affiche le reset futur du compte sain, pas le reset passe: " + out);
  assert.ok(!out.includes(hhmm(stale)), "n'affiche JAMAIS l'heure du reset passe (" + hhmm(stale) + "): " + out);
  assert.ok(lines[3].includes("③ 5h/  0%") && !/100%/.test(out), "le compte muet n'est plus fige a 5h 100 %: " + lines[3]);
  assert.ok(lines[3].includes("7J/ 93%"), "sa fenetre 7j, elle, n'est pas echue : inchangee: " + lines[3]);
  assert.ok(lines[1].includes("① 5h/ 40%") && lines[2].includes("② 5h/ 73%"), "les comptes sains sont intacts");
  // meme chose cote 7j : un 7j a 100 % dont le reset est passe n'impose plus l'attente hebdo ("↻7j")
  const out7 = strip(run(setup({ original: null }, { conf: { tokens: tokens.slice(0, 2) }, state: {
    pct: { 1: { h5: 90, d7: 100 }, 2: { h5: 73, d7: 99 } },
    reset5h: { 1: rLater, 2: rNext },
    reset7d: { 1: Date.now() - 3600000, 2: Date.now() + 2 * 86400000 },
  } })));
  assert.ok(!/↻7j/.test(out7), "7j echu -> le compte est revenu : pas d'attente hebdomadaire: " + out7);
  assert.ok(out7.includes("↻ " + hhmm(rLater) + " ①") && out7.split("\n")[1].includes("7J/  0%"), "le compte revenu affiche 7J/ 0% et son reset 5h: " + out7);
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

// Gardien du relais (DR-012). Le relais peut mourir ; la statusline, qui tourne toutes les 10 s
// (statusLine.refreshInterval) meme pendant que Claude Code reessaie, le relance. Dossier isole, port
// libre : jamais le vrai relais de la machine. Un ensure-proxy.js "sentinelle" ecrit launched.txt
// (avec CQR_STARTED_BY) pour prouver dans les DEUX sens : il est lance quand il faut, jamais sinon.
(async () => {
  const net = require("net");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const pt = s.address().port; s.close(() => res(pt)); }); });
  const OFFLINE = { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: "9", CQR_UPSTREAM_HTTP: "1" }; // aucune sonde reseau reelle
  const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
  const SENTINEL = 'require("fs").writeFileSync(require("path").join(__dirname, "launched.txt"), String(process.env.CQR_STARTED_BY));';
  const runAsync = (DIR, extraEnv) => new Promise((res) => {
    const t0 = Date.now(); let out = "";
    const c = cp.spawn(process.execPath, [SCRIPT], { env: Object.assign({}, process.env, OFFLINE, { CQR_DIR: DIR }, extraEnv || {}), windowsHide: true });
    c.stdout.on("data", (d) => (out += d)); c.stdin.end("{}");
    c.on("close", () => res({ stdout: out, ms: Date.now() - t0 }));
  });
  const gdir = async (port, sentinel) => {
    const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-guard-"));
    fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port, switchAtPercent: 94, sevenDayBlockPercent: 99, tokens: [{ name: "compte1", token: FAKE, enabled: true }] }));
    fs.writeFileSync(p.join(DIR, "statusline.json"), JSON.stringify({ original: null }));
    if (sentinel) fs.writeFileSync(p.join(DIR, "ensure-proxy.js"), SENTINEL);
    return DIR;
  };
  const launched = (DIR) => { try { return fs.readFileSync(p.join(DIR, "launched.txt"), "utf8"); } catch (e) { return null; } };
  const deadPid = () => { const r = cp.spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true }); return r.stdout.trim(); };

  // --- six situations, sentinelle : seul le test TCP decide (un PID peut avoir ete reattribue a un autre
  // processus, le gardien serait aveugle). Trois lancements attendus (relais mort), trois silences ---
  const dead = await gdir(await freePort(), true);                                               // 1. rien : ni PID ni ecoute
  const stale = await gdir(await freePort(), true); fs.writeFileSync(p.join(stale, "proxy.pid"), deadPid());   // 2. PID perime
  const stopped = await gdir(await freePort(), true); fs.writeFileSync(p.join(stopped, "proxy.stopped"), "x"); // 3. arret voulu
  const pidAlive = await gdir(await freePort(), true); fs.writeFileSync(p.join(pidAlive, "proxy.pid"), String(process.pid)); // 4. PID vivant MAIS port ferme (PID reattribue) -> relance
  const lport = await freePort();
  const listening = await gdir(lport, true); fs.writeFileSync(p.join(listening, "proxy.pid"), deadPid());      // 5. PID mort mais quelque chose ecoute
  const lport2 = await freePort();
  const listeningAlive = await gdir(lport2, true); fs.writeFileSync(p.join(listeningAlive, "proxy.pid"), String(process.pid)); // 6. PID vivant et le port repond
  const srv = net.createServer((s) => s.destroy()); await new Promise((r) => srv.listen(lport, "127.0.0.1", r));
  const srv2 = net.createServer((s) => s.destroy()); await new Promise((r) => srv2.listen(lport2, "127.0.0.1", r));
  const results = await Promise.all([dead, stale, stopped, pidAlive, listening, listeningAlive].map((d) => runAsync(d)));
  await sleep(1500); // le temps qu'un ensure-proxy.js detache, s'il y en a un, ecrive son temoin
  srv.close(); srv2.close();
  assert.strictEqual(launched(dead), "statusline", "relais mort (ni PID ni port) -> ensure-proxy.js lance avec CQR_STARTED_BY=statusline");
  assert.strictEqual(launched(stale), "statusline", "PID perime + port ferme -> lance");
  assert.strictEqual(launched(stopped), null, "proxy.stopped present (cqr stop) -> JAMAIS relance");
  assert.strictEqual(launched(pidAlive), "statusline", "proxy.pid vivant mais port ferme -> lance (le PID ne decide pas)");
  assert.strictEqual(launched(listening), null, "PID mort mais le port repond -> aucun lancement");
  assert.strictEqual(launched(listeningAlive), null, "port qui repond -> aucun lancement");
  for (const r of results) assert.strictEqual(strip(r.stdout).split("\n").length, 2, "la ligne de statusline sort normalement dans tous les cas: " + JSON.stringify(r.stdout));
  for (const r of results) assert.ok(r.ms < 3000, "jamais de blocage au-dela de quelques centaines de ms de plus: " + r.ms + " ms");
  for (const d of [dead, stale, stopped, pidAlive, listening, listeningAlive]) fs.rmSync(d, { recursive: true, force: true });

  // --- pas de rafale : deux statuslines a la suite sur un relais mort -> UN seul lancement (proxy.guard,
  // 60 s, partage entre sessions) ; un guard plus vieux que 60 s ne retient plus rien ---
  {
    const COUNTER = 'require("fs").appendFileSync(require("path").join(__dirname, "launches.txt"), "x");';
    const D = await gdir(await freePort(), false);
    fs.writeFileSync(p.join(D, "ensure-proxy.js"), COUNTER);
    const launches = () => { try { return fs.readFileSync(p.join(D, "launches.txt"), "utf8").length; } catch (e) { return 0; } };
    await runAsync(D); await sleep(800);
    await runAsync(D); await sleep(800);
    assert.strictEqual(launches(), 1, "relais mort, deux statuslines de suite -> un seul lancement, or: " + launches());
    assert.ok(fs.existsSync(p.join(D, "proxy.guard")), "le lancement a pose proxy.guard");
    const old = new Date(Date.now() - 61000); fs.utimesSync(p.join(D, "proxy.guard"), old, old);
    await runAsync(D); await sleep(800);
    assert.strictEqual(launches(), 2, "proxy.guard vieux de 61 s -> la relance repart, or: " + launches());
    fs.rmSync(D, { recursive: true, force: true });
  }

  // --- qui a lance le relais : ensure-proxy.js transmet CQR_STARTED_BY au relais (proxy.js factice
  // qui note sa variable), la valeur du gardien d'abord, "sessionstart" quand c'est le hook ---
  {
    const D = await gdir(await freePort(), false);
    fs.copyFileSync(p.join(__dirname, "..", "src", "ensure-proxy.js"), p.join(D, "ensure-proxy.js"));
    fs.writeFileSync(p.join(D, "proxy.js"), 'require("fs").writeFileSync(require("path").join(__dirname, "started-by.txt"), String(process.env.CQR_STARTED_BY));');
    const ensure = (extra) => { const e = Object.assign({}, process.env); delete e.CQR_STARTED_BY; return cp.spawnSync(process.execPath, [p.join(D, "ensure-proxy.js")], { env: Object.assign(e, extra || {}), windowsHide: true, timeout: 10000 }); };
    const startedBy = () => { try { return fs.readFileSync(p.join(D, "started-by.txt"), "utf8"); } catch (e) { return null; } };
    ensure({ CQR_STARTED_BY: "statusline" }); await sleep(500);
    assert.strictEqual(startedBy(), "statusline", "ensure-proxy.js transmet CQR_STARTED_BY=statusline au relais");
    fs.unlinkSync(p.join(D, "started-by.txt"));
    ensure(); await sleep(500);
    assert.strictEqual(startedBy(), "sessionstart", "lance par le hook SessionStart (variable absente) -> 'sessionstart'");
    fs.rmSync(D, { recursive: true, force: true });
  }

  // --- chaine reelle : relais isole mort -> la statusline le fait revenir sur son port ---
  const port = await freePort();
  const DIR = await gdir(port, false);
  for (const f of ["ensure-proxy.js", "proxy.js", "lib.js", "compaction.js"]) fs.copyFileSync(p.join(__dirname, "..", "src", f), p.join(DIR, f));
  const alivePort = () => new Promise((res) => { const q = require("http").get("http://127.0.0.1:" + port + "/__proxy_health", (r) => { r.resume(); res(r.statusCode === 200); }); q.on("error", () => res(false)); q.setTimeout(500, () => { q.destroy(); res(false); }); });
  try {
    assert.strictEqual(await alivePort(), false, "au depart rien n'ecoute sur le port isole");
    const t0 = Date.now(); const r = await runAsync(DIR);
    assert.strictEqual(strip(r.stdout).split("\n").length, 2, "la ligne sort normalement: " + r.stdout);
    let up = false; while (!up && Date.now() - t0 < 8000) { up = await alivePort(); if (!up) await sleep(150); }
    assert.ok(up, "le relais isole repond sur son port moins de 8 s apres la statusline");
    console.log("   gardien : relais isole revenu en " + (Date.now() - t0) + " ms (statusline elle-meme : " + r.ms + " ms)");
    assert.ok(fs.existsSync(p.join(DIR, "proxy.pid")), "le relais relance a ecrit son proxy.pid");
    // qui l'a lance : ecrit par proxy.js dans sa ligne de demarrage (si cette version du relais le fait)
    if (/CQR_STARTED_BY/.test(fs.readFileSync(p.join(DIR, "proxy.js"), "utf8"))) {
      const log = fs.readFileSync(p.join(DIR, "proxy.log"), "utf8");
      assert.ok(/statusline/.test(log), "la ligne de demarrage du relais porte 'statusline': " + log.slice(0, 400));
    }
    // et une 2e statusline, relais vivant, ne change rien : meme PID
    const pid1 = fs.readFileSync(p.join(DIR, "proxy.pid"), "utf8").trim();
    await runAsync(DIR); await sleep(1200);
    assert.strictEqual(fs.readFileSync(p.join(DIR, "proxy.pid"), "utf8").trim(), pid1, "relais vivant -> la statusline ne relance rien");
  } finally {
    try { process.kill(parseInt(fs.readFileSync(p.join(DIR, "proxy.pid"), "utf8").trim(), 10)); } catch (e) {}
    await sleep(300); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  console.log("PASS — gardien: relais mort -> relance par la statusline (statusline, chaine reelle) ; port qui repond / proxy.stopped -> aucune relance ; PID vivant mais port ferme -> relance ; au plus une relance par minute");
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });

console.log("PASS — statusline: reset + comptes qui repartent, un bloc 5h/7j par compte, numero colore selon l'etat, wrapped ; reset ignore les comptes sans quota hebdo (sinon reset 7j date) ; credits visibles");
