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
console.log("droits-sauvegardes : OK");
