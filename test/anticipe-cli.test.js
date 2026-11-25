// `cqr compact anticipe on|off|ratio|status` : eteint par defaut, `on` lit seulement les nombres autoCompactWindow, jamais le jeton.
// Le CLI tourne depuis une copie jetable, avec CLAUDE_CONFIG_DIR jetable : ni la config ni settings.json du poste ne sont touches.
// Run: node test/anticipe-cli.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-anticli-"));
const CFG = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-anticfg-"));
const MARQUEUR = "MARQUEUR-TOKEN-MARQUEUR-9f8e7d";
try {
  for (const f of ["cli.js", "lib.js", "compaction.js", "free-compact.js", "ancre.js", "entreprise.js", "anticipe.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8787, compaction: { enabled: false }, tokens: [{ name: "1", token: FAKE, enabled: true }] }));
  fs.writeFileSync(p.join(CFG, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: MARQUEUR }, modelSettings: { "claude-opus-5-5": { autoCompactWindow: 333000 }, "claude-fable-5-2": { autoCompactWindow: 333000 }, "claude-sonnet-5-5": {}, "claude-haiku-5-5": { autoCompactWindow: 50000 } } }));
  const run = (...a) => cp.spawnSync(process.execPath, [p.join(DIR, "cli.js"), ...a], { encoding: "utf8", windowsHide: true, env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG }) });
  const conf = () => JSON.parse(fs.readFileSync(p.join(DIR, "tokens.json"), "utf8"));

  let r = run("compact", "anticipe", "status");
  assert.strictEqual(r.status, 0, r.stderr); assert.ok(/éteint/.test(r.stdout), "status : éteint par défaut : " + r.stdout);
  assert.ok(!conf().compaction.anticipe || conf().compaction.anticipe.enabled !== true, "rien d'allumé par status");

  r = run("compact", "anticipe", "on");
  assert.strictEqual(r.status, 0, r.stderr);
  const a = conf().compaction.anticipe;
  assert.strictEqual(a.enabled, true); assert.strictEqual(a.ratio, 0.94);
  assert.deepStrictEqual(a.fenetres, { "claude-opus-5-5": 333000, "claude-fable-5-2": 333000 }, "fenêtres lues (50 000 < 100 000 et {} écartés)");
  assert.ok(/claude-opus-5-5 333000 -> seuil 300000 , déclenchement 282000 , cible 320000/.test(r.stdout), "on affiche seuil/déclenchement/cible : " + r.stdout);
  assert.ok(!r.stdout.includes(MARQUEUR) && !r.stderr.includes(MARQUEUR), "le jeton de settings.json n'est jamais affiché");
  assert.ok(!fs.readFileSync(p.join(DIR, "tokens.json"), "utf8").includes(MARQUEUR), "ni recopié");

  r = run("compact", "anticipe", "status");
  assert.ok(/ACTIVÉ/.test(r.stdout) && /282000/.test(r.stdout), "status après on : " + r.stdout);

  r = run("compact", "anticipe", "ratio", "0.9"); assert.strictEqual(r.status, 0); assert.strictEqual(conf().compaction.anticipe.ratio, 0.9);
  assert.ok(/déclenchement 270000/.test(r.stdout), r.stdout);
  for (const v of ["0.4", "1", "abc", undefined]) { const x = run("compact", "anticipe", "ratio", ...(v ? [v] : [])); assert.strictEqual(x.status, 1, "ratio " + v + " refusé"); assert.strictEqual(conf().compaction.anticipe.ratio, 0.9); }

  r = run("compact", "anticipe", "off"); assert.strictEqual(r.status, 0); assert.strictEqual(conf().compaction.anticipe.enabled, false);
  assert.strictEqual(conf().compaction.anticipe.ratio, 0.9, "off garde le réglage");
  r = run("compact", "anticipe", "bidule"); assert.strictEqual(r.status, 1);

  // settings.json absent : aucune fenêtre, message, pas de plantage
  fs.unlinkSync(p.join(CFG, "settings.json"));
  r = run("compact", "anticipe", "on"); assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(conf().compaction.anticipe.fenetres, {}); assert.ok(/aucune requête n'est candidate/.test(r.stdout));

  // l'aide cite la commande
  assert.ok(run("help").stdout.includes("cqr compact anticipe"), "help");
  console.log("PASS - anticipe-cli : éteint par défaut, on lit les fenêtres sans jeton, ratio borné, off");
} catch (e) { console.error("FAIL:", e.stack || e.message); process.exitCode = 1; }
finally { try { fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(CFG, { recursive: true, force: true }); } catch (e) {} }
