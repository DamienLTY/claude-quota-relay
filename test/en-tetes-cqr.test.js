// J5-6 (cqr:J5-018, J5-019) : les en-tetes x-cqr-compte / x-cqr-resume, de bout en bout.
// Vrai relais contre un faux Anthropic local (aucun reseau, aucun quota) : le compte demande sert CETTE requete,
// state.json garde son compte actif et son epinglage, un en-tete invalide ne casse rien, et AUCUN x-cqr-* n'atteint l'amont.
// Run: node test/en-tetes-cqr.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const TA = "sk-ant-oat01-FAKE-ACCOUNT-AAA-not-real-0000000", TB = "sk-ant-oat01-FAKE-ACCOUNT-BBB-not-real-0000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok, ko) => { const s = require("net").createServer(); s.on("error", ko); s.listen(0, "127.0.0.1", () => { const n = s.address().port; s.close(() => ok(n)); }); });
const post = (port, headers) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }));
  const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: Object.assign({ "content-type": "application/json", "content-length": data.length, authorization: "Bearer client-placeholder" }, headers) }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  req.on("error", reject); req.write(data); req.end();
});

(async () => {
  const PROXY = await freePort(), MOCK = await freePort();
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-hdr-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: PROXY, switchAtPercent: 94, sevenDayBlockPercent: 99, waitAtSoftPercent: null, compaction: { enabled: false },
    tokens: [{ name: "a", token: TA, enabled: true }, { name: "b", token: TB, enabled: true }, { name: "c", token: "sk-ant-oat01-FAKE-OFF-not-real-00000000", enabled: false }] }));
  const seed = (extra) => fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify(Object.assign({ activeIndex: 0, pct: { a: { h5: 10, d7: 10 }, b: { h5: 50, d7: 10 } }, exhausted: {}, reset5h: {}, reset7d: {} }, extra)));
  const vus = []; // en-tetes recus par le faux Anthropic, requetes reelles seulement (pas les sondes max_tokens:0)
  const mock = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      let o = {}; try { o = JSON.parse(b); } catch (e) {}
      if (!(o && o.max_tokens === 0)) vus.push(req.headers);
      res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));
  seed();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1" }), stdio: "ignore", windowsHide: true });
  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40 && !up; i++) { up = await new Promise((r) => { const q = http.get("http://127.0.0.1:" + PROXY + "/__proxy_health", (x) => { x.resume(); r(x.statusCode === 200); }); q.on("error", () => r(false)); }); if (!up) await sleep(150); }
    assert.ok(up, "relais demarre");
    await sleep(500); // la sonde de demarrage se calme
    const state = () => JSON.parse(fs.readFileSync(p.join(DIR, "state.json"), "utf8"));
    const tour = async (headers, extra) => { seed(extra); vus.length = 0; const r = await post(PROXY, headers); assert.strictEqual(r.status, 200, "requete servie : " + r.body.slice(0, 100)); assert.strictEqual(vus.length, 1, "une requete reelle a l'amont"); return vus[0]; };

    let h = await tour({});
    assert.strictEqual(h.authorization, "Bearer " + TA, "sans en-tete : politique normale, compte a");
    h = await tour({ "x-cqr-compte": "b" });
    assert.strictEqual(h.authorization, "Bearer " + TB, "x-cqr-compte: b -> compte b pour cette requete");
    let st = state();
    assert.ok(st.forceIndex == null, "state.forceIndex non cree");
    assert.strictEqual(st.activeIndex, 0, "state.activeIndex inchange (la demande ne bascule pas le relais)");
    h = await tour({ "x-cqr-compte": "b" }, { forceIndex: 0 });
    assert.strictEqual(h.authorization, "Bearer " + TB, "la demande de la requete prime sur l'epinglage global");
    assert.strictEqual(state().forceIndex, 0, "l'epinglage global est intact");
    for (const v of ["inconnu", "c", "", "B"]) { h = await tour({ "x-cqr-compte": v }); assert.strictEqual(h.authorization, "Bearer " + TA, "compte " + JSON.stringify(v) + " (inconnu/coupe/vide) : ignore, politique normale"); }
    const log = fs.readFileSync(p.join(DIR, "proxy.log"), "utf8");
    assert.ok(/x-cqr-compte ignore/.test(log), "un compte inconnu laisse une ligne de journal");
    assert.ok(!log.includes(TA) && !log.includes(TB), "le journal ne contient aucun jeton");

    // J5-027 : la demande n'est honoree que si le compte est sain ; sinon la politique normale choisit (ici le compte a)
    h = await tour({ "x-cqr-compte": "b" }, { exhausted: { b: Date.now() + 3600e3 } });
    assert.strictEqual(h.authorization, "Bearer " + TA, "compte demande epuise : servi par un autre compte");
    h = await tour({ "x-cqr-compte": "b" }, { pct: { a: { h5: 10, d7: 10 }, b: { h5: 50, d7: 99.5 } } });
    assert.strictEqual(h.authorization, "Bearer " + TA, "compte demande au-dessus du seuil hebdomadaire : servi par un autre compte");
    const log2 = fs.readFileSync(p.join(DIR, "proxy.log"), "utf8");
    assert.ok(/x-cqr-compte ignore compte=b raison=epuise/.test(log2) && /x-cqr-compte ignore compte=b raison=seuil/.test(log2), "journal : raison epuise puis seuil");

    // x-cqr-resume : sans effet sur une requete ordinaire (pas un compactage), valeurs invalides comprises
    for (const v of ["claude", "gratuit", "n'importe quoi", ""]) { h = await tour({ "x-cqr-resume": v }); assert.strictEqual(h.authorization, "Bearer " + TA, "x-cqr-resume=" + JSON.stringify(v) + " : requete servie normalement"); }

    // aucun x-cqr-* ne part vers Anthropic, quoi qu'ait envoye le client (y compris un x-cqr-* inconnu)
    h = await tour({ "x-cqr-compte": "b", "x-cqr-resume": "claude", "x-cqr-inconnu": "1" });
    assert.deepStrictEqual(Object.keys(h).filter((k) => /^x-cqr-/i.test(k)), [], "aucun x-cqr-* vers l'amont : " + Object.keys(h).join(","));
    console.log("PASS — x-cqr-compte (route par requete, state intact, inconnu ignore) ; x-cqr-resume invalide ignore ; aucun x-cqr-* vers l'amont");
  } catch (e) { failed = e; }
  finally {
    try { child.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
    await sleep(200);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
