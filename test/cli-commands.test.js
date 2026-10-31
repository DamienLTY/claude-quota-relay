// cqr help lists commands; `cqr compact dynamic on` also turns compaction on (it's pointless
// otherwise); unknown command shows help. Run: node test/cli-commands.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-cli-"));
for (const f of ["cli.js", "lib.js", "compaction.js", "free-compact.js", "ancre.js", "entreprise.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8787, compaction: { enabled: false, dryRun: false }, tokens: [{ name: "1", token: FAKE, enabled: true }] }));

const run = (...args) => cp.spawnSync(process.execPath, [p.join(DIR, "cli.js"), ...args], { encoding: "utf8", windowsHide: true });
const conf = () => JSON.parse(fs.readFileSync(p.join(DIR, "tokens.json"), "utf8"));

// help lists the main commands
{
  const r = run("help");
  assert.strictEqual(r.status, 0, "help exits 0");
  for (const c of ["cqr status", "cqr add", "cqr remove", "cqr compact", "cqr policy port", "cqr guard"]) {
    assert.ok(r.stdout.includes(c), "help mentions '" + c + "'");
  }
}

// unknown command -> shows help + exits 1
{
  const r = run("wat");
  assert.strictEqual(r.status, 1, "unknown command exits 1");
  assert.ok(/Commande inconnue/.test(r.stderr), "says unknown");
  assert.ok(r.stdout.includes("cqr status"), "still prints the help listing");
}

// task 1: `cqr compact dynamic on` turns dynamicThreshold on AND enables compaction
{
  const r = run("compact", "dynamic", "on");
  assert.strictEqual(r.status, 0, "dynamic on exits 0: " + r.stderr);
  const cc = conf().compaction;
  assert.strictEqual(cc.dynamicThreshold, true, "dynamicThreshold enabled");
  assert.strictEqual(cc.enabled, true, "compaction auto-enabled with dynamic on");
  assert.strictEqual(cc.dryRun, false, "not left in dry-run");
}

// dynamic off leaves compaction enabled (doesn't disable it)
{
  const r = run("compact", "dynamic", "off");
  assert.strictEqual(r.status, 0, "dynamic off exits 0");
  const cc = conf().compaction;
  assert.strictEqual(cc.dynamicThreshold, false, "dynamicThreshold off");
  assert.strictEqual(cc.enabled, true, "compaction stays enabled");
}

// task B (visibilite) : `cqr compact` affiche la derniere compaction lue depuis state.json
{
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, compaction: { at: Date.now() - 120000, from: "1", to: "2", model: "claude-opus-4-8", reason: "switch@95>=89%" } }));
  const r = run("compact");
  assert.strictEqual(r.status, 0, "compact status exits 0");
  assert.ok(/dernière/.test(r.stdout), "montre la derniere compaction");
  assert.ok(r.stdout.includes("1->2"), "montre le sens du changement (1->2)");
  assert.ok(/il y a 2min/.test(r.stdout), "montre l'anciennete relative");
}
// sans marqueur -> message explicite (au lieu de rien -> repond au 'je ne le vois pas')
{
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0 }));
  const r = run("compact");
  assert.ok(/dernière : aucune encore/.test(r.stdout), "sans compaction: message explicite");
}

