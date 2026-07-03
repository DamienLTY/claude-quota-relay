// Self-contained test of the login pipeline: captureSetupToken() -> save -> syncAuthToken().
// Uses a FAKE token and a temp dir. No network, no real login. Run: node test/run.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path");
const lib = require("../src/lib.js");

(async () => {
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-test-"));
  const CONF = p.join(T, "tokens.json");
  const SETTINGS = p.join(T, "settings.json");
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: { KEEP: "x" } }));
  fs.writeFileSync(CONF, JSON.stringify({ tokens: [{ name: "account-1", token: "PASTE_TOKEN_FROM_claude_setup-token", enabled: true }] }, null, 2));

  const mock = p.join(__dirname, "mock-setup-token.js");
  const tok = await lib.captureSetupToken({ spawnCmd: process.execPath, spawnArgs: [mock] });

  assert.ok(tok && lib.TOKEN_RE.test(tok), "token should be captured from setup-token output");
  const c = JSON.parse(fs.readFileSync(CONF)); c.tokens[0].token = tok; fs.writeFileSync(CONF, JSON.stringify(c, null, 2));
  assert.strictEqual(JSON.parse(fs.readFileSync(CONF)).tokens[0].token, tok, "token should be written to tokens.json");
  assert.strictEqual(lib.syncAuthToken(c, SETTINGS), true, "syncAuthToken should succeed");
  const s = JSON.parse(fs.readFileSync(SETTINGS));
  assert.strictEqual(s.env.ANTHROPIC_AUTH_TOKEN, tok, "token should be synced into settings.json");
  assert.strictEqual(s.env.KEEP, "x", "existing settings must be preserved");

  fs.rmSync(T, { recursive: true, force: true });
  console.log("\nPASS — capture -> tokens.json -> settings.json pipeline OK");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
