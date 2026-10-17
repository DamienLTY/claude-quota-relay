// Masquage des noms et domaines de l'entreprise avant tout envoi gratuit (DR-297, DR-393). Aucun appel reseau reel : faux amont gratuit
// sur un port libre (CQR_FREE_COMPACT_URL), fausse liste d'entreprise dans un dossier temporaire (CQR_ENTREPRISE_DIR), faux PowerShell
// injecte, cle factice. Chaque scenario dit ce qu'il garde et sa contre-epreuve (ce qu'on retire pour le voir echouer).
// Run: node test/entreprise.test.js
process.env.NODE_ENV = "test"; // les variables CQR_POWERSHELL* ne valent que dans les tests
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http");

const TMP = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-ent-"));
const VARIANTE = p.join(TMP, "compactage.json");
fs.writeFileSync(VARIANTE, JSON.stringify({ variante: "court", ancre: false }));
process.env.CQR_COMPACTAGE_FILE = VARIANTE;
process.env.OPENROUTER_API_KEY = ["FAKE", "OR", "KEY", "pour", "le", "test"].join("-"); // cle factice, construite a l'execution
process.env.CQR_FREE_COMPACT_RETRY_MS = "10";
const FC = require("../src/free-compact.js");
const ENT = require("../src/entreprise.js");

