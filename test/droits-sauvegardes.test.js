// Audit 2, M2 : settings.json.bak-* et writeSettings ecrits en 0600 (le jeton y est en clair). Sous Windows les modes
// sont sans effet : on espionne fs.writeFileSync (le `mode` demande) dans lib.writeSettings, install.js et uninstall.js.
// Run: node test/droits-sauvegardes.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const modeDe = (o) => (typeof o === "object" && o ? o.mode : undefined);

// (a) lib.writeSettings (via debrancherFichier), en processus
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-droits-"));
  const sp = p.join(T, "settings.json"), vus = [], wf = fs.writeFileSync;
  fs.writeFileSync = (f, d, o) => { vus.push([String(f), modeDe(o)]); return wf(f, d, o); };
  wf(sp, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } }));
  try { assert.strictEqual(require("../src/lib.js").debrancherFichier(sp), true); } finally { fs.writeFileSync = wf; }
  assert.ok(vus.length >= 1 && vus.every(([, m]) => m === 0o600), "writeSettings : mode 0o600 demande : " + JSON.stringify(vus));
  fs.rmSync(T, { recursive: true, force: true });
}

// (b) install.js puis uninstall.js, en sous-processus avec un espion precharge
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-droits-"));
  const CFG = p.join(T, "cfg"), IDIR = p.join(CFG, "claude-quota-relay"), LOG = p.join(T, "spy.log");
  fs.mkdirSync(IDIR, { recursive: true });
  fs.writeFileSync(p.join(CFG, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE } }));
  fs.writeFileSync(p.join(IDIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
  const spy = p.join(T, "spy.js");
  fs.writeFileSync(spy, 'const fs=require("fs");const w=fs.writeFileSync;fs.writeFileSync=function(f,d,o){try{fs.appendFileSync(process.env.SPY_LOG,JSON.stringify([String(f),(o&&typeof o==="object")?o.mode:null])+"\\n")}catch(e){}return w.apply(this,arguments)};');
  const env = Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1", SPY_LOG: LOG, NODE_OPTIONS: "--require " + JSON.stringify(spy.replace(/\\/g, "/")) });
  for (const [script, args] of [["install.js", ["--no-interactive"]], ["uninstall.js", []]]) {
    const r = cp.spawnSync(process.execPath, [p.join(__dirname, "..", "src", script), ...args, "--config-dir", CFG], { encoding: "utf8", env, windowsHide: true });
    assert.strictEqual(r.status, 0, script + " : " + (r.stderr || ""));
  }
  const lignes = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const baks = lignes.filter(([f]) => /settings\.json\.bak-/.test(f));
  assert.ok(baks.length >= 2, "install + uninstall ecrivent chacun une sauvegarde : " + baks.length);
  assert.ok(baks.every(([, m]) => m === 0o600), "sauvegardes en 0o600 : " + JSON.stringify(baks));
  fs.rmSync(T, { recursive: true, force: true });
}

// (c) Audit 3 : les ecritures DIRECTES de settings.json (install.js, uninstall.js, cqr policy port) demandent aussi 0o600
// (un settings.json cree par cqr porte le jeton ; sur un fichier existant le mode reste, sur un nouveau il vaut le umask).
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-droits-"));
  const CFG = p.join(T, "cfg"), IDIR = p.join(CFG, "claude-quota-relay"), LOG = p.join(T, "spy.log");
  fs.mkdirSync(IDIR, { recursive: true });
  fs.writeFileSync(p.join(IDIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
  const spy = p.join(T, "spy.js");
  fs.writeFileSync(spy, 'const fs=require("fs");const w=fs.writeFileSync;fs.writeFileSync=function(f,d,o){try{fs.appendFileSync(process.env.SPY_LOG,JSON.stringify([String(f),(o&&typeof o==="object")?o.mode:null])+"\\n")}catch(e){}return w.apply(this,arguments)};');
  const env = Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1", SPY_LOG: LOG, NODE_OPTIONS: "--require " + JSON.stringify(spy.replace(/\\/g, "/")) });
  // pas de settings.json au depart : install.js le CREE avec le jeton
  let r = cp.spawnSync(process.execPath, [p.join(__dirname, "..", "src", "install.js"), "--no-interactive", "--config-dir", CFG], { encoding: "utf8", env, windowsHide: true });
  assert.strictEqual(r.status, 0, "install.js : " + (r.stderr || ""));
  r = cp.spawnSync(process.execPath, [p.join(__dirname, "..", "src", "uninstall.js"), "--config-dir", CFG], { encoding: "utf8", env, windowsHide: true });
  assert.strictEqual(r.status, 0, "uninstall.js : " + (r.stderr || ""));
  const lignes = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const sets = lignes.filter(([f]) => /settings\.json$/.test(f));
  assert.ok(sets.length >= 2, "install + uninstall ecrivent settings.json : " + sets.length);
  assert.ok(sets.every(([, m]) => m === 0o600), "settings.json ecrit en 0o600 (install/uninstall) : " + JSON.stringify(sets));
  fs.rmSync(T, { recursive: true, force: true });
}
// (d) cli.js : `cqr policy port` reecrit settings.json -> meme exigence (verifie sur la source)
{
  const src = fs.readFileSync(p.join(__dirname, "..", "src", "cli.js"), "utf8");
  const m = src.match(/fs\.writeFileSync\(SETTINGS, [^\n]*\);/g) || [];
  assert.ok(m.length >= 1 && m.every((l) => /mode:\s*0o600/.test(l)), "cli.js : ecritures de settings.json en 0o600 : " + JSON.stringify(m));
}
// (e) Audit 4 : `mode` de writeFileSync ne vaut qu'a la creation -> un settings.json EXISTANT (0o644) doit etre chmod 0o600 apres ecriture.
// Espion sur fs.chmodSync (fiable sous Windows) ; sous POSIX on verifie aussi le mode reel sur disque.
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-droits-"));
  const CFG = p.join(T, "cfg"), IDIR = p.join(CFG, "claude-quota-relay"), LOG = p.join(T, "spy.log"), sp = p.join(CFG, "settings.json");
  fs.mkdirSync(IDIR, { recursive: true });
  fs.writeFileSync(p.join(IDIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
  fs.writeFileSync(sp, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE } }));
  const spy = p.join(T, "spy-chmod.js");
  fs.writeFileSync(spy, 'const fs=require("fs");const c=fs.chmodSync;fs.chmodSync=function(f,m){try{fs.appendFileSync(process.env.SPY_LOG,JSON.stringify([String(f),m])+"\\n")}catch(e){}return c.apply(this,arguments)};');
  const env = Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1", SPY_LOG: LOG, NODE_OPTIONS: "--require " + JSON.stringify(spy.replace(/\\/g, "/")) });
  for (const [script, args] of [["install.js", ["--no-interactive"]], ["uninstall.js", []]]) {
    if (process.platform !== "win32") fs.chmodSync(sp, 0o644);
    try { fs.unlinkSync(LOG); } catch (e) {}
    const r = cp.spawnSync(process.execPath, [p.join(__dirname, "..", "src", script), ...args, "--config-dir", CFG], { encoding: "utf8", env, windowsHide: true });
    assert.strictEqual(r.status, 0, script + " : " + (r.stderr || ""));
    const vus = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    assert.ok(vus.some(([f, m]) => /settings\.json$/.test(f) && m === 0o600), script + " : chmodSync(settings.json, 0o600) attendu : " + JSON.stringify(vus));
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(sp).mode & 0o777, 0o600, script + " : mode reel de settings.json");
  }
  // cli.js (`cqr policy port`) : chaque ecriture de settings.json est suivie d'un chmodSync 0o600 (verifie sur la source)
  const src = fs.readFileSync(p.join(__dirname, "..", "src", "cli.js"), "utf8");
  assert.ok(/fs\.writeFileSync\(SETTINGS, [^\n]*\);\s*try \{ fs\.chmodSync\(SETTINGS, 0o600\); \}/.test(src), "cli.js : chmodSync(SETTINGS, 0o600) apres l'ecriture");
  fs.rmSync(T, { recursive: true, force: true });
}
console.log("droits-sauvegardes : OK");
