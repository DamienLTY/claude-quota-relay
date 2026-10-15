// J3-0 (DR-307) : la sonde de tokens est branchee sur le relais. Le VRAI proxy tourne contre un amont factice
// (aucun reseau, aucun quota). On verifie : (1) le client recoit les memes octets qu'envoie l'amont, en clair
// comme en gzip ; (2) usage.jsonl porte les bons compteurs, le modele, l'heure, la session -- et AUCUN contenu
// de message ni jeton ; (3) une sonde en panne (coupee, module absent, journal non inscriptible) laisse le flux intact.
// Run: node test/sonde-usage.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process"), zlib = require("zlib"), net = require("net");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const TEXTE_PRIVE = "CONFIDENTIEL-phrase-du-message";
const SESSION = "11111111-2222-3333-4444-555555555555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok, ko) => { const s = net.createServer(); s.on("error", ko); s.listen(0, "127.0.0.1", () => { const n = s.address().port; s.close(() => ok(n)); }); });

// Flux SSE a la forme de l'API Messages : usage dans message_start, sortie finale dans message_delta.
const evt = (nom, obj) => "event: " + nom + "\ndata: " + JSON.stringify(obj) + "\n\n";
const SSE = [
  evt("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [], usage: { input_tokens: 12, cache_creation_input_tokens: 345, cache_read_input_tokens: 6789, output_tokens: 1 } } }),
  evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXTE_PRIVE } }),
  evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " et la suite éà中" } }),
  evt("content_block_stop", { type: "content_block_stop", index: 0 }),
  evt("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }),
  evt("message_stop", { type: "message_stop" }),
].join("");
const SSE_BUF = Buffer.from(SSE);
const SSE_GZ = zlib.gzipSync(SSE_BUF);

// coupe : "avant" = en-tetes envoyes puis connexion coupee avant tout octet de corps (le relais rejoue seul) ;
//         "apres" = un morceau du flux est parti, puis coupure (le client voit une erreur reseau et re-demande)
let coupe = null, coupesRestantes = 0;
function startMock(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        const H = { "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
        if (body.max_tokens === 0) { res.writeHead(200, Object.assign({ "content-type": "application/json" }, H)); res.end("{}"); return; }
        const gz = body.gz === true;
        res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, gz ? { "content-encoding": "gzip" } : {}, H));
        const buf = gz ? SSE_GZ : SSE_BUF;
        if (coupesRestantes > 0) {
          coupesRestantes--;
          res.flushHeaders();
          if (coupe === "apres") res.write(buf.subarray(0, 300)); // contient deja message_start et son usage
          setTimeout(() => { try { res.socket.destroy(); } catch (e) {} }, 120);
          return;
        }
        // morceaux de 37 octets : coupe au milieu des lignes et des caracteres multi-octets
        let i = 0; (function step() { if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 37)); i += 37; setTimeout(step, 1); })();
      });
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}
const health = (port) => new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + port + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
function ask(port, gz) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, stream: true, gz, messages: [{ role: "user", content: TEXTE_PRIVE }] }));
    const q = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "content-length": data.length, "x-claude-code-session-id": SESSION, "x-claude-code-request-class": "main" } }, (res) => {
      const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts) })); res.on("error", reject);
    });
    q.on("error", (e) => reject(e)); q.setTimeout(15000, () => q.destroy(new Error("TIMEOUT"))); q.write(data); q.end();
  });
}

// Lance le vrai proxy dans un dossier jetable. `sans` : fichiers a ne PAS copier ; `env` : variables en plus.
async function lancer(mockPort, { sans = [], env = {} } = {}) {
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-sonde-"));
  const port = await freePort();
  for (const f of ["proxy.js", "compaction.js", "lib.js", "sonde-sse.js"]) if (!sans.includes(f)) fs.copyFileSync(p.join(SRC, f), p.join(dir, f));
  fs.writeFileSync(p.join(dir, "tokens.json"), JSON.stringify({ port, switchAtPercent: 94, sevenDayBlockPercent: 99, maxWaitMs: 600000, pollMs: 15000, livePollMs: 0, tokens: [{ name: "compteA", token: FAKE, enabled: true }] }));
  fs.writeFileSync(p.join(dir, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));
  const child = cp.spawn(process.execPath, [p.join(dir, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(mockPort), CQR_UPSTREAM_HTTP: "1" }, env), stdio: "ignore", windowsHide: true });
  let up = false; for (let i = 0; i < 40 && !up; i++) { up = await health(port); if (!up) await sleep(150); }
  assert.ok(up, "proxy should be up");
  await sleep(300);
  return { dir, port, stop: () => { try { child.kill(); } catch (e) {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} } };
}
const lignes = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
async function attendre(f, n) { for (let i = 0; i < 40; i++) { if (lignes(f).length >= n) return; await sleep(100); } }