// --- credits d'usage supplementaire (extra usage) ---
// Argent : jamais consommes sans accord explicite -> off par defaut, on/off/max pilotables.
{
  const r = run("credits");
  assert.strictEqual(r.status, 0, "cqr credits exits 0: " + r.stderr);
  assert.ok(/autorisés\s*: non/.test(r.stdout), "off par defaut: " + r.stdout);
  assert.ok(/plafond/.test(r.stdout), "montre le plafond");
  assert.ok(/hebdomadaire/.test(r.stdout), "explique que les credits couvrent aussi la limite 7j");
}
{
  const r = run("credits", "on");
  assert.strictEqual(r.status, 0, "credits on exits 0");
  assert.strictEqual(conf().overage.use, true, "overage.use = true");
  assert.ok(/facturés/.test(r.stdout), "previent que ca peut etre facture");
  assert.ok(/AUCUN compte n'a plus de forfait/.test(r.stdout), "dit que c'est le dernier recours");
}
{
  const r = run("credits", "max", "50");
  assert.strictEqual(r.status, 0, "credits max exits 0");
  assert.strictEqual(conf().overage.maxPercent, 50, "plafond enregistre");
  assert.strictEqual(run("credits", "max", "150").status, 1, "plafond hors bornes refuse");
}
// etat par compte : lu depuis state.overage (ce que le proxy a vu dans les en-tetes)
{
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, overage: { 1: { status: "allowed", u: 12, reset: Date.now() + 3600000 } } }));
  const r = run("credits");
  assert.ok(/12% utilisés/.test(r.stdout), "montre la part de credits consommee: " + r.stdout);
  // au-dessus du plafond (12% < 50% ici : on repasse le plafond a 10 pour verifier le blocage)
  run("credits", "max", "10");
  assert.ok(/plafond atteint/.test(run("credits").stdout), "signale quand le plafond bloque");
}
// montant des credits saisi a la main -> affichage en argent restant
{
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, overage: { 1: { status: "allowed", u: 20, uRaw: 0.2 } } }));
  run("credits", "max", "100");
  assert.ok(/montant.*non renseigné/.test(run("credits").stdout), "sans montant : dit comment le saisir");
  const r = run("credits", "budget", "20", "EUR");
  assert.strictEqual(r.status, 0, "budget exits 0: " + r.stderr);
  assert.strictEqual(conf().overage.budget, 20, "montant enregistre");
  assert.strictEqual(conf().overage.currency, "EUR", "devise enregistree");
  assert.ok(/16,00 € restants sur 20,00 €/.test(run("credits").stdout), "affiche l'argent restant (20 - 20%)");
  assert.strictEqual(run("credits", "budget", "1", "50").status, 0, "budget par compte accepte");
  assert.strictEqual(conf().overage.budgets["1"], 50, "montant par compte enregistre");
  assert.ok(/40,00 € restants sur 50,00 €/.test(run("credits").stdout), "le montant du compte prime");
  assert.strictEqual(run("credits", "budget").status, 1, "budget sans argument -> usage + exit 1");
}
// raison d'indisponibilite traduite (cas reel : usage supplementaire desactive sur le compte)
{
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, overage: { 1: { status: "rejected", reason: "org_level_disabled" } } }));
  const r = run("credits");
  assert.ok(/indisponibles/.test(r.stdout), "dit indisponible");
  assert.ok(/claude\.ai\/settings\/usage/.test(r.stdout), "explique OU les activer");
}
{ // help
  assert.ok(run("help").stdout.includes("cqr credits"), "help mentionne cqr credits");
}

// DR-012 : `cqr stop` marque l'arret comme voulu (proxy.stopped), meme quand rien ne tourne -- sinon
// le gardien de la statusline relancerait, dans les 10 s, le relais qu'on vient d'arreter
{
  assert.ok(!fs.existsSync(p.join(DIR, "proxy.stopped")), "pas de proxy.stopped au depart");
  const r = run("stop");
  assert.strictEqual(r.status, 0, "stop exits 0: " + r.stderr);
  assert.ok(fs.existsSync(p.join(DIR, "proxy.stopped")), "cqr stop pose proxy.stopped a cote de proxy.pid");
}

// J5-6 (cqr:J5-014/018/022) : `cqr quota --json` = quotas par compte lus dans state.json, lecture seule, JAMAIS un jeton
{
  const T2 = "sk-ant-oat01-FAKE-SECOND-TOKEN-not-real-1111111";
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8787, compaction: { enabled: true, free: { enabled: true, kinds: ["manual"] } }, tokens: [{ name: "1", token: FAKE, enabled: true }, { name: "2", token: T2, enabled: false }, { name: "3", token: FAKE + "x", enabled: true }] }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, forceIndex: 2,
    pct: { 1: { h5: 12, d7: 34, max: 34, at: iso(now - 60000) }, 2: { h5: 5, d7: 5, at: iso(now - 3600000) }, 3: { h5: 95, d7: 40, at: iso(now - 40 * 60000) }, retire: { h5: 1, d7: 1, at: iso(now) } },
    reset5h: { 1: now + 3600000, 3: now - 1000 }, reset7d: { 1: now + 86400000 }, exhausted: { 3: now + 600000 } }));
  const avant = [fs.readFileSync(p.join(DIR, "state.json"), "utf8"), fs.readFileSync(p.join(DIR, "tokens.json"), "utf8")];
  const r = run("quota", "--json");
  assert.strictEqual(r.status, 0, "quota --json exits 0: " + r.stderr);
  assert.ok(!r.stdout.includes(FAKE) && !r.stdout.includes(T2) && !/sk-ant/.test(r.stdout), "AUCUN jeton dans la sortie");
  const q = JSON.parse(r.stdout);
  assert.deepStrictEqual(q.comptes.map((c) => c.nom), ["1", "2", "3"], "comptes de la config seulement (le compte retire de state.json est absent)");
  const [c1, c2, c3] = q.comptes;
  assert.deepStrictEqual([c1.actif, c1.h5, c1.d7, c1.vieux], [true, 12, 34, false], "compte 1 : on, 12/34, relevé frais");
  assert.strictEqual(c1.at, iso(now - 60000), "at = horodatage du relevé");
  assert.strictEqual(c2.actif, false, "compte coupé signalé");
  assert.strictEqual(c2.vieux, true, "relevé d'une heure : vieux (J5-022, seuil 30 min)");
  assert.strictEqual(c3.h5, 0, "fenêtre 5h dont le reset est passé = 0 (règle de pickRoute)");
  assert.strictEqual(c3.d7, 40, "7j inchangé");
  assert.strictEqual(c3.vieux, true, "relevé de 40 min : vieux");
  assert.ok(c3.epuiseJusqua > now, "épuisé jusqu'à : donné");
  assert.strictEqual(c1.epuiseJusqua, null, "non épuisé : null");
  assert.strictEqual(q.vieuxApresMin, 30, "seuil de péremption publié");
  assert.deepStrictEqual([q.gratuit.actif, q.gratuit.compactage], [true, true], "détour gratuit : réglages lus");
  assert.deepStrictEqual(q.gratuit.types, ["manual"], "types listés");
  assert.deepStrictEqual([fs.readFileSync(p.join(DIR, "state.json"), "utf8"), fs.readFileSync(p.join(DIR, "tokens.json"), "utf8")], avant, "lecture seule : state.json et config inchangés");
  // sans --json : refus clair (la sortie texte existe déjà ailleurs : cqr status)
  const t = run("quota");
  assert.strictEqual(t.status, 1, "quota sans --json : refus");
  assert.ok(/--json/.test(t.stderr) && t.stdout === "", "quota sans --json : dit pourquoi, rien sur stdout");
  assert.ok(run("help").stdout.includes("cqr quota"), "help mentionne cqr quota");
  // état absent : pas de plantage, comptes à null
  fs.rmSync(p.join(DIR, "state.json"));
  const v = JSON.parse(run("quota", "--json").stdout);
  assert.deepStrictEqual([v.comptes[0].h5, v.comptes[0].at, v.comptes[0].vieux], [null, null, true], "pas d'état : null, et vieux");
}

