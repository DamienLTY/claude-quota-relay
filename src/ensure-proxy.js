#!/usr/bin/env node
/* Hook SessionStart : garantit que le proxy de failover tourne avant que Claude
 * n'envoie sa premiere requete. Verifie /__proxy_health, le demarre detache sinon,
 * et attend (bornage court) qu'il reponde. Silencieux et non bloquant en cas d'echec. */
const fs = require("fs"), p = require("path"), http = require("http"), cp = require("child_process");
// Repertoire d'installation = dossier de ce script (portable, quel que soit l'emplacement).
const DIR = __dirname;
const PROXY = p.join(DIR, "proxy.js");
let PORT = 8787;
// tokens.json : ~/.etabli/cles/cqr-tokens.json s'il existe, sinon ici (DR-220 ; repli DR-226, permanent). Meme regle que lib.confPath,
// recopiee : ce hook doit marcher seul dans son dossier (les tests le copient sans lib.js). Un test garde les copies identiques.
function confPath(dir) {
  const ancien = p.join(dir, "tokens.json");
  try {
    const os = require("os");
    const norm = (x) => (process.platform === "win32" ? p.resolve(x).toLowerCase() : p.resolve(x));
    const cfg = process.env.CLAUDE_CONFIG_DIR || p.join(os.homedir(), ".claude");
    if (norm(dir) !== norm(p.join(cfg, "claude-quota-relay"))) return ancien;
    const cles = p.join(os.homedir(), ".etabli", "cles", "cqr-tokens.json");
    return fs.existsSync(cles) ? cles : ancien;
  } catch (e) { return ancien; }
}
// Meme regle que lib.isPlaceholder, recopiee (meme raison). Un test garde la parite.
function isPlaceholder(t) { return !t || !t.token || /^(PASTE|REMPLACE|<)/i.test(t.token); }
// J7B-020 / DR-271 : sans aucun compte (jeton non fictif), cqr est installe mais eteint : ce hook ne lance rien.
// Fichier absent, illisible ou sans liste de comptes -> comportement d'avant (on ne casse pas un poste dont le fichier
// est en cours d'ecriture) : AUCUN_COMPTE reste false.
let AUCUN_COMPTE = false;
try {
  const conf = JSON.parse(fs.readFileSync(confPath(DIR), "utf8"));
  PORT = conf.port || 8787;
  if (Array.isArray(conf.tokens) && !conf.tokens.some((t) => !isPlaceholder(t))) AUCUN_COMPTE = true;
} catch (e) {}

function ping() {
  return new Promise((res) => {
    const req = http.get("http://127.0.0.1:" + PORT + "/__proxy_health", (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
    req.setTimeout(800, () => { req.destroy(); res(false); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  if (AUCUN_COMPTE) { process.exit(0); }
  if (await ping()) { process.exit(0); }
  if (!fs.existsSync(PROXY)) { process.exit(0); }
  try {
    const out = fs.openSync(p.join(DIR, "proxy.out.log"), "a");
    // Qui a lance le relais : transmis tel quel s'il vient du gardien de la statusline (DR-012).
    const env = Object.assign({}, process.env, { CQR_STARTED_BY: process.env.CQR_STARTED_BY || "sessionstart" });
    const child = cp.spawn(process.execPath, [PROXY], { detached: true, stdio: ["ignore", out, out], windowsHide: true, env });
    child.unref();
  } catch (e) { process.exit(0); }
  for (let i = 0; i < 12; i++) { await sleep(250); if (await ping()) break; }
  process.exit(0);
})();