(async () => {
  const tmp = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-sonde-out-"));
  const mockPort = await freePort();
  const mock = await startMock(mockPort);
  const instances = [];
  let failed = null;
  try {
    // --- 1. sonde branchee : flux identique + lignes justes (clair puis gzip)
    const usage = p.join(tmp, "a", "usage.jsonl");
    const A = await lancer(mockPort, { env: { CQR_USAGE_FILE: usage } }); instances.push(A);
    const r1 = await ask(A.port, false);
    assert.strictEqual(r1.status, 200);
    assert.ok(r1.body.equals(SSE_BUF), "SSE clair : le client doit recevoir exactement les octets de l'amont");
    const r2 = await ask(A.port, true);
    assert.ok(r2.body.equals(SSE_GZ), "SSE gzip : octets identiques aussi (le client decompresse lui-meme)");
    await attendre(usage, 2);
    const L = lignes(usage);
    assert.strictEqual(L.length, 2, "une ligne par reponse, or: " + L.length);
    for (const l of L) {
      assert.strictEqual(l.modele, "claude-haiku-4-5-20251001");
      assert.strictEqual(l.input_tokens, 12); assert.strictEqual(l.output_tokens, 42);
      assert.strictEqual(l.cache_creation_input_tokens, 345); assert.strictEqual(l.cache_read_input_tokens, 6789);
      assert.strictEqual(l.arret, "end_turn"); assert.strictEqual(l.session, SESSION); assert.strictEqual(l.compte, "compteA");
      assert.ok(!Number.isNaN(Date.parse(l.ts)), "heure ISO");
    }
    assert.strictEqual(L[1].encodage, "gzip");
    const brut = fs.readFileSync(usage, "utf8");
    assert.ok(!brut.includes(TEXTE_PRIVE) && !brut.includes("suite") && !brut.includes(FAKE) && !/sk-ant/.test(brut), "usage.jsonl ne porte ni contenu de message ni jeton");
    console.log("PASS 1 — flux identique octet pour octet (clair + gzip), 2 lignes usage.jsonl justes, aucun contenu ni jeton");

    // --- 2. sonde en panne : le flux reste intact dans les trois cas
    const cas = [
      ["CQR_SONDE=0 (coupee)", { env: { CQR_SONDE: "0", CQR_USAGE_FILE: p.join(tmp, "b.jsonl") } }, p.join(tmp, "b.jsonl")],
      ["module sonde-sse.js absent", { sans: ["sonde-sse.js"], env: { CQR_USAGE_FILE: p.join(tmp, "c.jsonl") } }, p.join(tmp, "c.jsonl")],
      ["journal non inscriptible (chemin = dossier)", { env: { CQR_USAGE_FILE: tmp } }, null],
    ];
    for (const [nom, opts, f] of cas) {
      const I = await lancer(mockPort, opts); instances.push(I);
      const a = await ask(I.port, false), b = await ask(I.port, true);
      assert.ok(a.body.equals(SSE_BUF) && b.body.equals(SSE_GZ), nom + " : flux altere");
      await sleep(200);
      if (f) assert.strictEqual(lignes(f).length, 0, nom + " : aucune ligne attendue");
    }
    // --- 3. coupure de l'amont en plein flux : la tentative coupee ne laisse AUCUNE ligne, la reussie en laisse UNE
    const f3 = p.join(tmp, "d.jsonl");
    const D = await lancer(mockPort, { env: { CQR_USAGE_FILE: f3 } }); instances.push(D);
    coupe = "avant"; coupesRestantes = 1;
    const c1 = await ask(D.port, false);
    assert.ok(c1.body.includes(SSE_BUF), "coupure avant le 1er octet : le relais rejoue, le client recoit le flux complet (apres un battement de garde)");
    await attendre(f3, 1); await sleep(300);
    assert.strictEqual(lignes(f3).length, 1, "rejeu apres coupure : exactement 1 ligne, or: " + lignes(f3).length);
    coupe = "apres"; coupesRestantes = 1;
    let erreur = null; try { await ask(D.port, false); } catch (e) { erreur = e; }
    assert.ok(erreur, "coupure apres des octets : le client voit une erreur reseau");
    await sleep(400);
    assert.strictEqual(lignes(f3).length, 1, "la tentative coupee en plein flux ne doit laisser aucune ligne, or: " + lignes(f3).length);
    const c2 = await ask(D.port, false); // le client re-demande, comme Claude Code le fait
    assert.ok(c2.body.equals(SSE_BUF));
    await attendre(f3, 2); await sleep(300);
    assert.strictEqual(lignes(f3).length, 2, "1 ligne par reponse complete, pas de doublon, or: " + lignes(f3).length);
    console.log("PASS 3 — amont coupe en plein flux : pas de ligne pour la tentative coupee, pas de doublon apres reprise");

    // --- 4. la copie cqr de la sonde reste identique a celle de delest (cqr peut vivre seul : saute si delest absent)
    const delestSonde = p.join(__dirname, "..", "..", "delest", "proxy", "sonde-sse.js");
    if (fs.existsSync(delestSonde)) {
      assert.ok(fs.readFileSync(delestSonde).equals(fs.readFileSync(p.join(SRC, "sonde-sse.js"))), "src/sonde-sse.js et delest/proxy/sonde-sse.js ont diverge : les realigner");
      console.log("PASS 4 — sonde-sse.js identique octet pour octet a delest/proxy/sonde-sse.js");
    } else console.log("SKIP 4 — ../../delest absent : identite des deux copies non verifiee");

    console.log("PASS 2 — sonde coupee / module absent / journal non inscriptible : flux intact, aucune ligne parasite");
  } catch (e) { failed = e; }
  finally {
    for (const i of instances) i.stop();
    try { mock.close(); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