// DR-016 : "use #3" vise le 3e de la liste, meme quand un compte s'appelle "3" ailleurs
{
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: ["2", "3", "1"].map((name) => ({ name, token: FAKE, enabled: true })) }));
  assert.ok(/-> 1 /.test(run("use", "#3").stdout), "#3 = 3e de la liste (nomme \"1\")");
  assert.ok(/-> 3 /.test(run("use", "3").stdout), "3 sans # reste le nom");
  assert.strictEqual(run("use", "#4").status, 1, "#4 hors liste -> erreur");
  assert.strictEqual(run("use", "#0").status, 1, "#0 -> erreur");
}

// DR-020 : "bascule" (= /auth-use) devient le compte actif SANS epingler ; l'epinglage existant part, `exhausted` reste
{
  const sp = p.join(DIR, "state.json");
  const etat = () => JSON.parse(fs.readFileSync(sp, "utf8"));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: ["2", "3", "1"].map((name) => ({ name, token: FAKE, enabled: true })) }));
  fs.writeFileSync(sp, JSON.stringify({ activeIndex: 0, forceIndex: 0, exhausted: { "1": Date.now() + 3600e3 }, pct: {}, reset5h: {}, reset7d: {} }));
  const exh = etat().exhausted["1"];
  const bs = run("bascule", "#3");
  assert.strictEqual(bs.status, 0, "bascule #3 : code 0 (" + bs.stderr.trim() + ")");
  assert.ok(/-> 1 /.test(bs.stdout), "bascule #3 = 3e de la liste (nomme \"1\")");
  let e = etat();
  assert.strictEqual(e.activeIndex, 2, "bascule : activeIndex = 2");
  assert.strictEqual(e.forceIndex, undefined, "bascule : l'epinglage est retire");
  assert.strictEqual(e.exhausted["1"], exh, "bascule : exhausted intact");
  const avantErr = fs.readFileSync(sp, "utf8");
  assert.strictEqual(run("bascule", "#4").status, 1, "bascule #4 hors liste -> erreur");
  assert.strictEqual(run("bascule", "#0").status, 1, "bascule #0 -> erreur");
  assert.strictEqual(fs.readFileSync(sp, "utf8"), avantErr, "les deux erreurs ne changent pas l'etat");
  assert.strictEqual(run("use", "#3").status, 0, "use #3 : code 0");
  assert.strictEqual(etat().forceIndex, 2, "use epingle toujours (non-regression)");
  assert.ok(run("help").stdout.includes("cqr bascule"), "help mentionne cqr bascule");
  const md = fs.readFileSync(p.join(__dirname, "..", "commands", "auth-use.md"), "utf8");
  assert.ok(md.includes('bascule "#$ARGUMENTS"'), "auth-use.md appelle bascule");
  assert.ok(!md.includes('use "#$ARGUMENTS"'), "auth-use.md n'appelle plus use");
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log("PASS — cqr help lists commands; quota --json sans jeton, lecture seule; compact dynamic on auto-enables compaction; unknown -> help; derniere compaction visible; credits on/off/max + etat par compte ; bascule sans epingler (DR-020)");
