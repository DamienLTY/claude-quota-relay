// DR-048 : le journal (proxy.log) note le TYPE de chaque requete et les compactages que Claude Code annonce.
// Vrai relais, faux amont local (aucun reseau, aucun quota). Claude Code, avec
// CLAUDE_CODE_GATEWAY_HINT_HEADERS=1, ajoute x-claude-code-request-class, x-claude-code-session-id et, pendant un
// compactage, x-claude-code-compaction. Le relais :
//   - ajoute classe=<type> et session=<8 premiers caracteres> aux lignes RESP ;
//   - ecrit une ligne CLAUDE-COMPACT (distincte de COMPACT, la compaction du relais a la bascule) ;
//   - n'ecrit JAMAIS l'identifiant de session en entier, ni un jeton ;
//   - ne transmet PAS les 6 en-tetes d'indice a l'amont (le journal les lit, c'est leur seul usage), mais laisse
//     passer ceux que Claude Code envoie de toute facon (session, agent, agent parent).
// Run: node test/journal-compactage.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const PROXY_PORT = 8812, MOCK_PORT = 8813;
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const SESSION = "0123abcd-4567-89ef-0123-456789abcdef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vu = []; // en-tetes recus par l'amont, une entree par requete (hors sonde)
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        let body = {}; try { body = JSON.parse(b); } catch (e) {}
        if (!(body && body.max_tokens === 0)) vu.push(req.headers);
        res.writeHead(200, { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.10", "anthropic-ratelimit-unified-7d-utilization": "0.10", "anthropic-ratelimit-unified-status": "allowed" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}
function post(headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "salut" }] }));
    const req = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/v1/messages", method: "POST", agent: false,
      headers: Object.assign({ "content-type": "application/json", "content-length": data.length, "authorization": "Bearer client-placeholder" }, headers) }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
const health = () => new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + PROXY_PORT + "/__proxy_health", { agent: false }, (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); });

