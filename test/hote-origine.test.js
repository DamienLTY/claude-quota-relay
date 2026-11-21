// Audit 2, M1 : le relais refuse (403, sans detail) toute requete dont Host n'est pas 127.0.0.1/localhost/[::1] + son port
// (DNS rebinding) et toute requete portant Origin (un navigateur ; Claude Code n'en envoie pas). Le reste est inchange.
// Run: node test/hote-origine.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");
const SRC = p.join(__dirname, "..", "src");
const freePort = () => new Promise((ok, ko) => { const s = require("net").createServer(); s.on("error", ko); s.listen(0, "127.0.0.1", () => { const n = s.address().port; s.close(() => ok(n)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TA = "sk-ant-oat01-FAKE-HOST-TEST-not-real-0000000";

function req(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}

(async () => {
  const PROXY = await freePort(), MOCK = await freePort();
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-hote-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: PROXY, compaction: { enabled: false }, tokens: [{ name: "a", token: TA, enabled: true }] }));
  let nAmont = 0;
  const mock = http.createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => { let o = {}; try { o = JSON.parse(b); } catch (e) {} if (!(o && o.max_tokens === 0)) nAmont++; rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"ok":true}'); }); });
  await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1" }), stdio: "ignore", windowsHide: true });
  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40 && !up; i++) { up = await req(PROXY, "GET", "/__proxy_health", {}).then((r) => r.status === 200, () => false); if (!up) await sleep(150); }
    assert.ok(up, "relais demarre (Host par defaut 127.0.0.1:port accepte)");
    await sleep(500);
    const body = JSON.stringify({ model: "claude-x", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    const post = (h) => req(PROXY, "POST", "/v1/messages", Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: "Bearer x" }, h), body);

    for (const h of ["127.0.0.1:" + PROXY, "localhost:" + PROXY, "[::1]:" + PROXY, "LOCALHOST:" + PROXY]) {
      const n0 = nAmont; const r = await post({ host: h });
      assert.strictEqual(r.status, 200, "Host " + h + " accepte : " + r.status); assert.strictEqual(nAmont, n0 + 1, "Host " + h + " : servi a l'amont");
    }
    for (const h of ["evil.example:" + PROXY, "evil.example", "127.0.0.1", "127.0.0.1:" + (PROXY + 1), "localhost.evil.example:" + PROXY, "127.0.0.1.evil.example:" + PROXY]) {
      const n0 = nAmont; const r = await post({ host: h });
      assert.strictEqual(r.status, 403, "Host " + h + " refuse : " + r.status); assert.strictEqual(r.body, "", "403 sans detail : " + JSON.stringify(r.body)); assert.strictEqual(nAmont, n0, "Host " + h + " : rien a l'amont");
    }
    for (const o of ["http://evil.example", "null", "http://127.0.0.1:" + PROXY]) {
      const n0 = nAmont; const r = await post({ origin: o });
      assert.strictEqual(r.status, 403, "Origin " + o + " refuse : " + r.status); assert.strictEqual(r.body, ""); assert.strictEqual(nAmont, n0, "Origin : rien a l'amont");
    }
    let r = await req(PROXY, "GET", "/__proxy_health", { host: "evil.example:" + PROXY });
    assert.strictEqual(r.status, 403, "sante : Host etranger refuse"); assert.strictEqual(r.body, "");
    r = await req(PROXY, "GET", "/__proxy_health", { origin: "http://evil.example" });
    assert.strictEqual(r.status, 403, "sante : Origin refuse");
    r = await req(PROXY, "GET", "/__proxy_health", {});
    assert.strictEqual(r.status, 200, "sante normale : 200");
    console.log("PASS - Host 127.0.0.1/localhost/[::1]+port seuls ; Origin refuse ; 403 vide ; sante protegee");
  } catch (e) { failed = e; }
  finally { try { child.kill(); } catch (e) {} try { mock.close(); } catch (e) {} await sleep(200); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
