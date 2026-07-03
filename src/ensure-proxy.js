#!/usr/bin/env node
/* Hook SessionStart : garantit que le proxy de failover tourne avant que Claude
 * n'envoie sa premiere requete. Verifie /__proxy_health, le demarre detache sinon,
 * et attend (bornage court) qu'il reponde. Silencieux et non bloquant en cas d'echec. */
const fs = require("fs"), p = require("path"), http = require("http"), cp = require("child_process");
// Repertoire d'installation = dossier de ce script (portable, quel que soit l'emplacement).
const DIR = __dirname;
const PROXY = p.join(DIR, "proxy.js");
let PORT = 8787;
try { PORT = JSON.parse(fs.readFileSync(p.join(DIR, "tokens.json"), "utf8")).port || 8787; } catch (e) {}

function ping() {
  return new Promise((res) => {
    const req = http.get("http://127.0.0.1:" + PORT + "/__proxy_health", (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
    req.setTimeout(800, () => { req.destroy(); res(false); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  if (await ping()) { process.exit(0); }
  if (!fs.existsSync(PROXY)) { process.exit(0); }
  try {
    const out = fs.openSync(p.join(DIR, "proxy.out.log"), "a");
    const child = cp.spawn(process.execPath, [PROXY], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
    child.unref();
  } catch (e) { process.exit(0); }
  for (let i = 0; i < 12; i++) { await sleep(250); if (await ping()) break; }
  process.exit(0);
})();