(async () => {
  const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-journal-"));
  for (const f of ["proxy.js", "compaction.js", "lib.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
  fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: PROXY_PORT, switchAtPercent: 94, sevenDayBlockPercent: 99, compaction: { enabled: false, dryRun: false }, tokens: [{ name: "compte1", token: FAKE, enabled: true }] }));
  fs.writeFileSync(p.join(DIR, "state.json"), JSON.stringify({ activeIndex: 0, pct: { compte1: { h5: 10, d7: 10 } }, exhausted: {}, reset5h: {}, reset7d: {} }));
  const mock = await startMock();
  const child = cp.spawn(process.execPath, [p.join(DIR, "proxy.js")], { env: Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_PORT), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1" }), stdio: "ignore", windowsHide: true });
  const journal = () => { try { return fs.readFileSync(p.join(DIR, "proxy.log"), "utf8"); } catch (e) { return ""; } };
  const lignes = (re) => journal().split("\n").filter((l) => re.test(l));

  let failed = null;
  try {
    let up = false; for (let i = 0; i < 40; i++) { if (await health()) { up = true; break; } await sleep(150); }
    assert.ok(up, "le relais doit demarrer");
    await sleep(600); // la sonde de demarrage se pose

    // --- 1. tour normal : le type et le debut de session sont aux lignes RESP ---
    assert.strictEqual(await post({ "x-claude-code-request-class": "main", "x-claude-code-session-id": SESSION }), 200);
    let resp = lignes(/ RESP 200 token=compte1 classe=main /);
    assert.strictEqual(resp.length, 1, "une ligne RESP avec classe=main : " + journal().slice(-600));
    assert.ok(/ classe=main session=0123abcd rl= /.test(resp[0]), "classe=<type> session=<8 caracteres> avant rl= : " + resp[0].slice(0, 160));
    assert.strictEqual(lignes(/CLAUDE-COMPACT/).length, 0, "pas de ligne de compactage sans en-tete de compactage");

    // --- 2. requete de compactage : une ligne distincte, une seule ---
    assert.strictEqual(await post({ "x-claude-code-request-class": "compaction", "x-claude-code-compaction": "auto", "x-claude-code-session-id": SESSION }), 200);
    const cc = lignes(/CLAUDE-COMPACT/);
    assert.strictEqual(cc.length, 1, "une seule ligne CLAUDE-COMPACT par requete : " + cc.length);
    assert.ok(/CLAUDE-COMPACT motif=auto classe=compaction session=0123abcd model=claude-sonnet-5-5$/.test(cc[0]), "motif, type, session, modele : " + cc[0]);
    assert.ok(!/ COMPACT /.test(cc[0]), "ce n'est pas une ligne COMPACT (la compaction du relais)");
    assert.strictEqual(lignes(/ RESP 200 token=compte1 classe=compaction /).length, 1, "la reponse du compactage porte aussi classe=compaction");

    // les trois motifs documentes
    await post({ "x-claude-code-request-class": "compaction", "x-claude-code-compaction": "manual", "x-claude-code-session-id": SESSION });
    await post({ "x-claude-code-request-class": "compaction", "x-claude-code-compaction": "reactive", "x-claude-code-session-id": SESSION });
    assert.deepStrictEqual(lignes(/CLAUDE-COMPACT/).map((l) => /motif=(\w+)/.exec(l)[1]), ["auto", "manual", "reactive"], "motifs auto / manual / reactive");

    // --- 3. autres types : sous-agent, et client sans en-tetes (ancien Claude Code, autre outil) ---
    await post({ "x-claude-code-request-class": "subagent", "x-claude-code-session-id": SESSION });
    assert.strictEqual(lignes(/ classe=subagent session=0123abcd /).length, 1, "classe=subagent");
    await post({});
    assert.strictEqual(lignes(/ RESP 200 token=compte1 classe=- session=- /).length, 1, "sans en-tetes : classe=- session=-, la ligne reste de la meme forme");

    // --- 4. une valeur d'en-tete ne casse pas la ligne ---
    await post({ "x-claude-code-request-class": "a b;c=d\"e", "x-claude-code-session-id": "ab cd/ef\tgh-ij" });
    assert.strictEqual(lignes(/ classe=abcde session=abcdefgh /).length, 1, "caracteres hors [A-Za-z0-9_-] retires : " + journal().split("\n").filter((l) => / RESP /.test(l)).pop().slice(0, 120));

    // --- 5. jamais l'identifiant complet, jamais un jeton ---
    const tout = journal();
    assert.ok(!tout.includes(SESSION) && !tout.includes("456789abcdef") && !tout.includes("4567-89ef"), "l'identifiant de session n'est jamais note en entier");
    assert.ok(!tout.includes(FAKE) && !tout.includes("sk-ant-"), "aucun jeton au journal");

    // --- 6. les 6 en-tetes d'indice n'arrivent PAS a l'amont ; la session (et l'agent) y arrivent toujours ---
    const INDICES = ["x-claude-code-request-class", "x-claude-code-agent-type", "x-claude-code-prompt-id",
      "x-claude-code-compaction", "x-claude-code-context-compacted", "x-claude-code-prev-tool-durations"];
    const premier = vu[0];
    assert.strictEqual(premier["x-claude-code-request-class"], undefined, "en-tete de type retire avant l'amont");
    assert.strictEqual(premier["x-claude-code-session-id"], SESSION, "identifiant de session transmis a l'amont (le relais ne le tronque que dans SON journal)");
    assert.strictEqual(vu[1]["x-claude-code-compaction"], undefined, "en-tete de compactage retire avant l'amont");
    const avant = vu.length, compactAvant = lignes(/CLAUDE-COMPACT/).length;
    await post({ "x-claude-code-request-class": "main", "x-claude-code-agent-type": "general-purpose", "x-claude-code-prompt-id": "p-123",
      "x-claude-code-compaction": "auto", "x-claude-code-context-compacted": "true", "x-claude-code-prev-tool-durations": "12,34",
      "x-claude-code-session-id": SESSION, "x-claude-code-agent-id": "agent-1", "x-claude-code-parent-agent-id": "agent-0" });
    assert.strictEqual(vu.length, avant + 1, "la requete aux 9 en-tetes est arrivee a l'amont");
    const complet = vu[avant];
    for (const h of INDICES) assert.strictEqual(complet[h], undefined, h + " n'arrive pas a l'amont");
    assert.strictEqual(complet["x-claude-code-session-id"], SESSION, "session-id arrive a l'amont");
    assert.strictEqual(complet["x-claude-code-agent-id"], "agent-1", "agent-id arrive a l'amont");
    assert.strictEqual(complet["x-claude-code-parent-agent-id"], "agent-0", "parent-agent-id arrive a l'amont");
    assert.strictEqual(lignes(/CLAUDE-COMPACT/).length, compactAvant + 1, "le journal, lui, a lu l'en-tete de compactage de cette requete (creq.headers intact)");
    console.log("PASS — journal : classe= et session= (8 car.) sur RESP, ligne CLAUDE-COMPACT distincte (auto/manual/reactive), valeurs assainies, jamais d'identifiant complet ni de jeton, les 6 en-tetes d'indice retires avant l'amont (session, agent, agent parent transmis)");
  } catch (e) { failed = e; }
  try { child.kill(); } catch (e) {} mock.close();
  await sleep(300);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