const NOM = "Acme Corp", NOM2 = "Société Générale", DOMAINE = "acme-interne.example", INTERNE = "autre-reseau.example";
let seq = 0; // un dossier neuf par scenario
function poserListe({ names, internes, sansConfig, piege }) {
  const REL = p.join(TMP, "relais" + ++seq); // faux dossier d'openrouter-relay : config.json (et, pour le piege, un domaines.js)
  fs.mkdirSync(p.join(REL, "src"), { recursive: true });
  if (!sansConfig) fs.writeFileSync(p.join(REL, "config.json"), JSON.stringify({ names, internes }));
  if (piege) fs.writeFileSync(p.join(REL, "src", "domaines.js"), "require('fs').writeFileSync(" + JSON.stringify(piege) + ", 'execute'); exports.windowsDomains = () => [];");
  process.env.CQR_ENTREPRISE_DIR = REL;
  return REL;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// faux PowerShell : rend ce JSON (ou la fonction) ; le cache est remis a zero puis rempli, on attend qu'il soit pret
async function windows(rep) {
  ENT.reinitialiser(typeof rep === "function" ? rep : async () => JSON.stringify(rep));
  ENT.prechauffer();
  for (let i = 0; i < 100 && ENT.charger().repli === "masque-pas-pret"; i++) await sleep(10);
}

const TEXTE = "Contrat " + NOM + " signe. Voir https://wiki." + DOMAINE + "/page, aussi ACME CORP et acme corp, hote GIT." + DOMAINE.toUpperCase() + " et srv." + INTERNE + ".";
const corps = (texte) => ({ messages: [
  { role: "user", content: texte || TEXTE },
  { role: "assistant", content: "Note." },
  { role: "user", content: [{ type: "text", text: FC.INVITE + "\n\nFIN" }] },
] });
const AUTO = { "x-claude-code-compaction": "auto", "x-claude-code-request-class": "compaction" };
const conf = () => ({ compaction: { enabled: true, free: { enabled: true, timeoutMs: 5000, minSummaryChars: 10, fallback: "claude" } } });

// faux amont gratuit : garde chaque corps recu
const recus = [];
const faux = http.createServer((req, res) => {
  const b = []; req.on("data", (c) => b.push(c)); req.on("end", () => {
    recus.push(Buffer.concat(b).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<summary>" + "Resume du travail en cours. ".repeat(120) + "</summary>" } }] }));
  });
});

async function envoyer(texte) {
  recus.length = 0;
  const plan = FC.decide({ url: "/v1/messages", headers: AUTO, body: corps(texte) }, conf);
  assert.ok(plan && plan.go, "plan : on detourne vers le modele gratuit : " + JSON.stringify(plan));
  const r = await FC.run(plan, corps(texte), {});
  assert.ok(r.ok, "run : ok : " + JSON.stringify(r));
  assert.strictEqual(recus.length, 1, "un seul envoi au faux amont");
  return { plan, vu: recus[0] };
}
const compte = (s, sous) => s.split(sous).length - 1;
const refus = (raison, m) => {
  recus.length = 0;
  const plan = FC.decide({ url: "/v1/messages", headers: AUTO, body: corps() }, conf);
  assert.ok(plan && plan.go === false && plan.raison === raison, m + " : " + JSON.stringify(plan));
  assert.strictEqual(recus.length, 0, m + " : rien envoye au modele gratuit");
};

(async () => {
  await new Promise((ok) => faux.listen(0, "127.0.0.1", ok));
  process.env.CQR_FREE_COMPACT_URL = "http://127.0.0.1:" + faux.address().port + "/api/v1/chat/completions";
  let n = 0;
  const ok = (m) => { n++; console.log("  ok " + m); };

  // 1. nom, domaine de Windows et domaine `internes` : masques, casse comprise ; formes %20 / + et sans accents.
  //    Contre-epreuve : sans l'appel a ENT.charger() dans decide(), tout reste ; sans variantes(), %20, + et SOCIETE restent.
  poserListe({ names: [NOM, NOM2], internes: [INTERNE] });
  await windows({ d: DOMAINE, s: [], l: [] });
  { const { plan, vu } = await envoyer(TEXTE + " Lien /Acme%20Corp et ?q=Acme+Corp. " + NOM2 + " et SOCIETE GENERALE.");
    for (const s of [NOM, "ACME CORP", DOMAINE, DOMAINE.toUpperCase(), INTERNE]) assert.ok(!vu.toLowerCase().includes(s.toLowerCase()), "masque : " + s + " absent du corps gratuit");
    assert.ok(!/acme|autre-reseau/i.test(vu), "masque : aucune trace de acme ni autre-reseau (dont %20 et +)");
    assert.ok(!/soci.t. g.n.rale/i.test(vu), "masque : Societe Generale, avec ou sans accents, absent");
    assert.strictEqual(compte(vu, "[PERSO-"), 10, "10 reperes : 3 casses du nom, %20, +, domaine (2 casses), internes, 2 formes de Societe Generale");
    assert.ok(vu.includes("wiki.[PERSO-") && vu.includes("/page"), "le reste de l'adresse est conserve : wiki.<repere>/page");
    assert.deepStrictEqual(plan.masqueAlertes, [], "liste complete : pas d'alerte");
    ok("noms + domaines masques, casse, %20, + et sans accents, sans alerte"); }

  // 2. le masque est reversible
  { const plan = FC.decide({ url: "/v1/messages", headers: AUTO, body: corps() }, conf);
    const m = FC.makeMasker(plan.cfg.names), v = m.mask(TEXTE);
    assert.notStrictEqual(v, TEXTE, "le texte est bien change");
    assert.strictEqual(m.unmask(v), TEXTE, "aller-retour exact");
    ok("masque reversible"); }

  // 3. dossier du relais inconnu : rien ne part (DR-393). Contre-epreuve : ancien comportement (go true) -> le plan n'est pas un refus.
  delete process.env.CQR_ENTREPRISE_DIR;
  { const home = { u: process.env.USERPROFILE, h: process.env.HOME };
    process.env.USERPROFILE = process.env.HOME = TMP;
    try {
      refus("masque-dossier-inconnu", "dossier inconnu");
      fs.mkdirSync(p.join(TMP, ".claude-fcc"), { recursive: true });
      const REL = poserListe({ names: [NOM], internes: [] }); delete process.env.CQR_ENTREPRISE_DIR;
      for (const [txt, bon] of [["relatif/dossier", false], ["\\\\srv\\partage", false], ["//srv/partage", false], [REL, true]]) {
        fs.writeFileSync(p.join(TMP, ".claude-fcc", "relay-dir.txt"), txt + "\n");
        assert.strictEqual(ENT.charger().repli !== "masque-dossier-inconnu", bon, "relay-dir.txt " + txt + " : " + (bon ? "accepte" : "refuse"));
      }
    } finally { process.env.USERPROFILE = home.u; if (home.h === undefined) delete process.env.HOME; else process.env.HOME = home.h; }
    ok("dossier inconnu : repli ; chemin relatif ou reseau refuse"); }

  // 4. config.json absent : repli
  poserListe({ sansConfig: true }); await windows({ d: "", s: [], l: [] });
  refus("masque-config-illisible", "config absente");
  ok("config.json absent : repli");

  // 5. liste vide (0 nom, 0 domaine) : on continue, non masque, avec alerte
  poserListe({ names: [], internes: [] }); await windows({ d: "WORKGROUP", s: [], l: [] });
  { const { plan, vu } = await envoyer();
    assert.ok(vu.includes(NOM) && vu.includes(DOMAINE), "liste vide : rien masque, l'envoi a lieu");
    assert.deepStrictEqual(plan.masqueAlertes, ["liste-vide"], "alerte : liste vide");
    ok("liste vide : on continue, alerte"); }

  // 6. lecture Windows en echec : repli ; l'alerte ne garde que le code, jamais le message (qui peut contenir un domaine)
  poserListe({ names: [NOM], internes: [] });
  await windows(async () => { throw new Error("domaine interne invalide (Windows) : " + DOMAINE); });
  { const ent = ENT.charger();
    assert.strictEqual(ent.repli, "masque-windows-illisible");
    assert.ok(!JSON.stringify(ent).toLowerCase().includes("acme"), "l alerte ne porte pas le message d erreur");
    assert.deepStrictEqual(ent.alertes, ["masque-windows-illisible:erreur"], "alerte : texte fixe sans code");
    await windows(async () => { throw Object.assign(new Error("x " + DOMAINE), { code: "ENOENT" }); });
    assert.deepStrictEqual(ENT.charger().alertes, ["masque-windows-illisible:ENOENT"], "alerte : le code seul");
    refus("masque-windows-illisible", "Windows en echec");
    ok("Windows en echec : repli, alerte sans message"); }

  // 7. cache pas pret : repli immediat, jamais d'attente. Contre-epreuve : un appel PowerShell synchrone dans decide() depasserait 300 ms.
  poserListe({ names: [NOM], internes: [] });
  { let fin; ENT.reinitialiser(() => new Promise((ok2) => { fin = ok2; }));
    const t0 = Date.now();
    refus("masque-pas-pret", "cache pas pret");
    assert.ok(Date.now() - t0 < 300, "decide() n'attend pas la lecture Windows : " + (Date.now() - t0) + " ms");
    fin(JSON.stringify({ d: DOMAINE, s: [], l: [] })); await sleep(30);
    const { vu } = await envoyer();
    assert.ok(!vu.includes(NOM) && !vu.includes(DOMAINE), "cache pret : masque applique");
    ok("cache pas pret : repli immediat, puis masque"); }

  // 8. aucun code du dossier du relais n'est charge : un domaines.js piege n'est pas execute (contre-epreuve : require() de ce fichier cree le temoin)
  { const temoin = p.join(TMP, "temoin.txt");
    poserListe({ names: [NOM], internes: [], piege: temoin }); await windows({ d: DOMAINE, s: [], l: [] });
    await envoyer();
    assert.ok(!fs.existsSync(temoin), "domaines.js du dossier non execute (fichier temoin absent)");
    ok("domaines.js piege non execute"); }

  // 9. domaine d'un seul mot et nom de 2 caracteres : jamais masques
  poserListe({ names: ["ab", NOM], internes: ["lan"] }); await windows({ d: "home", s: [], l: [] });
  { const r = ENT.charger();
    assert.ok(r.noms.includes(NOM) && !r.noms.includes("ab"), "nom de moins de 3 caracteres ecarte");
    assert.deepStrictEqual(r.domaines, [], "domaine d'un seul mot ecarte");
    ok("noms courts et domaines d'un mot ecartes"); }

  // 11. config de mauvaise forme : repli, pas une liste vide (DR-393). Contre-epreuve : sans la verification de forme, ces 5 cas donnent "liste-vide" et partent.
  { const cas = [["names en chaine", { names: "Acme Corp", internes: [] }], ["internes en objet", { names: [], internes: {} }], ["entree non chaine", { names: [1], internes: [] }], ["names null", { names: null }], ["internes en chaine", { internes: "lan.acme" }]];
    for (const [nom, c] of cas) { poserListe(c); await windows({ d: "", s: [], l: [] }); assert.strictEqual(ENT.charger().repli, "masque-config-illisible", "config " + nom + " : repli"); }
    poserListe({ names: [], internes: [] }); await windows({ d: "", s: [], l: [] });
    assert.strictEqual(ENT.charger().repli, null, "liste vide voulue (deux tableaux vides) : on continue");
    ok("config de mauvaise forme : 5 replis ; deux tableaux vides : on continue"); }

  // 11b. cle absente = liste vide (DR-393, comme le relais gratuit). Contre-epreuve : l'ancienne condition (cle obligatoire) donne un repli sur ces 2 cas.
  { for (const [nom, c] of [["objet vide", {}], ["names seul", { names: [NOM] }]]) {
      poserListe(c); await windows({ d: "", s: [], l: [] });
      const r = ENT.charger(); assert.strictEqual(r.repli, null, "config " + nom + " : on continue");
      assert.deepStrictEqual(r.alertes, nom === "objet vide" ? ["liste-vide"] : [], "config " + nom + " : alerte"); }
    ok("cle absente : liste vide, on continue"); }

  // 12. separateurs dans le nom : espace insecable, doublee, tiret, souligne, absente. Contre-epreuve : sans le remplacement des espaces, 0 repere sur 5.
  { const m = FC.makeMasker([NOM]), t = "Acme Corp, Acme  Corp, Acme-Corp, Acme_Corp, AcmeCorp, Acme Corporation";
    assert.strictEqual(compte(m.mask(t), "[PERSO-"), 6, "5 formes + le debut de Corporation masques");
    assert.strictEqual(m.unmask(m.mask(t)), t, "reversible");
    assert.strictEqual(compte(FC.makeMasker([NOM]).mask("Acme et Corp"), "[PERSO-"), 0, "Acme et Corp : pas masque (pas de faux positif)");
    ok("separateurs du nom masques"); }

  // 13. variables de test ignorees hors tests ; JSON invalide sans plantage. Contre-epreuve : sans le test NODE_ENV, le temoin est cree sans NODE_ENV=test.
  { const cp = require("child_process"), temoin = p.join(TMP, "temoin-ps.txt"), src = p.join(__dirname, "..", "src", "entreprise.js");
    const essai = (env, args) => { fs.rmSync(temoin, { force: true });
      const r = cp.spawnSync(process.execPath, ["-e", "const E=require(" + JSON.stringify(src) + ");E.prechauffer();setTimeout(()=>process.exit(0),1500)"], { windowsHide: true, encoding: "utf8", env: Object.assign({}, process.env, { NODE_ENV: "", CQR_POWERSHELL: process.execPath, CQR_POWERSHELL_ARGS: args }, env) });
      return { code: r.status, temoin: fs.existsSync(temoin) }; };
    const bon = JSON.stringify(["-e", "require(\"fs\").writeFileSync(" + JSON.stringify(temoin) + ", \"x\");console.log(\"{}\")"]);
    assert.strictEqual(essai({}, bon).temoin, false, "hors tests : CQR_POWERSHELL ignore (temoin absent)");
    assert.strictEqual(essai({ NODE_ENV: "test" }, bon).temoin, true, "en test : CQR_POWERSHELL honore (temoin cree)");
    assert.strictEqual(essai({ NODE_ENV: "test" }, "{pas du json").code, 0, "JSON invalide : le module charge, pas de plantage");
    ok("variables de surcharge : tests seulement, JSON invalide sans plantage"); }

  // 10. alerte au journal, prechauffage, fichier copie a l'installation et verifie a la mise a jour
  { const lire = (d, f) => fs.readFileSync(p.join(__dirname, "..", d, f), "utf8");
    assert.ok(/for \(const a of plan\.masqueAlertes \|\| \[\]\) log\("COMPACT-GRATUIT", "masque-entreprise"/.test(lire("src", "proxy.js")), "proxy : alerte journalisee");
    assert.ok(/entreprisePrechauffer/.test(lire("src", "proxy.js")), "proxy : prechauffage au demarrage");
    assert.ok(/"free-compact\.js", "entreprise\.js"/.test(lire("src", "install.js")), "install.js copie entreprise.js");
    assert.ok(/"free-compact\.js", "entreprise\.js"/.test(lire("test", "upgrade.test.js")), "upgrade.test.js verifie entreprise.js");
    ok("alerte journalisee, prechauffage, fichier copie et verifie"); }

  faux.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(n + " scenarios ok");
})().catch((e) => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
