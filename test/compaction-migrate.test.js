// Migration de la compaction (decision utilisateur) : re-installer sur un PC ou la compaction est
// OFF ne la reactive JAMAIS en silence. En interactif on DEMANDE ; en non-interactif on laisse tel
// quel et on explique comment l'activer. Run: node test/compaction-migrate.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");
const { wantsReactivate } = require("../src/install.js"); // require ne lance PAS l'install (guard require.main)

// parsing oui/non (defaut vide = reactiver, on recommande ON)
["", "o", "O", "oui", "Oui", "y", "yes"].forEach((a) => assert.strictEqual(wantsReactivate(a), true, "'" + a + "' -> reactiver"));
["n", "N", "non", "no", "nope"].forEach((a) => assert.strictEqual(wantsReactivate(a), false, "'" + a + "' -> laisser off"));

// non-interactif : une compaction OFF existante est PRESERVEE (pas de flip silencieux) et le message
// final explique comment l'activer.
const CFG = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-mig-"));
const IDIR = p.join(CFG, "claude-quota-relay");
fs.mkdirSync(IDIR, { recursive: true });
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
fs.writeFileSync(p.join(IDIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: [{ name: "a", token: FAKE, enabled: true }], compaction: { enabled: false, dryRun: false, mode: "native" } }));

const r = cp.spawnSync(process.execPath, [p.join(__dirname, "..", "src", "install.js"), "--no-interactive", "--config-dir", CFG],
  { encoding: "utf8", env: Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1" }) });
assert.strictEqual(r.status, 0, "installer exits 0: " + (r.stderr || ""));
const conf = JSON.parse(fs.readFileSync(p.join(IDIR, "tokens.json"), "utf8"));
assert.strictEqual(conf.compaction.enabled, false, "non-interactif: compaction OFF preservee (aucun flip silencieux)");
assert.ok(/DÉSACTIVÉE/.test(r.stdout), "signale que la compaction est desactivee");
assert.ok(/cqr compact on/.test(r.stdout), "indique comment l'activer");

// une config SANS bloc compaction du tout -> backfill au defaut ON (pas de question, install neuve)
const IDIR2 = p.join(CFG, "cfg2", "claude-quota-relay");
fs.mkdirSync(IDIR2, { recursive: true });
fs.writeFileSync(p.join(IDIR2, "tokens.json"), JSON.stringify({ port: 8787, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
const r2 = cp.spawnSync(process.execPath, [p.join(__dirname, "..", "src", "install.js"), "--no-interactive", "--config-dir", p.join(CFG, "cfg2")],
  { encoding: "utf8", env: Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1" }) });
assert.strictEqual(r2.status, 0, "installer (cfg2) exits 0: " + (r2.stderr || ""));
assert.strictEqual(JSON.parse(fs.readFileSync(p.join(IDIR2, "tokens.json"), "utf8")).compaction.enabled, true, "config sans compaction -> ON par defaut");

fs.rmSync(CFG, { recursive: true, force: true });
console.log("PASS — migration compaction: OFF preservee en non-interactif + guidage; wantsReactivate OK; neuf -> ON");
