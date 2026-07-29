// cqr help lists commands; `cqr compact dynamic on` also turns compaction on (it's pointless
// otherwise); unknown command shows help. Run: node test/cli-commands.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-cli-"));
for (const f of ["cli.js", "lib.js", "compaction.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
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

fs.rmSync(DIR, { recursive: true, force: true });
console.log("PASS — cqr help lists commands; compact dynamic on auto-enables compaction; unknown -> help; derniere compaction visible; credits on/off/max + etat par compte");
