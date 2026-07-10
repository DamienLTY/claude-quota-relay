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

fs.rmSync(DIR, { recursive: true, force: true });
console.log("PASS — cqr help lists commands; compact dynamic on auto-enables compaction; unknown -> help");
