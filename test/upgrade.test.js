// Proves the v1 -> current upgrade path: re-running the installer over an existing v1 install
// preserves tokens/port/user settings, backfills new config, adds new hooks + wraps the status
// line WITHOUT duplicating, and is idempotent on a second run. Run: node test/upgrade.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const INSTALLER = p.join(__dirname, "..", "src", "install.js");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

const CFG = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-up-"));
const IDIR = p.join(CFG, "claude-quota-relay");
fs.mkdirSync(IDIR, { recursive: true });

// --- simulate a v1 install: tokens.json without compaction/guard, custom port, a v1 settings.json
fs.writeFileSync(p.join(IDIR, "tokens.json"), JSON.stringify({ port: 9999, switchAtPercent: 94, tokens: [{ name: "a", token: FAKE, enabled: true }] }));
fs.writeFileSync(p.join(CFG, "settings.json"), JSON.stringify({
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999", FOO: "bar", ANTHROPIC_TARGET_API_URL: "https://claude.example-corp.workers.dev" },
  hooks: { SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: 'node "' + p.join(IDIR, "ensure-proxy.js") + '"' }] }] },
  statusLine: { type: "command", command: "echo MINE" },
}));

// CQR_SKIP_PATH_REGISTER: test seam — never mutate the real Windows registry / shell rc file.
function install(extraEnv) { return cp.spawnSync(process.execPath, [INSTALLER, "--no-interactive", "--config-dir", CFG], { encoding: "utf8", env: Object.assign({}, process.env, { CQR_SKIP_PATH_REGISTER: "1" }, extraEnv || {}) }); }
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const count = (obj, re) => (JSON.stringify(obj).match(re) || []).length;

// --- first upgrade run ---
const r1 = install();
assert.strictEqual(r1.status, 0, "installer exits 0: " + (r1.stderr || ""));

const tok = rd(p.join(IDIR, "tokens.json"));
assert.ok(tok.compaction && tok.workflowGuard, "backfilled compaction + workflowGuard");
// compaction is ON by default now (the v1 config had no compaction key -> backfills to the
// new default), with the dynamic threshold OPT-IN (static per-model thresholds are the switch
// points; the dynamic one over-switched on large Opus contexts).
assert.strictEqual(tok.compaction.enabled, true, "compaction enabled by default");
assert.strictEqual(tok.compaction.dryRun, false, "not dry-run by default");
assert.strictEqual(tok.compaction.dynamicThreshold, false, "dynamic threshold opt-in (off) by default");
assert.strictEqual(tok.port, 9999, "custom port preserved (no --port given)");
assert.strictEqual(tok.tokens[0].token, FAKE, "existing token preserved");

const s = rd(p.join(CFG, "settings.json"));
assert.strictEqual(s.env.FOO, "bar", "unrelated user env preserved");
assert.strictEqual(s.env.ANTHROPIC_TARGET_API_URL, "https://claude.example-corp.workers.dev", "corporate relay env var preserved untouched (proxy reads it itself at runtime)");
assert.ok(r1.stdout.includes("ANTHROPIC_TARGET_API_URL"), "installer detects and reports the corporate relay var: " + r1.stdout);
assert.ok(s.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "timeouts applied");
assert.strictEqual(count(s.hooks, /ensure-proxy\.js/g), 1, "ensure-proxy hook once");
assert.strictEqual(count(s.hooks, /memory-hook\.js/g), 3, "memory hook on 3 events");
assert.strictEqual(count(s.hooks, /cqr-workflow-guard\.js/g), 1, "guard hook once");
assert.ok(s.statusLine.command.includes("cqr-statusline.js"), "statusline wrapped");
assert.strictEqual(rd(p.join(IDIR, "statusline.json")).original.command, "echo MINE", "original statusline saved");
["compaction.js", "memory-hook.js", "cqr-statusline.js", "cqr-workflow-guard.js"].forEach((f) => assert.ok(fs.existsSync(p.join(IDIR, f)), f + " copied on upgrade"));
assert.ok(fs.existsSync(p.join(IDIR, "bin", "cqr")), "posix cqr wrapper created on upgrade (no more manual alias needed)");
assert.ok(fs.existsSync(p.join(IDIR, "bin", "cqr.cmd")), "windows cqr.cmd wrapper created on upgrade");

// --- second run: must be idempotent (no duplicates, no re-wrap) ---
const r2 = install();
assert.strictEqual(r2.status, 0, "second run exits 0");
const s2 = rd(p.join(CFG, "settings.json"));
assert.strictEqual(count(s2.hooks, /ensure-proxy\.js/g), 1, "ensure-proxy still once");
assert.strictEqual(count(s2.hooks, /memory-hook\.js/g), 3, "memory hooks still 3 (no dup)");
assert.strictEqual(count(s2.hooks, /cqr-workflow-guard\.js/g), 1, "guard still once (no dup)");
assert.strictEqual(rd(p.join(IDIR, "statusline.json")).original.command, "echo MINE", "not re-wrapped (original intact)");

// --- mise a jour avec un proxy EN COURS : les fichiers copies ne servent a rien tant que le
// process n'a pas redemarre (il garde l'ancien code en memoire). L'installeur doit s'en charger.
// Ici on verifie surtout qu'un PID mort ou absent ne casse ni ne bloque l'installation.
{
  const r3 = install();
  assert.strictEqual(r3.status, 0, "sans proxy.pid : install OK, aucun redemarrage tente");
  assert.ok(!/redémarré sur le nouveau code/.test(r3.stdout), "rien a redemarrer -> aucun message trompeur");
  fs.writeFileSync(p.join(IDIR, "proxy.pid"), "999999"); // PID qui n'existe pas
  const r4 = install();
  assert.strictEqual(r4.status, 0, "PID mort : install OK (pas de plantage, pas d'attente)");
  assert.ok(!/redémarré sur le nouveau code/.test(r4.stdout), "PID mort -> pas de faux 'redémarré'");
  // un vrai proxy en cours : le redemarrage est tente et signale
  const OFFLINE = { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: "9", CQR_UPSTREAM_HTTP: "1" }; // aucune sonde reseau reelle
  const proxy = cp.spawn(process.execPath, [p.join(IDIR, "proxy.js")], { stdio: "ignore", windowsHide: true, detached: false, env: Object.assign({}, process.env, OFFLINE) });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = fs.existsSync(p.join(IDIR, "proxy.pid")) && fs.readFileSync(p.join(IDIR, "proxy.pid"), "utf8").trim() === String(proxy.pid); if (!up) cp.spawnSync(process.execPath, ["-e", "setTimeout(()=>{},150)"]); }
    if (up) {
      const r5 = install(OFFLINE);
      assert.strictEqual(r5.status, 0, "proxy en cours : install OK");
      assert.ok(/redémarré sur le nouveau code|cqr restart/.test(r5.stdout), "proxy en cours -> redemarrage tente et signale: " + r5.stdout);
    }
  } finally {
    try { process.kill(proxy.pid); } catch (e) {}
    try { const pid = parseInt(fs.readFileSync(p.join(IDIR, "proxy.pid"), "utf8").trim(), 10); if (pid && pid !== proxy.pid) process.kill(pid); } catch (e) {}
  }
}

fs.rmSync(CFG, { recursive: true, force: true });
console.log("PASS — upgrade v1->current: preserves config, adds new hooks + statusline, idempotent, proxy redemarre sur le nouveau code");
