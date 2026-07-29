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

// Case A: standalone -> cumulative 5h bar + mean% + clock reset + per-account 7j bars
{
  const out = strip(run(setup({ original: null })));
  assert.ok(out.startsWith("5h "), "starts with 5h: " + out);
  assert.ok(out.includes("7j "), "has 7j section");
  assert.ok(/↻ \d\dh\d\d/.test(out), "next reset shown as a clock time (↻ HHhMM)");
  assert.ok(out.includes("①") && out.includes("②"), "one 7j bar per account, numbered");
  assert.ok(out.includes("█"), "has progress bars");
  assert.ok(out.includes("57%"), "5h mean of 40 and 73 = 57%"); // cumulative fleet %
  assert.ok(!/Reset à/.test(out), "no verbose 'Reset à' text");
  assert.ok(!/API-1 \|/.test(out), "no old verbose per-account list");
}

// Case B: wrapped -> original kept as prefix, ours after " │ "
{
  const out = strip(run(setup({ original: { type: "command", command: "echo MYLINE" } })));
  assert.ok(out.startsWith("MYLINE │ 5h "), "original prefix kept then ours: " + out);
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

// Case E: credits d'usage supplementaire -- rien ne s'affiche tant qu'ils ne sont pas autorises,
// puis "cr N%" une fois autorises (l'utilisateur doit voir ce qu'il consomme).
{
  const st = { overage: { compte1: { status: "allowed", u: 8 }, compte2: { status: "rejected", reason: "org_level_disabled" } } };
  assert.ok(!/cr \d+%/.test(strip(run(setup({ original: null }, { state: st })))), "credits non autorises -> aucun affichage");
  const out = strip(run(setup({ original: null }, { state: st, conf: { overage: { use: true, maxPercent: 100 } } })));
  assert.ok(/cr 8%/.test(out), "credits autorises -> part consommee affichee: " + out);
}

console.log("PASS — statusline: cumulative 5h + clock reset + per-account 7j, wrapped, no verbose text; reset ignore les comptes sans quota hebdo (sinon reset 7j date) ; credits visibles");
