// Compactage gratuit (DR-069 a DR-072) : le relais reel (copie jetable) contre un FAUX Anthropic et un FAUX OpenRouter, sur des
// ports locaux. Aucun appel reseau reel : CQR_FREE_COMPACT_URL et CQR_UPSTREAM_HOST sont toujours poses, la cle est factice.
// Groupes : fonctions pures (rendu, reconnaissance, masquage, derive des motifs) / succes / non-detournement / repli / masquage /
// client parti / delai avant le flux / adresse imposee a la machine / en process (blocage, reponse piegee, dossier) / commande cqr.
// Run: node test/free-compact.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), cp = require("child_process");
const FC = require("../src/free-compact.js");

const SRC = p.join(__dirname, "..", "src");
const VARIANTE_FILE = p.join(os.tmpdir(), "cqr-compactage-" + process.pid + ".json"); // jamais le vrai ~/.etabli/compactage.json
process.env.CQR_COMPACTAGE_FILE = VARIANTE_FILE;
const setVariante = (v, extra) => fs.writeFileSync(VARIANTE_FILE, JSON.stringify(Object.assign({ variante: v }, extra)));
setVariante("court"); // les scenarios d'origine portent sur la conversation entiere ; les variantes ont leurs scenarios
const PORT_A = 8820, MOCK_ANTH = 8821, MOCK_OR = 8822, PORT_B = 8823, PORT_C = 8824, PORT_D = 8825, PORT_E = 8826;
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";
const FAKE_OR_KEY = "FAKE-OR-KEY-pour-le-test-9f8e7d";
const CFG_TOKEN = ["cfgtok", "Zv8Lq2Rm5Xd7Pw"].join("-"); // jeton de la config des relais d'essai : aucun motif ne le reconnait, seule sa valeur exacte le masque
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- les chaines de la conversation d'essai ----------
const HOME = os.homedir(), USER = os.userInfo().username, EXTRA = "Zorglub-Nom";
const drive = /^([A-Za-z]):[\\/](.*)$/.exec(HOME);
const FORMS = [HOME, HOME.replace(/\\/g, "/"), drive ? "/" + drive[1].toLowerCase() + "/" + drive[2].replace(/\\/g, "/") : HOME, HOME.replace(/[^A-Za-z0-9]/g, "-")];
const PERSONAL = [...new Set([...FORMS, USER, USER.toUpperCase(), EXTRA, EXTRA.toLowerCase()])];
// jetons factices construits a l'execution : aucun secret ne s'ecrit en clair dans ce fichier
const TOKEN_ANT = "sk-ant-oat01-FAKE-MASQUE-ME-0123456789abcdef";
const TOKEN_OR = ["sk", "or", "v1", "e7c1a9d03b5f4a2c8d6e1f0a9b8c7d6e5f4a3b2c1d0e"].join("-");
const PASSWORD = "Zq9" + "xK2mLp7vB";
const INVITE_TAIL = "FIN-DE-L-INVITE";
const PEM_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY-----";
const PUB_KEY = ["-----BEGIN " + "PUBLIC KEY-----", "abc", "-----END " + "PUBLIC KEY-----"].join("\n");
const PEM = (fin) => [PEM_BEGIN, "KEYMATERIAL-LIGNE-A", "KEYMATERIAL-LIGNE-B", ...(fin ? ["-----END " + "RSA PRIVATE KEY-----"] : [])].join("\n");

function compactBody(o) {
  o = o || {};
  return {
    model: "claude-opus-4-8", max_tokens: 20000, stream: o.stream !== false,
    system: "SYSTEME-NE-PART-PAS", tools: [{ name: "OUTIL-NE-PART-PAS", description: "x", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: o.big ? "x".repeat(3300000) : "Je travaille dans " + FORMS[0] + " (" + FORMS[1] + ", " + FORMS[2] + "), projet " + FORMS[3] + ". Je suis " + USER + " alias " + USER.toUpperCase() + ", collegue " + EXTRA + " / " + EXTRA.toLowerCase() + ". Reperes litteraux : [PERSO-1]. Cle en clair : " + FAKE_OR_KEY + ". Jeton de config en clair : " + CFG_TOKEN + "." },
      { role: "assistant", content: [{ type: "thinking", thinking: "PENSEE-NE-PART-PAS", signature: "sig" }, { type: "text", text: "Je lis le fichier." }, { type: "tool_use", id: "toolu_01ABCDEFGH", name: "Bash", input: { command: "cat " + HOME + "/.env", description: "lire" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01ABCDEFGH", content: [{ type: "text", text: "ANTHROPIC_API_KEY=" + TOKEN_ANT + "\npassword=" + PASSWORD + "\nOPENROUTER=" + TOKEN_OR + "\n" + PEM(true) }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "document", source: { type: "text", data: "DOC" } }] }] },
      { role: "assistant", content: "Note." },
      { role: "user", content: [{ type: "text", text: FC.INVITE + "\n\nDetails de l'invite. " + INVITE_TAIL }] },
    ],
  };
}
const AUTO = { "x-claude-code-compaction": "auto", "x-claude-code-request-class": "compaction" };

// ---------- 1. fonctions pures ----------
{
  const txt = FC.renderConversation(compactBody());
  assert.ok(txt.startsWith("=== USER ==="), "rendu : l'entete de role ouvre le texte");
  assert.ok(txt.includes("=== ASSISTANT ===") && txt.includes("[tool call Bash #CDEFGH]"), "rendu : appel d'outil [tool call nom #id6]");
  assert.ok(txt.includes("command: cat " + HOME), "rendu : entree de l'outil, une ligne par champ");
  assert.ok(txt.includes("=== USER [tool result #CDEFGH] ==="), "rendu : resultat d'outil sous son entete");
  assert.ok(txt.includes("[image]") && txt.includes("[document]"), "rendu : image et document deviennent des reperes");
  for (const nope of ["PENSEE-NE-PART-PAS", "SYSTEME-NE-PART-PAS", "OUTIL-NE-PART-PAS"]) assert.ok(!txt.includes(nope), "rendu : " + nope + " ecarte (thinking, systeme, outils)");
  assert.ok(txt.trimEnd().endsWith(INVITE_TAIL), "rendu : l'invite reste en dernier");
  assert.ok(txt.lastIndexOf(FC.INVITE) > txt.indexOf("[tool call"), "rendu : l'invite vient apres la conversation");
}
{
  const body = compactBody(), ok = (h, b, u) => FC.recognize(u || "/v1/messages", h, b || body);
  assert.deepStrictEqual(ok(AUTO), { kind: "auto" }, "reconnu : auto");
  assert.deepStrictEqual(ok({ "x-claude-code-compaction": "manual" }), { kind: "manual" }, "reconnu : manual sans en-tete de classe");
  assert.deepStrictEqual(ok({ "x-claude-code-compaction": "reactive" }), { kind: "reactive" }, "reconnu : reactive (c'est decide() qui le refuse)");
  assert.strictEqual(ok({}), null, "sans en-tete de type : pas un compactage connu");
  assert.strictEqual(ok({ "x-claude-code-compaction": "auto", "x-claude-code-request-class": "main" }), null, "classe annoncee autre que compaction");
  assert.strictEqual(ok(AUTO, body, "/v1/messages/count_tokens"), null, "autre chemin que /v1/messages");
  assert.strictEqual(ok(AUTO, { messages: [{ role: "user", content: "bonjour" }] }), null, "dernier message sans l'invite native");
  assert.strictEqual(ok(AUTO, { messages: [{ role: "assistant", content: FC.INVITE }] }), null, "invite dans un message assistant");
  assert.deepStrictEqual(ok(AUTO, { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }, { type: "text", text: FC.INVITE + " ..." }] }] }), { kind: "auto" }, "invite fusionnee apres un tool_result");
  assert.deepStrictEqual(ok(AUTO, { messages: [{ role: "user", content: "  " + FC.INVITE }] }), { kind: "auto" }, "invite en chaine simple");
  // Forme reelle de Claude Code 2.1.289 : des messages "system" au milieu, un "system" vide en dernier, l'invite dans l'avant-dernier "user".
  const msgs = compactBody().messages, reel = { messages: [msgs[0], { role: "system", content: [{ type: "text", text: "# Environment update" }] }, ...msgs.slice(1), { role: "system", content: [] }] };
  assert.deepStrictEqual(ok(AUTO, reel), { kind: "auto" }, "forme reelle : system au milieu, system vide en dernier, invite dans l'avant-dernier user");
  assert.ok(FC.renderConversation(reel).includes("=== SYSTEM ===\n# Environment update"), "rendu : un system du milieu reste rendu tel quel");
  assert.strictEqual(ok(AUTO, { messages: [{ role: "user", content: "bonjour" }, { role: "system", content: [] }] }), null, "requete ordinaire finissant par un system : pas detournee");
  assert.strictEqual(ok(AUTO, { messages: [{ role: "user", content: FC.INVITE }, { role: "assistant", content: "ok" }, { role: "system", content: [] }] }), null, "invite suivie d'un assistant puis d'un system : pas detournee");
}
{
  const m = FC.maskSecrets([TOKEN_ANT, "x password=" + PASSWORD + " y", "k " + TOKEN_OR, "texte ordinaire 12345 sans secret", "api_key: " + "ab12".repeat(8), PEM_BEGIN].join("\n"));
  for (const s of [TOKEN_ANT, PASSWORD, TOKEN_OR, "ab12".repeat(8), "BEGIN RSA PRIVATE KEY-----"]) assert.ok(!m.includes(s.replace("-----", "")), "masque : " + s.slice(0, 8) + "... ne survit pas");
  assert.ok(m.includes("texte ordinaire 12345 sans secret"), "masque : le texte ordinaire est intact");
  assert.ok(m.includes("password=[SECRET-MASQUE] y"), "masque : seule la valeur est remplacee");
  assert.ok(!FC.maskSecrets("sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000").includes("FAKE-TEST"), "masque : un jeton qui se dit factice est masque aussi (le scanner l'ignore, pas le masqueur)");
}
// cle privee : du BEGIN au END sur plusieurs lignes, ou jusqu'a la fin du texte sans END
{
  const m = FC.maskSecrets("avant\n" + PEM(true) + "\napres");
  assert.ok(!m.includes("KEYMATERIAL") && !m.includes("PRIVATE KEY") && m.startsWith("avant\n") && m.endsWith("\napres"), "cle privee : tout le bloc, et rien que lui : " + JSON.stringify(m));
  const m2 = FC.maskSecrets("avant\n" + PEM(false) + "\nsuite du texte");
  assert.ok(!m2.includes("KEYMATERIAL") && !m2.includes("suite du texte") && m2.startsWith("avant\n"), "cle privee sans END : jusqu'a la fin du texte : " + JSON.stringify(m2));
  assert.strictEqual(FC.maskSecrets(PUB_KEY), PUB_KEY, "cle publique : intacte");
}
// cle privee sans END dans un resultat d'outil : le masque s'arrete au prochain en-tete de role, l'invite finale reste intacte
{
  const conv = (resultat) => FC.renderConversation({ messages: [
    { role: "user", content: "Lis la cle." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_01KEYKEY", name: "Bash", input: { command: "cat k" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01KEYKEY", content: resultat }] },
    { role: "assistant", content: "Vu, merci." },
    { role: "user", content: [{ type: "text", text: FC.INVITE + "\n\nDetails de l'invite. " + INVITE_TAIL }] },
  ] });
  for (const [nom, resultat, suite] of [["BEGIN seul", PEM_BEGIN, []], ["BEGIN puis le corps du meme resultat", PEM_BEGIN + "\nKEYMATERIAL-LIGNE-A\nSUITE-DU-MEME-RESULTAT", ["KEYMATERIAL", "SUITE-DU-MEME-RESULTAT"]]]) {
    const m = FC.maskSecrets(conv(resultat));
    assert.ok(!m.includes("PRIVATE KEY") && suite.every((s) => !m.includes(s)), "cle sans END (" + nom + ") : l'en-tete et le corps du resultat sont masques : " + JSON.stringify(m.slice(0, 200)));
    assert.ok(m.includes("=== ASSISTANT ===\nVu, merci.") && m.includes(FC.INVITE) && m.trimEnd().endsWith(INVITE_TAIL), "cle sans END (" + nom + ") : le message suivant et l'invite finale restent intacts : " + JSON.stringify(m.slice(-300)));
  }
}
// motif d'adresse : le schema est borne, une ligne a.b-a.b-... ne fige plus le relais (320 Ko = 111 s avant). Processus fils : delai de garde, jamais un test qui pend.
{
  const r = cp.spawnSync(process.execPath, ["-e", "const FC = require(" + JSON.stringify(p.join(SRC, "free-compact.js")) + "); const t0 = Date.now(); FC.maskSecrets('a.b-'.repeat(750000)); process.stdout.write(String(Date.now() - t0));"], { timeout: 15000, encoding: "utf8" });
  assert.strictEqual(r.status, 0, "adresse : 3 Mo de a.b- masques sans figer (delai de garde de 15 s) : " + (r.error ? r.error.code : r.status));
  assert.ok(Number(r.stdout) < 2000, "adresse : 3 Mo de a.b- masques en moins de 2 s : " + r.stdout + " ms");
}
// sonde : une ligne par forme de secret, la valeur doit disparaitre et le repere apparaitre, sans toucher aux lignes voisines
{
  const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "c2lnbmF0dXJl"].join(".");
  const FORMES = [
    ["JWT", "jeton de session " + JWT, [JWT]],
    ["Authorization Bearer", 'curl -H "Authorization: Bearer OPAQUE-BEARER-ab12cd34ef"', ["OPAQUE-BEARER-ab12cd34ef"]],
    ["Authorization Basic", "Authorization: Basic dXNlcjpwYXNz", ["dXNlcjpwYXNz"]],
    ["adresse avec mot de passe", "postgres://admin:Pa55-XYZ@db.local:5432/x", ["Pa55-XYZ"]],
    ["adresse, mot de passe avec @", "https://bob:p@ss-w0rd@hote.local/", ["p@ss-w0rd", "ss-w0rd"]],
    ["Cookie", "Cookie: sessionid=aaSESSION11; csrftoken=bbCSRF22", ["aaSESSION11", "bbCSRF22"]],
    ["Set-Cookie", "Set-Cookie: sid=cc-SID-33; Path=/; HttpOnly", ["cc-SID-33"]],
    ["password court, sans chiffre", "password=hunter", ["hunter"]],
    ["pwd court", "pwd: abcd", ["abcd"]],
    ["passwd entre guillemets simples", "passwd = 'letmein'", ["letmein"]],
    ["secret entre guillemets, avec espaces", 'secret: "pas de chiffre ici"', ["pas de chiffre ici", "chiffre"]],
    ["token sans chiffre", "TOKEN=zzyyxx", ["zzyyxx"]],
    ["api_key", "api_key: plainvalue", ["plainvalue"]],
    ["apikey en JSON", '{"apikey": "mot compose"}', ["mot compose"]],
    ["JSON echappe", '{\\"password\\": \\"deux mots\\"}', ["deux mots"]],
    ["comparaison", 'if (password == "unmotdepasse")', ["unmotdepasse"]],
    ["sk_test_", "STRIPE=sk_test_abc", ["sk_test_abc"]],
    ["sk_live_", "STRIPE=sk_live_abc12", ["sk_live_abc12"]],
    ["rk_live_", "STRIPE=rk_live_abc12", ["rk_live_abc12"]],
    ["sshpass", "sshpass -p Sh0wMe ssh hote", ["Sh0wMe"]],
    ["mysql -p", "mysql -u root -pRootPw1 db", ["RootPw1"]],
    ["option --password avec espace", "run --password abcd1234efgh --verbose", ["abcd1234efgh"]],
    ["curl -u", "curl -u admin:Sup3rS3cret https://hote.local/x", ["Sup3rS3cret"]],
    ["curl --user", "curl --user admin:Sup3rS3cret https://hote.local/x", ["Sup3rS3cret"]],
    ["docker login -p", "docker login -p hunter2 registre.local", ["hunter2"]],
    ["PASS majuscules", "PASS=abc", ["abc"]],
    ["pass minuscules", "pass=abc123", ["abc123"]],
    ["PRIVATE_KEY", "PRIVATE_KEY=0x1234abcd", ["0x1234abcd"]],
    ["access_key", "access_key=AKxyz", ["AKxyz"]],
  ];
  let n = 0;
  for (const [nom, ligne, valeurs] of FORMES) {
    const m = FC.maskSecrets("avant\n" + ligne + "\napres");
    for (const v of valeurs) assert.ok(!m.includes(v), "sonde " + nom + " : " + v + " survit : " + JSON.stringify(m));
    assert.ok(m.includes("[SECRET-MASQUE]") && m.startsWith("avant\n") && m.endsWith("\napres"), "sonde " + nom + " : masque, et seulement cette ligne : " + JSON.stringify(m));
    n++;
  }
  const ex = FC.maskSecrets("cle " + FAKE_OR_KEY + " et jeton " + CFG_TOKEN + " fin", [FAKE_OR_KEY, CFG_TOKEN]);
  assert.ok(!ex.includes(FAKE_OR_KEY) && !ex.includes(CFG_TOKEN) && ex.startsWith("cle ") && ex.endsWith(" fin"), "valeurs exactes : la cle OpenRouter et le jeton de config sont masques : " + ex); n += 2;
  for (const fin of [true, false]) { assert.ok(!FC.maskSecrets(PEM(fin)).includes("KEYMATERIAL")); n++; }
  // un nombre de jetons n'est pas un secret ; un code numerique derriere password, secret ou api_key en est un
  for (const l of ["max_tokens: 32768", '"input_tokens": 1234', "cache_read_input_tokens=98 765"]) assert.strictEqual(FC.maskSecrets(l), l, "nombre de jetons : intact : " + l);
  for (const [l, v] of [["token=abc123def", "abc123def"], ["password: 123456", "123456"], ["api_key=12345678", "12345678"], ["token_secret: 123456", "123456"]]) { const m = FC.maskSecrets(l); assert.ok(!m.includes(v) && m.includes("[SECRET-MASQUE]"), "valeur numerique : masquee : " + m); }
  assert.ok(n >= 17, "sonde : au moins 17 formes");
  console.log("PASS — sonde du masqueur : " + n + " formes de secret masquees (dont cle privee avec et sans END, valeurs exactes)");
  for (const ok of ["Je lis le fichier.", "const total = 12;", "x = y + 1", "authorization requise", "le cookie est bon", "tests passed: 14", "bypass = true", "passage=3", "const key = 1;", "docker login registre.local", "curl https://exemple.org -o out.txt"]) assert.strictEqual(FC.maskSecrets(ok), ok, "sonde : texte ordinaire intact : " + ok);
}
{
  const mk = FC.makeMasker(["C:\\Users\\bob", "bob", "Bob"]);
  const t = "C:\\Users\\bob\\x et bob et Bob et BOB et c:\\users\\BOB";
  const masked = mk.mask(t);
  assert.ok(!/bob/i.test(masked), "reperes : aucune forme du nom ne reste : " + masked);
  assert.strictEqual(new Set(masked.match(/\[PERSO-[0-9a-f]{6}-\d+\]/g)).size, 5, "reperes : un repere distinct par chaine d'origine, casse comprise");
  assert.strictEqual(mk.unmask(masked), t, "reperes : remise en clair a l'octet pres");
  assert.strictEqual(mk.unmask("[PERSO-99] inconnu"), "[PERSO-99] inconnu", "reperes : un repere d'un autre format reste tel quel");
  // nonce par execution : un [PERSO-1] du texte d'origine n'est jamais restitue en chemin, un repere de ce nonce reste inconnu = repli
  const orig = "a C:\\Users\\bob b bob [PERSO-1] [PERSO-000000-1]", m2 = mk.mask(orig), nonce = /\[PERSO-([0-9a-f]{6})-1\]/.exec(m2)[1];
  assert.strictEqual(mk.unmask(m2), orig, "reperes : un [PERSO-1] du texte d'origine reste litteral : " + m2);
  assert.throws(() => mk.unmask("x [PERSO-" + nonce + "-99] y"), (e) => e.raison === "repere-inconnu", "reperes : un repere de ce nonce non restitue leve repere-inconnu");
  assert.throws(() => mk.unmask("x [PERSO-" + nonce.toUpperCase() + "-99] y"), (e) => e.raison === "repere-inconnu", "reperes : meme casse changee");
  assert.notStrictEqual(FC.makeMasker(["bob"]).mask("bob"), FC.makeMasker(["bob"]).mask("bob"), "reperes : un nonce different a chaque appel");
  assert.strictEqual(FC.makeMasker([]).mask("rien"), "rien", "reperes : liste vide, texte inchange");
}
{
  const c = FC.resolveConfig(undefined);
  assert.deepStrictEqual(c, { enabled: false, model: "nvidia/nemotron-3-ultra-550b-a55b:free", kinds: ["auto", "manual"], timeoutMs: 240000, minSummaryChars: 1500, names: [], fallback: "journal" }, "config : valeurs par defaut, coupe");
  assert.strictEqual(FC.resolveConfig({ enabled: "true" }).enabled, false, "config : seul `true` active");
  assert.deepStrictEqual(FC.resolveConfig({ kinds: ["auto", "reactive", "manual"] }).kinds, ["auto", "manual"], "config : reactive n'est jamais detourne, meme demande");
}
// derive : les motifs de free-compact.js sont ceux du scanner d'etabli quand ce fichier est la
{
  const scanner = p.join(os.homedir(), "CLAUDE CODE", "etabli", "outils", "scan-secrets.mjs");
  if (!fs.existsSync(scanner)) console.log("SKIP derive des motifs : " + scanner + " absent");
  else {
    const src = fs.readFileSync(scanner, "utf8").replace(/\r/g, "");
    const bloc = /const MOTIFS = \[\n([\s\S]*?)\n\]\.map/.exec(src);
    assert.ok(bloc, "derive : le tableau MOTIFS est introuvable dans le scanner (sa forme a change : adapter le test)");
    const lignes = bloc[1].split("\n").map((l) => /^\s*\["([^"]+)", (\/.*\/[a-z]*)(?:, (\w+))?\],?$/.exec(l));
    assert.ok(lignes.every(Boolean), "derive : une ligne du tableau du scanner n'a pas la forme attendue");
    assert.strictEqual(lignes.length, FC.MOTIFS_SOURCE.length, "derive : meme nombre de motifs que le scanner");
    lignes.forEach((m, i) => {
      const [type, motif, reel] = FC.MOTIFS_SOURCE[i], lit = m[2], fin = lit.lastIndexOf("/");
      assert.strictEqual(m[1], type, "derive : type du motif " + i);
      assert.strictEqual(new RegExp(lit.slice(1, fin), lit.slice(fin + 1)).source, motif.source, "derive : source du motif " + type);
      assert.strictEqual(lit.slice(fin + 1), motif.flags, "derive : drapeaux du motif " + type);
      assert.strictEqual(m[3], reel ? reel.name === "REEL" ? "REEL" : "MOT_DE_PASSE" : undefined, "derive : predicat du motif " + type);
    });
    for (const [nom, fn] of [["MAQUETTE", FC.MAQUETTE], ["REEL", FC.REEL], ["MOT_DE_PASSE", FC.MOT_DE_PASSE]]) assert.ok(src.includes("const " + nom + " = " + String(fn) + ";"), "derive : la definition de " + nom + " a bouge dans le scanner");
  }
}
console.log("PASS — fonctions pures : rendu, reconnaissance, masquage des secrets et des noms, configuration, derive des motifs");

// ---------- 2. le relais contre de faux serveurs ----------
let anthHits = 0, orHits = 0, orClosed = 0, orMode = "ok", anthMode = "ok"; const orBodies = [], orAuth = [], orQueue = [];
const RATE = { "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-status": "allowed" };
function collect(req, cb) { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { let o = {}; try { o = JSON.parse(b); } catch (e) {} cb(o, b); }); }
function startAnthropic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => collect(req, (body) => {
      if (body.max_tokens === 0) { res.writeHead(200, RATE); res.end("{}"); return; } // sonde de quota
      anthHits++;
      if (anthMode === "400") { res.writeHead(400, Object.assign({ "content-type": "application/json" }, RATE)); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "CLAUDE-400-CORPS" } })); return; }
      if (anthMode === "lent" && body.stream) { // un flux de Claude qui dure 700 ms : un battement du relais s'y verrait
        res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, RATE));
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_CLAUDE"}}\n\n');
        setTimeout(() => res.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"CLAUDE-REPONSE"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'), 700);
        return;
      }
      if (body.stream) {
        res.writeHead(200, Object.assign({ "content-type": "text/event-stream" }, RATE));
        res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_CLAUDE"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"CLAUDE-REPONSE"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else { res.writeHead(200, Object.assign({ "content-type": "application/json" }, RATE)); res.end(JSON.stringify({ id: "msg_CLAUDE", type: "message", content: [{ type: "text", text: "CLAUDE-REPONSE" }] })); }
    }));
    srv.listen(MOCK_ANTH, "127.0.0.1", () => resolve(srv));
  });
}
const RESUME_OK = (marqueurs, secret, jetons) => "<analysis>analyse</analysis>\n<summary>\n" + "Rapport de session. ".repeat(100) + "\n" + marqueurs.map((m) => "Repere vu : " + m).join("\n") + "\nSecret : " + secret + "\nJetons recopies : " + jetons.join(" ") + "\n</summary>";
function startOpenRouter() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => collect(req, (body) => {
      orHits++; orBodies.push(body); orAuth.push(req.headers.authorization);
      const mode = orQueue.length ? orQueue.shift() : orMode; // orQueue : une reponse par appel, avant de revenir a orMode
      res.on("close", () => { if (!res.writableFinished) orClosed++; });
      const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const reply = (finish, content) => json(200, { id: "gen-1", model: body.model, choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      if (mode === "surcharge") return json(200, { id: "gen-2", error: { message: "Upstream error from Nvidia: Service temporarily overloaded", code: 503, metadata: { error_type: "provider_overloaded" } } }); // le cas reel du 2026-10-09 : statut 200, aucun choices
      if (mode === "400") return json(400, { error: { message: "bad request", code: 400 } });
      if (mode === "429") return json(429, { error: { message: "rate limited" } });
      if (mode === "529") return json(529, { error: { message: "overloaded" } });
      if (mode === "500") return json(500, { error: { message: "boom" } });
      if (mode === "hang") return; // accepte et ne repond jamais
      if (mode === "garbage") return req.socket.destroy();
      if (mode === "empty") return reply("stop", "");
      if (mode === "length") return reply("length", RESUME_OK([], "-", []));
      if (mode === "nosummary") return reply("stop", "REPONSE-NEMOTRON-REJETEE " + "mot ".repeat(2000));
      if (mode === "short") return reply("stop", "<summary>REPONSE-NEMOTRON-REJETEE courte</summary>");
      if (mode === "gros") return reply("stop", RESUME_OK([], "-", []) + "x".repeat(2300000)); // valide, mais plus de 2 Mio
      if (mode === "piege") { res.writeHead(200, { "content-type": "application/json" }); return res.end("PIEGE-TOSTRING"); }
      if (mode === "hostile") return reply("length\nx \"y", RESUME_OK([], "-", [])); // finish_reason avec saut de ligne et guillemet
      // succes : recopie ce qu'elle a recu, comme le ferait un modele -- les reperes, mais aussi tout jeton ou nom qu'elle verrait en clair
      const seen = (body.messages[0] || {}).content || "";
      const marqueurs = [...new Set(seen.match(/\[PERSO-[\w-]+\]/g) || [])];
      if (mode === "fantome") { const n = /\[PERSO-([0-9a-f]{6})-/.exec(seen); marqueurs.push("[PERSO-" + (n ? n[1] : "000000") + "-999]"); } // un repere du bon nonce que le relais n'a jamais pose
      const jetons = [...new Set(seen.match(/sk-ant-oat01-[\w-]+|sk-or-v1-[\w-]+|Zq9xK2mLp7vB/g) || [])];
      reply("stop", RESUME_OK(marqueurs, seen.includes("[SECRET-MASQUE]") ? "[SECRET-MASQUE]" : "aucun", jetons));
    }));
    srv.listen(MOCK_OR, "127.0.0.1", () => resolve(srv));
  });
}
function health(port) {
  return new Promise((resolve) => { const r = http.get("http://127.0.0.1:" + port + "/__proxy_health", (res) => { res.resume(); resolve(res.statusCode === 200); }); r.on("error", () => resolve(false)); r.setTimeout(500, () => { r.destroy(); resolve(false); }); });
}
function writeConf(dir, port, compaction) {
  fs.writeFileSync(p.join(dir, "tokens.json"), JSON.stringify({ port, switchAtPercent: 94, sevenDayBlockPercent: 99, waitAtSoftPercent: null, maxWaitMs: 600000, pollMs: 15000, compaction, tokens: [{ name: "account1", token: CFG_TOKEN, enabled: true }] }));
  fs.writeFileSync(p.join(dir, "state.json"), JSON.stringify({ activeIndex: 0, pct: { account1: { h5: 10, d7: 10 } }, exhausted: {}, reset5h: {}, reset7d: {} }));
}
async function startRelay(dir, port, withKey, withoutModule, envExtra) {
  for (const f of ["proxy.js", "compaction.js", "lib.js", ...(withoutModule ? [] : ["free-compact.js"])]) fs.copyFileSync(p.join(SRC, f), p.join(dir, f));
  const env = Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(MOCK_ANTH), CQR_UPSTREAM_HTTP: "1", CQR_NO_POPUP: "1", CQR_FREE_COMPACT_URL: "http://127.0.0.1:" + MOCK_OR + "/api/v1/chat/completions", CQR_FREE_COMPACT_BLOCK_MS: "400", CQR_FREE_COMPACT_RETRY_MS: "30" }, envExtra);
  if (withKey) env.OPENROUTER_API_KEY = FAKE_OR_KEY; else delete env.OPENROUTER_API_KEY; // jamais la vraie cle de la machine
  const child = cp.spawn(process.execPath, [p.join(dir, "proxy.js")], { env, stdio: "ignore", windowsHide: true });
  let up = false; for (let i = 0; i < 40; i++) { if (await health(port)) { up = true; break; } await sleep(150); }
  assert.ok(up, "le relais d'essai (port " + port + ") doit demarrer");
  return child;
}
// Une requete au relais. o.abortAfterMs : le client part sans attendre la reponse.
function ask(port, body, headers, o) {
  o = o || {};
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body)), out = { status: 0, headers: {}, raw: "", error: null };
    const req = http.request({ hostname: "127.0.0.1", port, path: o.path || "/v1/messages", method: "POST", headers: Object.assign({ "content-type": "application/json", "content-length": data.length, "authorization": "Bearer client-placeholder" }, headers) }, (res) => {
      out.status = res.statusCode; out.headers = res.headers;
      res.on("data", (c) => (out.raw += c));
      res.on("end", () => resolve(out));
      res.on("error", (e) => { out.error = e.code || e.message; resolve(out); });
    });
    req.on("error", (e) => { out.error = e.code || e.message; resolve(out); });
    req.setTimeout(20000, () => { out.error = "TIMEOUT"; req.destroy(); });
    if (o.abortAfterMs) setTimeout(() => { req.destroy(); resolve(out); }, o.abortAfterMs);
    req.end(data);
  });
}
const events = (raw) => raw.split("\n\n").map((b) => { const e = /^event: (.*)$/m.exec(b), d = /^data: (.*)$/m.exec(b); return e && d ? { event: e[1], data: JSON.parse(d[1]) } : null; }).filter(Boolean);
const snap = () => ({ anth: anthHits, or: orHits });
const logOf = (dir) => { try { return fs.readFileSync(p.join(dir, "proxy.log"), "utf8"); } catch (e) { return ""; } };
const FREE = (extra) => Object.assign({ enabled: true, timeoutMs: 3000, names: [EXTRA], fallback: "claude" }, extra); // les anciens scenarios verifient le retour a Claude (reglage explicite) ; le repli "journal" a ses scenarios plus bas
const CONF = (free, extra) => Object.assign({ enabled: true, dryRun: false, mode: "native", keepToolUses: 10, thresholds: {}, free }, extra);

(async () => {
  const DIR_A = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-free-a-")), DIR_B = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-free-b-")), DIR_C2 = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-free-d-")), DIR_D = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-free-h-")), DIR_E = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-free-u-"));
  const mockAnth = await startAnthropic(), mockOr = await startOpenRouter();
  let relayA = null, relayB = null, relayC = null, relayD = null, relayE = null, failed = null;
  try {
    writeConf(DIR_A, PORT_A, CONF(FREE()));
    relayA = await startRelay(DIR_A, PORT_A, true);
    await sleep(400); // la sonde de demarrage se pose
    const claudeServed = (r, why) => assert.ok(r.status === 200 && r.raw.includes("CLAUDE-REPONSE"), why + " : la reponse de Claude est relayee (status " + r.status + ", erreur " + r.error + ")");
    const after = async (ms) => sleep(ms || 450); // le blocage de 400 ms du banc

    // --- succes (flux) : SSE complet, Claude n'est pas appele, tout ce qui part est masque ---
    let before = snap();
    const r1 = await ask(PORT_A, compactBody(), AUTO);
    assert.strictEqual(r1.status, 200, "succes : 200");
    assert.ok(/text\/event-stream/.test(r1.headers["content-type"]), "succes : flux SSE");
    assert.deepStrictEqual(snap(), { anth: before.anth, or: before.or + 1 }, "succes : Claude 0 appel, Nemotron 1");
    const ev1 = events(r1.raw);
    assert.deepStrictEqual(ev1.map((e) => e.event), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"], "succes : la suite d'evenements d'Anthropic");
    assert.strictEqual(ev1[0].data.message.model, "claude-opus-4-8", "succes : modele repris de la requete");
    assert.deepStrictEqual(ev1[0].data.message.usage, { input_tokens: 0, output_tokens: 0 }, "succes : usage a zero");
    assert.strictEqual(ev1[4].data.delta.stop_reason, "end_turn", "succes : end_turn");
    const resume = ev1[2].data.delta.text;
    assert.ok(resume.includes("<summary>") && resume.includes("<analysis>"), "succes : le texte brut de Nemotron, balises comprises");
    assert.ok(!/event: message_start[\s\S]*event: message_start/.test(r1.raw), "succes : un seul message");

    // --- masquage : ce que Nemotron a recu, puis ce que le client recoit ---
    const sent = orBodies[orBodies.length - 1], seen = sent.messages[0].content;
    assert.strictEqual(orAuth[orAuth.length - 1], "Bearer " + FAKE_OR_KEY, "appel : la cle part en Bearer");
    assert.deepStrictEqual([sent.model, sent.max_tokens, sent.reasoning, sent.stream], ["nvidia/nemotron-3-ultra-550b-a55b:free", 3000, { effort: "low" }, false], "appel : modele, plafond court (2 x 1500), effort, sans flux");
    for (const s of PERSONAL) assert.ok(!seen.toLowerCase().includes(s.toLowerCase()), "masquage : Nemotron ne voit pas " + (s === EXTRA || s === USER ? s : "le dossier personnel"));
    for (const s of [TOKEN_ANT, TOKEN_OR, PASSWORD]) assert.ok(!seen.includes(s), "masquage : Nemotron ne voit pas un jeton ou un mot de passe");
    for (const s of ["PENSEE-NE-PART-PAS", "SYSTEME-NE-PART-PAS", "OUTIL-NE-PART-PAS"]) assert.ok(!seen.includes(s) && !JSON.stringify(sent).includes(s), "masquage : " + s);
    assert.ok(seen.includes("[SECRET-MASQUE]") && seen.includes("[PERSO-") && seen.includes("[image]"), "masquage : les reperes sont la");
    assert.ok(seen.trimEnd().endsWith(INVITE_TAIL), "appel : l'invite est en dernier");
    for (const s of PERSONAL) assert.ok(resume.includes(s), "masquage : le client retrouve en clair " + (s === EXTRA || s === USER ? s : "le dossier personnel (" + s.length + " car.)"));
    assert.ok(!/\[PERSO-[0-9a-f]{6}-\d+\]/.test(resume), "masquage : plus aucun repere dans le resume rendu");
    assert.ok(resume.includes("[PERSO-1]"), "reperes : un [PERSO-1] du texte d'origine reste litteral, jamais restitue en chemin");
    assert.ok(!seen.includes("KEYMATERIAL") && !seen.includes("PRIVATE KEY"), "cle privee : le bloc entier ne part pas");
    for (const s of [FAKE_OR_KEY, CFG_TOKEN]) assert.ok(!seen.includes(s) && !resume.includes(s), "masquage : la cle OpenRouter et le jeton de la config, vus dans le texte, ne partent pas");
    for (const s of [TOKEN_ANT, TOKEN_OR, PASSWORD]) assert.ok(!resume.includes(s) && !r1.raw.includes(s), "masquage : un jeton masque ne revient pas");
    assert.ok(resume.includes("Secret : [SECRET-MASQUE]"), "masquage : le repere de secret reste tel quel");
    const logA = logOf(DIR_A);
    assert.ok(/COMPACT-GRATUIT ok motif=auto variante=court entree=[1-9]\d* sortie=[1-9]\d* duree=\d+s essais=1 repli=non caracteres=\d+/.test(logA), "journal : ligne ok");
    assert.ok(!logA.includes(FAKE_OR_KEY), "journal : la cle n'y est jamais");
    const lignesFree = logA.split("\n").filter((l) => /COMPACT-GRATUIT/.test(l)).join("\n");
    for (const s of ["Rapport de session", TOKEN_ANT, PASSWORD, ...PERSONAL]) assert.ok(!lignesFree.includes(s), "journal : aucun contenu dans les lignes COMPACT-GRATUIT");

    // --- succes sans flux : un JSON, type manuel, sans en-tete de classe ---
    before = snap();
    const r2 = await ask(PORT_A, compactBody({ stream: false }), { "x-claude-code-compaction": "manual" });
    assert.strictEqual(r2.status, 200, "sans flux : 200");
    const j2 = JSON.parse(r2.raw);
    assert.deepStrictEqual([j2.type, j2.role, j2.stop_reason, j2.model, j2.content[0].type], ["message", "assistant", "end_turn", "claude-opus-4-8", "text"], "sans flux : message Anthropic");
    assert.ok(j2.content[0].text.includes("<summary>") && !/\[PERSO-[0-9a-f]{6}-\d+\]/.test(j2.content[0].text), "sans flux : texte brut, reperes remis en clair");
    assert.deepStrictEqual(snap(), { anth: before.anth, or: before.or + 1 }, "sans flux : Claude 0 appel");
    console.log("PASS — succes : SSE complet et JSON, Claude 0 appel, modele/cle/plafond, masquage dans les deux sens, journal sans contenu ni cle");

    // --- non-detournement : jamais chez Nemotron, toujours chez Claude (1 appel) ---
    const stay = async (name, body, headers, o) => {
      const b = snap(); const r = await ask(PORT_A, body, headers, o);
      assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or }, name + " : Claude 1 appel, Nemotron 0");
      claudeServed(r, name);
    };
    await stay("requete ordinaire", { model: "claude-opus-4-8", max_tokens: 10, stream: true, messages: [{ role: "user", content: "bonjour" }] }, {});
    await stay("compactage reactive", compactBody(), { "x-claude-code-compaction": "reactive", "x-claude-code-request-class": "compaction" });
    assert.ok(/COMPACT-GRATUIT repli raison=type-non-liste/.test(logOf(DIR_A)), "reactive : la raison du repli est journalisee");
    await stay("sans en-tete de type", compactBody(), {});
    await stay("classe main avec type auto", compactBody(), { "x-claude-code-compaction": "auto", "x-claude-code-request-class": "main" });
    await stay("sans l'invite native", Object.assign(compactBody(), { messages: [{ role: "user", content: "resume la session" }] }), AUTO);
    await stay("autre chemin", compactBody(), AUTO, { path: "/v1/messages/count_tokens" });
    console.log("PASS — non-detournement : requete ordinaire, reactive, sans type, classe autre, sans invite, autre chemin");

    // --- repli apres reponse : Claude sert exactement 1 fois, sa reponse est relayee, rien de Nemotron ne fuit ---
    // Une panne du service (HTTP, reseau, delai, reponse trop grosse) pose le blocage : on attend sa fin. Un resume refuse (QUALITE) n'en pose
    // aucun : la requete suivante doit partir tout de suite chez Nemotron (sinon son assertion "Nemotron 1 essai" echoue).
    const QUALITE = ["empty", "length", "nosummary", "short", "fantome", "hostile"];
    for (const [mode, raison, free] of [["429", "http-429"], ["500", "http-500"], ["hang", "delai", { timeoutMs: 700 }], ["garbage", "reseau-"], ["gros", "trop-gros"], ["empty", "texte-vide"], ["length", "finish-length"], ["nosummary", "sans-summary"], ["short", "trop-court"], ["fantome", "repere-inconnu"], ["hostile", "finish-lengthxy"]]) {
      writeConf(DIR_A, PORT_A, CONF(FREE(free))); orMode = mode;
      const b = snap(), closedBefore = orClosed, t0 = Date.now();
      const r = await ask(PORT_A, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or + (mode === "empty" ? 6 : 1) }, "repli " + mode + " : Nemotron 1 essai (6 si contenu vide : reessais DR-127), Claude exactement 1 appel");
      claudeServed(r, "repli " + mode);
      assert.ok(!r.raw.includes("REPONSE-NEMOTRON-REJETEE") && !r.raw.includes("Rapport de session"), "repli " + mode + " : rien de la reponse rejetee n'est emis");
      assert.ok(new RegExp("COMPACT-GRATUIT repli raison=" + raison).test(logOf(DIR_A)), "repli " + mode + " : raison journalisee (" + raison + ")");
      if (mode === "hang") { assert.ok(Date.now() - t0 >= 650, "repli delai : attendu jusqu'au delai"); assert.ok(orClosed > closedBefore, "repli delai : l'appel a Nemotron est coupe"); }
      if (!QUALITE.includes(mode)) await after();
    }
    // repli sans flux : la reponse JSON de Claude est relayee
    orMode = "500"; { const b = snap(), r = await ask(PORT_A, compactBody({ stream: false }), AUTO); assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or + 1 }, "repli sans flux : Claude 1 appel"); assert.ok(r.status === 200 && JSON.parse(r.raw).content[0].text === "CLAUDE-REPONSE", "repli sans flux : JSON de Claude relaye"); }
    await after();

    // --- repli avant tout octet : Nemotron n'est pas appele ---
    orMode = "ok";
    const early = async (name, conf, body, raison) => {
      writeConf(DIR_A, PORT_A, conf);
      const b = snap(), r = await ask(PORT_A, body || compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or }, name + " : Claude 1 appel, Nemotron 0");
      claudeServed(r, name);
      if (raison) assert.ok(new RegExp("COMPACT-GRATUIT repli raison=" + raison).test(logOf(DIR_A)), name + " : raison journalisee (" + raison + ")");
    };
    await early("reglage coupe", CONF(FREE({ enabled: false })), null, null);
    assert.ok(!/raison=reglage-coupe/.test(logOf(DIR_A)), "reglage coupe : rien a journaliser, c'est l'etat par defaut");
    await early("compaction coupee (DR-066)", CONF(FREE(), { enabled: false }), null, "compaction-coupee");
    await early("compaction absente", CONF(FREE(), { enabled: undefined }), null, "compaction-coupee"); // le proxy lit enabled comme vrai ou faux : absent = pas de detournement
    await early("type non liste", CONF(FREE({ kinds: ["manual"] })), null, "type-non-liste");
    await early("trop gros", CONF(FREE()), compactBody({ big: true }), "trop-gros");
    writeConf(DIR_B, PORT_B, CONF(FREE()));
    relayB = await startRelay(DIR_B, PORT_B, false);
    { const b = snap(), r = await ask(PORT_B, compactBody(), AUTO); assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or }, "cle absente : Claude 1 appel, Nemotron 0"); claudeServed(r, "cle absente"); assert.ok(/COMPACT-GRATUIT repli raison=cle-absente/.test(logOf(DIR_B)), "cle absente : raison journalisee"); }

    // le fichier free-compact.js absent ne touche pas le failover : Claude sert, une ligne le dit
    writeConf(DIR_C2, PORT_C, CONF(FREE()));
    relayC = await startRelay(DIR_C2, PORT_C, true, true);
    { const b = snap(), r = await ask(PORT_C, compactBody(), AUTO); assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or }, "module absent : Claude 1 appel, Nemotron 0"); claudeServed(r, "module absent"); const lm = logOf(DIR_C2).split("\n").find((l) => /COMPACT-GRATUIT module indisponible/.test(l)); assert.ok(lm && lm.includes("MODULE_NOT_FOUND") && !/cqr-free|Require stack|proxy\.js|Users/.test(lm), "module absent : une ligne de journal avec le code d'erreur et aucun chemin : " + lm); }

    // --- blocage de 10 minutes (400 ms au banc) apres un echec ---
    writeConf(DIR_A, PORT_A, CONF(FREE())); orMode = "500";
    await ask(PORT_A, compactBody(), AUTO); // l'echec qui pose le blocage
    orMode = "ok";
    { const b = snap(), r = await ask(PORT_A, compactBody(), AUTO); assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or }, "blocage : Claude sert sans appeler Nemotron"); claudeServed(r, "blocage"); assert.ok(/COMPACT-GRATUIT repli raison=blocage/.test(logOf(DIR_A)), "blocage : raison journalisee"); }
    await after(500);
    { const b = snap(), r = await ask(PORT_A, compactBody(), AUTO); assert.deepStrictEqual(snap(), { anth: b.anth, or: b.or + 1 }, "apres le blocage : on detourne de nouveau"); assert.ok(r.raw.includes("<summary>"), "apres le blocage : resume de Nemotron"); }
    console.log("PASS — repli : 11 echecs (429, 500, delai, coupure, trop gros, vide, length, sans summary, trop court, repere inconnu, finish_reason hostile) dont 6 refus de qualite sans blocage + sans flux, 6 conditions avant tout octet, blocage puis reprise");

    // --- variantes (DR-106, DR-108) : repli "journal", journal sans appel amont, court plafonne ---
    const isJournal = (r, why) => assert.ok(r.status === 200 && r.raw.includes("<summary>") && r.raw.includes("variante journal") && !r.raw.includes("CLAUDE-REPONSE"), why + " : le resume journal est rendu, pas la reponse de Claude (status " + r.status + ")");
    writeConf(DIR_A, PORT_A, CONF(FREE({ fallback: undefined })));
    for (const [mode, raison] of [["529", "surcharge"], ["empty", "texte-vide"], ["nosummary", "sans-summary"]]) {
      await after(500); // le blocage du cas precedent est passe
      setVariante("hybride"); orMode = mode;
      const b = snap(), r = await ask(PORT_A, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth, or: b.or + (mode === "nosummary" ? 1 : 6) }, "repli journal " + mode + " : Nemotron 1 essai (6 sur surcharge ou contenu vide : DR-127), Claude AUCUN appel");
      isJournal(r, "repli journal " + mode);
      assert.ok(new RegExp("COMPACT-GRATUIT ok motif=auto variante=journal entree=[1-9]\\d* sortie=[1-9]\\d* duree=\\d+s essais=" + (mode === "nosummary" ? 1 : 6) + " repli=" + raison).test(logOf(DIR_A)), "repli journal " + mode + " : ligne COMPACT-GRATUIT avec la raison " + raison);
    }
    // blocage : un appel dans la fenetre n'atteint ni Nemotron ni Claude, il rend le journal
    await after(500); orMode = "500"; await ask(PORT_A, compactBody(), AUTO); orMode = "ok"; // l'echec qui pose le blocage
    { const b = snap(), r = await ask(PORT_A, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth, or: b.or }, "blocage -> journal : ni Nemotron ni Claude");
      isJournal(r, "blocage -> journal"); assert.ok(/repli=blocage/.test(logOf(DIR_A)), "blocage -> journal : repli=blocage au journal"); }
    await after(500);
    // variante journal : aucun appel de modele, meme en bonne sante
    setVariante("journal"); orMode = "ok";
    { const b = snap(), r = await ask(PORT_A, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth, or: b.or }, "journal : aucun appel amont (ni Nemotron ni Claude)");
      isJournal(r, "journal");
      assert.ok(r.raw.includes("Je lis le fichier.") && !r.raw.includes("KEYMATERIAL") && !r.raw.includes(TOKEN_ANT) && !r.raw.includes("PENSEE-NE-PART-PAS"), "journal : texte des echanges recopie, ni resultat d'outil ni raisonnement");
      assert.ok(/variante=journal entree=0 sortie=[1-9]\d* duree=\d+s repli=non/.test(logOf(DIR_A)), "journal : ligne COMPACT-GRATUIT sans repli"); }
    // court : toute la conversation, max_tokens plafonne
    setVariante("court", { court_max_jetons: 700 });
    { const n0 = orBodies.length; await ask(PORT_A, compactBody(), AUTO);
      const sent = orBodies[orBodies.length - 1];
      assert.ok(orBodies.length === n0 + 1 && sent.max_tokens === 3000, "court : max_tokens plafonne (" + sent.max_tokens + ")");
      assert.ok(sent.messages[0].content.includes("700 jetons au plus"), "court : la consigne de longueur part"); }
    setVariante("hybride", { queue_jetons: 25000 });
    { const n0 = orBodies.length; await ask(PORT_A, compactBody(), AUTO);
      assert.strictEqual(orBodies[orBodies.length - 1].max_tokens, 8000, "hybride : max_tokens 8000 (DR-122)"); }
    // reglage explicite fallback "claude" : retour a Claude
    writeConf(DIR_A, PORT_A, CONF(FREE({ fallback: "claude" }))); setVariante("hybride"); orMode = "500";
    { const b = snap(), r = await ask(PORT_A, compactBody(), AUTO); assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or + 1 }, "fallback claude : Claude sert"); claudeServed(r, "fallback claude"); }
    await after(500); setVariante("court");
    console.log("PASS — variantes : repli journal (529, vide, sans summary, blocage) sans appel a Claude, journal sans appel amont, court plafonne, fallback claude explicite");

    // --- octet avant validation : un repli rapide garde le vrai statut de Claude (un 400 reste un 400, pas une erreur SSE) ---
    writeConf(DIR_A, PORT_A, CONF(FREE())); orMode = "429"; anthMode = "400";
    { const b = snap(), r = await ask(PORT_A, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or + 1 }, "statut : Nemotron 1 essai, Claude 1 appel");
      assert.strictEqual(r.status, 400, "statut : le 400 de Claude arrive tel quel (status " + r.status + ", brut " + r.raw.slice(0, 80) + ")");
      assert.ok(r.raw.includes("CLAUDE-400-CORPS") && !/text\/event-stream/.test(String(r.headers["content-type"])) && !r.raw.includes("event: error"), "statut : le corps de Claude, pas une erreur SSE"); }
    anthMode = "ok"; orMode = "ok"; await after();

    // --- delai avant le flux (CQR_FREE_COMPACT_HOLD_MS = 300 ms au banc ; 60 s par defaut) ---
    writeConf(DIR_D, PORT_D, CONF(FREE({ timeoutMs: 1500 })));
    relayD = await startRelay(DIR_D, PORT_D, true, false, { CQR_FREE_COMPACT_HOLD_MS: "300" });
    await sleep(400);
    orMode = "429"; anthMode = "400"; // repli rapide : le minuteur est annule des que le resultat arrive, il ne doit plus rien faire apres coup
    { const r = await ask(PORT_D, compactBody(), AUTO);
      assert.strictEqual(r.status, 400, "delai : repli rapide, le 400 de Claude (status " + r.status + ")");
      await sleep(700);
      assert.ok(await health(PORT_D), "delai : le relais est vivant apres l'echeance du minuteur");
      assert.ok(!/erreur imprevue|erreur en pleine requete/.test(logOf(DIR_D)), "delai : rien n'est ecrit sur une reponse deja rendue : " + logOf(DIR_D).split("\n").filter((l) => /erreur/.test(l)).join(" | ").slice(0, 300)); }
    anthMode = "ok"; await after();
    orMode = "429"; anthMode = "lent"; // repli rapide, puis un flux de Claude plus long que le delai : le minuteur annule ne glisse aucun battement dedans
    { const r = await ask(PORT_D, compactBody(), AUTO);
      assert.ok(r.status === 200 && r.raw.includes("CLAUDE-REPONSE") && !r.raw.includes("claude-auth-proxy"), "delai : un repli rapide n'est pas coupe par un battement tardif (brut " + r.raw.slice(0, 200) + ")"); }
    anthMode = "ok"; await after();
    orMode = "hang"; // repli tardif : le flux est ouvert au bout de 300 ms (battements), Claude repond a 1,5 s
    { const t0 = Date.now(), r = await ask(PORT_D, compactBody(), AUTO);
      assert.ok(Date.now() - t0 >= 1400, "delai : attendu jusqu'au delai de Nemotron");
      assert.ok(r.status === 200 && /text\/event-stream/.test(r.headers["content-type"]) && r.raw.includes(": claude-auth-proxy: compactage gratuit en cours") && r.raw.includes("CLAUDE-REPONSE"), "delai : au-dela, des battements puis la reponse de Claude (brut " + r.raw.slice(0, 120) + ")"); }
    await after(); anthMode = "400"; // repli tardif et Claude refuse : le statut est parti avec les battements, il ne reste qu'une erreur SSE
    { const r = await ask(PORT_D, compactBody(), AUTO);
      assert.ok(r.status === 200 && r.raw.includes(": claude-auth-proxy: compactage gratuit en cours") && r.raw.includes("event: error"), "delai : repli tardif et 400 de Claude = erreur SSE (brut " + r.raw.slice(0, 200) + ")"); }
    anthMode = "ok"; orMode = "ok"; await after();
    console.log("PASS — delai avant le flux : repli rapide = le vrai 400 de Claude, minuteur annule ; repli tardif = battements puis reponse ou erreur SSE");

    // --- adresse imposee : une surcharge vers un autre hote est ignoree (cle et conversation ne partent pas), le journal le dit sans l'adresse ---
    // Un fichier prechargee remplace https.request dans le relais : si l'adresse etait honoree, rien ne sortirait de la machine, et le test verrait l'hote.
    const hitsE = p.join(DIR_E, "hits.txt"), stubE = p.join(DIR_E, "stub.js");
    fs.writeFileSync(stubE, 'const fs = require("fs"), https = require("https");\nhttps.request = (o) => { fs.appendFileSync(process.env.CQR_STUB_FILE, String(o && o.hostname) + "\\n"); throw Object.assign(new Error("stub"), { code: "STUB" }); };\n');
    writeConf(DIR_E, PORT_E, CONF(FREE()));
    relayE = await startRelay(DIR_E, PORT_E, true, false, { CQR_FREE_COMPACT_URL: "http://evil.example.invalid/steal", NODE_OPTIONS: '--require "' + stubE.replace(/\\/g, "/") + '"', CQR_STUB_FILE: hitsE });
    { const b = snap(), r = await ask(PORT_E, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth + 1, or: b.or }, "adresse : Claude 1 appel, le faux OpenRouter local n'est pas touche");
      claudeServed(r, "adresse non locale");
      const hits = fs.existsSync(hitsE) ? fs.readFileSync(hitsE, "utf8").trim().split("\n") : [];
      assert.deepStrictEqual(hits, ["openrouter.ai"], "adresse : l'appel a visé openrouter.ai, jamais l'hote de la variable : " + hits.join(","));
      const le = logOf(DIR_E);
      assert.ok(/COMPACT-GRATUIT surcharge-ignoree raison=hote-non-local/.test(le) && !/evil|steal/.test(le), "adresse : une ligne de journal, sans l'adresse"); }
    console.log("PASS — adresse imposee : surcharge vers un autre hote ignoree, appel vers openrouter.ai, une ligne de journal sans l'adresse");

    // --- en process : duree du blocage, adresse, reponse piegee, dossier personnel (le faux OpenRouter local, la cle factice) ---
    const envSave = [["OPENROUTER_API_KEY", process.env.OPENROUTER_API_KEY], ["CQR_FREE_COMPACT_URL", process.env.CQR_FREE_COMPACT_URL], ["CQR_FREE_COMPACT_BLOCK_MS", process.env.CQR_FREE_COMPACT_BLOCK_MS], ["CQR_FREE_COMPACT_HOLD_MS", process.env.CQR_FREE_COMPACT_HOLD_MS], ["CQR_FREE_COMPACT_RETRY_MS", process.env.CQR_FREE_COMPACT_RETRY_MS]];
    const MOCK_URL = "http://127.0.0.1:" + MOCK_OR + "/api/v1/chat/completions", DFLT = "https://openrouter.ai/api/v1/chat/completions";
    const fresh = () => { delete require.cache[require.resolve("../src/free-compact.js")]; return require("../src/free-compact.js"); }; // un module neuf : blocage remis a zero
    const confIn = (free) => ({ compaction: { enabled: true, free: Object.assign({ enabled: true, timeoutMs: 3000, minSummaryChars: 10, fallback: "claude" }, free) }, tokens: [{ name: "x", token: CFG_TOKEN }] });
    const decideIn = (F, text) => F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: [{ role: "user", content: text || "bonjour" }, { role: "assistant", content: "ok" }, { role: "user", content: FC.INVITE + " fin" }] } }, () => confIn());
    try {
      process.env.OPENROUTER_API_KEY = FAKE_OR_KEY; process.env.CQR_FREE_COMPACT_URL = MOCK_URL; // jamais la vraie cle, jamais le vrai service
      // duree du blocage : vide, non numerique, nulle ou negative = ignoree, les 10 minutes par defaut valent
      for (const v of ["", "0", "-5", "abc", "   "]) {
        process.env.CQR_FREE_COMPACT_BLOCK_MS = v; const F = fresh(); orMode = "500";
        const r = await F.run(decideIn(F), {}, {});
        assert.strictEqual(r.raison, "http-500", "blocage en process : l'echec attendu");
        await sleep(40);
        assert.strictEqual((decideIn(F) || {}).raison, "blocage", "blocage : la valeur " + JSON.stringify(v) + " est ignoree, le blocage par defaut vaut");
      }
      process.env.CQR_FREE_COMPACT_BLOCK_MS = "60";
      { const F = fresh(); orMode = "500"; await F.run(decideIn(F), {}, {}); assert.strictEqual(decideIn(F).raison, "blocage", "blocage : une valeur valide pose le blocage"); await sleep(100); assert.strictEqual(decideIn(F).go, true, "blocage : une valeur valide est honoree"); }
      delete process.env.CQR_FREE_COMPACT_BLOCK_MS;
      for (const v of ["", "0", "-5", "abc"]) { process.env.CQR_FREE_COMPACT_HOLD_MS = v; assert.strictEqual(fresh().holdMs(), 60000, "delai avant le flux : " + JSON.stringify(v) + " ignore, 60 s"); }
      process.env.CQR_FREE_COMPACT_HOLD_MS = "300"; assert.strictEqual(fresh().holdMs(), 300, "delai avant le flux : valeur valide honoree");
      process.env.CQR_FREE_COMPACT_HOLD_MS = "99999999999"; assert.strictEqual(fresh().holdMs(), 2147483647, "delai avant le flux : plafonne a 2^31-1 ms (au-dela, setTimeout retombe a 1 ms)");
      assert.strictEqual(FC.resolveConfig({ timeoutMs: 1e12 }).timeoutMs, 2147483647, "config : timeoutMs plafonne a 2^31-1 ms");
      delete process.env.CQR_FREE_COMPACT_HOLD_MS;

      // adresse : seule la machine elle-meme peut etre visee ; sans surcharge, OpenRouter
      { const F = fresh(), P = (u) => { if (u === undefined) delete process.env.CQR_FREE_COMPACT_URL; else process.env.CQR_FREE_COMPACT_URL = u; return decideIn(F); };
        let pl = P(undefined); assert.ok(pl.url === DFLT && !pl.urlIgnoree && pl.url.startsWith("https://openrouter.ai/"), "adresse : sans surcharge, OpenRouter");
        for (const u of ["http://127.0.0.1:9/x", "http://localhost:9/x", "http://[::1]:9/x"]) { pl = P(u); assert.ok(pl.url === u && !pl.urlIgnoree, "adresse : " + u + " est honoree"); }
        for (const u of ["https://evil.example.com/steal", "http://127.0.0.1.evil.com/x", "http://localhost@evil.com/x", "http://evil.com/?h=127.0.0.1", "pas une adresse"]) { pl = P(u); assert.ok(pl.url === DFLT && pl.urlIgnoree === true, "adresse : " + u + " est ignoree, OpenRouter garde"); }
        process.env.CQR_FREE_COMPACT_URL = MOCK_URL; }

      // reponse piegee : toString leve dans le gestionnaire de fin ; la promesse doit se regler (sinon exception non attrapee, le test meurt)
      { const F = fresh(); orMode = "piege"; const orig = Buffer.prototype.toString; let r;
        Buffer.prototype.toString = function () { const t = orig.apply(this, arguments); if (t === "PIEGE-TOSTRING") throw new RangeError("toString piege"); return t; };
        try { r = await F.run(decideIn(F), {}, {}); } finally { Buffer.prototype.toString = orig; }
        assert.deepStrictEqual([r.ok, r.raison], [false, "erreur-RangeError"], "reponse piegee : la promesse se regle, repli : " + JSON.stringify(r)); }

      // reessais sur surcharge (DR-127) : jusqu'a 5, dans le delai total, jamais sur un echec definitif ; le corps envoye est le meme a chaque essai
      process.env.CQR_FREE_COMPACT_RETRY_MS = "20";
      { const jr = (F) => { const pl = decideIn(F); pl.cfg = Object.assign({}, pl.cfg, { fallback: "journal" }); return pl; };
        let F = fresh(), b = orBodies.length; orQueue.push("surcharge", "surcharge"); orMode = "ok";
        let r = await F.run(jr(F), {}, {});
        assert.ok(r.ok && r.variante !== "journal" && r.repli === null && r.essais === 3 && r.text.includes("<summary>"), "reessais : 2 surcharges puis un succes -> vrai resume, essais=3, pas de repli : " + JSON.stringify(r).slice(0, 200));
        assert.strictEqual(orBodies.length - b, 3, "reessais : 3 appels a Nemotron");
        assert.ok(orBodies.slice(b).every((x) => JSON.stringify(x) === JSON.stringify(orBodies[b])), "reessais : le corps (donc le masquage) est identique a chaque essai");
        assert.strictEqual((decideIn(F) || {}).go, true, "reessais : un succes final ne pose aucun blocage");
        F = fresh(); b = orHits; orQueue.push("surcharge", "surcharge", "surcharge", "surcharge", "surcharge", "surcharge");
        r = await F.run(jr(F), { messages: [{ role: "user", content: "TEXTE-UTILISATEUR-VU" }] }, {});
        assert.ok(r.ok && r.variante === "journal" && r.repli === "surcharge" && r.essais === 6 && r.text.includes("<summary>") && r.text.includes("TEXTE-UTILISATEUR-VU"), "reessais epuises : repli=surcharge, essais=6, journal valide : " + JSON.stringify(r).slice(0, 200));
        assert.strictEqual(orHits - b, 6, "reessais epuises : 6 appels, pas un de plus");
        F = fresh(); b = orHits; orQueue.length = 0; orQueue.push("400", "ok");
        r = await F.run(jr(F), {}, {});
        assert.ok(r.variante === "journal" && r.repli === "http-400" && r.essais === 1 && orHits - b === 1, "400 : aucun reessai : " + JSON.stringify(r).slice(0, 200));
        orQueue.length = 0; F = fresh(); b = orHits; orMode = "surcharge";
        const pl = jr(F); pl.cfg.timeoutMs = 300; process.env.CQR_FREE_COMPACT_RETRY_MS = "120"; const t0 = Date.now();
        r = await F.run(pl, {}, {});
        assert.ok(r.variante === "journal" && r.repli === "delai" && r.essais >= 2 && r.essais < 6 && orHits - b === r.essais && Date.now() - t0 < 1000, "delai total atteint pendant les reessais : arret et repli : " + JSON.stringify(r).slice(0, 200));
        orMode = "ok"; process.env.CQR_FREE_COMPACT_RETRY_MS = "20"; }

      // coupe de la queue : limite de message, jamais un tool_use separe de son tool_result
      { const big = "y".repeat(400);
        const msgs = [];
        for (let i = 0; i < 40; i++) {
          msgs.push({ role: "user", content: "question " + i + " " + big });
          msgs.push({ role: "assistant", content: [{ type: "text", text: "je regarde " + i }, { type: "tool_use", id: "toolu_" + String(i).padStart(8, "0"), name: "Bash", input: { command: "ls " + i } }] });
          msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_" + String(i).padStart(8, "0"), content: "sortie " + i + " " + big }] });
        }
        msgs.push({ role: "user", content: FC.INVITE + " fin" });
        const ids = (m, t) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === t).map((b) => b.tool_use_id || b.id);
        const verifie = (tail, why) => {
          const vus = new Set();
          for (const m of tail) { for (const id of ids(m, "tool_result")) assert.ok(vus.has(id), why + " : tool_result orphelin " + id); for (const id of ids(m, "tool_use")) vus.add(id); }
        };
        let coupes = 0;
        for (const maxChars of [900, 1000, 1200, 1500, 2000, 5000]) { // toutes les positions de coupe possibles
          const tail = FC.tailMessages(msgs, maxChars);
          assert.ok(tail.length < msgs.length && tail[tail.length - 1] === msgs[msgs.length - 1], "queue " + maxChars + " : coupee, l'invite reste en dernier");
          assert.ok(FC.renderConversation({ messages: tail }).length <= maxChars + 1200, "queue " + maxChars + " : taille bornee");
          verifie(tail, "queue " + maxChars); coupes++;
        }
        for (let k = 1; k < msgs.length - 1; k += 1) { // quelle que soit la limite exacte
          const tail = FC.tailMessages(msgs, FC.renderConversation({ messages: msgs.slice(k) }).length);
          verifie(tail, "queue depuis " + k);
        }
        assert.ok(coupes === 6, "queue : cas verifies");
        assert.strictEqual(FC.tailMessages(msgs.slice(-2), 10).length, 1, "queue : sans place, l'invite seule reste, le tool_result orphelin saute");
        // via decide : hybride coupe, court garde tout
        const dec = (v) => { fs.writeFileSync(process.env.CQR_COMPACTAGE_FILE, JSON.stringify({ variante: v, queue_jetons: 500 })); const F = fresh(); return F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: msgs } }, () => confIn()); };
        const h = dec("hybride"), c = dec("court");
        assert.ok(h.go && h.variante === "hybride" && h.text.length < c.text.length / 3 && !h.text.includes("question 0 "), "hybride : seule la queue part (" + h.text.length + " contre " + c.text.length + ")");
        assert.ok(c.text.includes("question 0 ") && c.maxTokens === 3000, "court : toute la conversation, max_tokens 2 x 1500");
        // sans fichier : hybride
        fs.rmSync(process.env.CQR_COMPACTAGE_FILE, { force: true });
        assert.deepStrictEqual(FC.readVariante(), { variante: "hybride", queueJetons: 25000, courtMax: 1500, teteJetons: 8000 }, "fichier absent : hybride, 25000, 1500, 8000, sans invalide");
        fs.writeFileSync(process.env.CQR_COMPACTAGE_FILE, "{pas du json"); assert.strictEqual(FC.readVariante().variante, "journal", "fichier illisible : journal (DR-116)");
        fs.writeFileSync(process.env.CQR_COMPACTAGE_FILE, JSON.stringify({ variante: "court", queue_jetons: -3, court_max_jetons: 800 }));
        assert.deepStrictEqual(FC.readVariante(), { variante: "court", queueJetons: 25000, courtMax: 800, teteJetons: 8000 }, "fichier : valeurs lues, invalides ignorees");
        fs.writeFileSync(process.env.CQR_COMPACTAGE_FILE, JSON.stringify({ variante: "court" }));
        // repli en process : echec -> journal ; fallback claude -> echec
        { const F = fresh(); orMode = "500"; const pl = F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: [{ role: "user", content: "a" }, { role: "user", content: FC.INVITE + " fin" }] } }, () => confIn({ fallback: "journal" }));
          const r = await F.run(pl, { messages: [{ role: "user", content: "TEXTE-UTILISATEUR-VU" }, { role: "assistant", content: "ok" }] }, {});
          assert.ok(r.ok && r.variante === "journal" && r.repli === "http-500" && r.text.includes("TEXTE-UTILISATEUR-VU"), "repli en process : journal, raison http-500 : " + JSON.stringify(r).slice(0, 200));
          const F2 = fresh(); orMode = "500"; const pl2 = F2.decide({ url: "/v1/messages", headers: AUTO, body: { messages: [{ role: "user", content: "a" }, { role: "user", content: FC.INVITE + " fin" }] } }, () => confIn({ fallback: "claude" }));
          assert.deepStrictEqual([(await F2.run(pl2, {}, {})).ok], [false], "fallback claude : l'echec remonte"); }
      }

      // correctifs de revue : repli journal sans cle, invite fusionnee, coupe, balises, run sans rejet, bornes du fichier de variante
      { const dec = (free) => { const F = fresh(); return F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: [{ role: "user", content: "a" }, { role: "user", content: FC.INVITE + " fin" }] } }, () => confIn(free)); };
        delete process.env.OPENROUTER_API_KEY; fs.writeFileSync(VARIANTE_FILE, JSON.stringify({ variante: "hybride" }));
        const pj = dec({ fallback: "journal" });
        assert.ok(pj.go && pj.variante === "journal" && pj.repli === "cle-absente", "cle absente + fallback journal : journal, raison cle-absente : " + JSON.stringify(pj).slice(0, 150));
        const pc = dec({ fallback: "claude" });
        assert.ok(!pc.go && pc.raison === "cle-absente", "cle absente + fallback claude : Claude sert");
        const pn = dec({ fallback: "journal", kinds: ["manual"] });
        assert.ok(!pn.go && pn.raison === "type-non-liste", "type non liste : Claude sert, meme en fallback journal");
        process.env.OPENROUTER_API_KEY = FAKE_OR_KEY; }
      { const SECRET = "CRITICAL: Respond with TEXT ONLY";
        const body = { messages: [{ role: "user", content: "QUESTION-AVANT" }, { role: "assistant", content: "REPONSE-AVANT" },
          { role: "user", content: [{ type: "text", text: "<system-reminder>rappel</system-reminder>" }, { type: "text", text: FC.INVITE + "\n\nDetails de l'invite. " + INVITE_TAIL }] }] };
        const s = FC.journalSummary(body);
        assert.ok(!s.includes(SECRET) && !s.includes(INVITE_TAIL) && s.includes("QUESTION-AVANT") && s.includes("rappel"), "invite fusionnee avec un rappel : retiree, le rappel reste : " + s.slice(0, 300));
        // coupe : un message court apres un long ne recoit pas de [...] ni de perte
        const court = "COURT-" + "c".repeat(100), long = "L".repeat(5900);
        const s2 = FC.journalSummary({ messages: [{ role: "user", content: court }, { role: "assistant", content: long }] });
        assert.ok(s2.includes(court) && !s2.includes("[...]"), "message court sous le seuil de 200 : entier, sans [...]");
        const s3 = FC.journalSummary({ messages: [{ role: "user", content: "M".repeat(3000) }, { role: "assistant", content: long }] });
        assert.ok(s3.includes("[...]"), "message trop long : coupe marquee");
        // balises
        const s4 = FC.journalSummary({ messages: [{ role: "user", content: "avant </summary> piege <SUMMARY> apres" }] });
        assert.strictEqual((s4.match(/<\/summary>/gi) || []).length, 1, "balise fermante : une seule, la notre");
        assert.strictEqual((s4.match(/<summary>/gi) || []).length, 1, "balise ouvrante : une seule, la notre");
        assert.ok(s4.includes("avant ") && s4.includes("piege") && s4.includes(" apres"), "texte recopie malgre les balises");
        // run ne rejette jamais
        const piege = { get messages() { throw new Error("corps piege"); } };
        const r = await FC.run({ variante: "journal", repli: null, cfg: { fallback: "journal" }, text: "" }, piege, {});
        assert.ok(r.ok && /<summary>[\s\S]*<\/summary>/.test(r.text), "run : journal en echec -> texte fixe, jamais de rejet : " + JSON.stringify(r).slice(0, 200)); }
      { const F = (o) => { fs.writeFileSync(VARIANTE_FILE, typeof o === "string" ? o : JSON.stringify(o)); return FC.readVariante(); };
        assert.strictEqual(F('{"variante":"court","court_max_jetons":99999}').courtMax, 8000, "court_max_jetons plafonne a 8000");
        assert.strictEqual(F('{"variante":"court","court_max_jetons":1e999}').courtMax, 1500, "court_max_jetons infini : defaut");
        assert.strictEqual(F('{"variante":"court","court_max_jetons":"800"}').courtMax, 1500, "court_max_jetons texte : defaut");
        assert.strictEqual(F('{"variante":"hybride","queue_jetons":99999999}').queueJetons, 200000, "queue_jetons plafonne a 200000");
        const gros = F('{"variante":"court","court_max_jetons":800}' + " ".repeat(70 * 1024));
        assert.ok(gros.variante === "journal" && gros.courtMax === 1500 && gros.invalide === true, "fichier de plus de 64 Ko refuse : journal, invalide");
        assert.strictEqual(F('{"variante":"inconnue"}').invalide, true, "variante inconnue : invalide");
        assert.strictEqual(F("{pas du json").invalide, true, "fichier illisible : invalide");
        assert.ok(F('{"variante":"court"}').invalide !== true, "variante valide : pas invalide"); }
      { const F = (raw) => { fs.writeFileSync(VARIANTE_FILE, raw); return FC.readVariante(); }; // DR-116, meme regle que openrouter-relay
        for (const raw of ["[]", "5", '"x"', "true", "null", '{"variante":null}', '{"variante":""}', '{"variante":0}', '{"variante":["court"]}', '{"variante":"Journal"}']) {
          const v = F(raw); assert.ok(v.variante === "journal" && v.invalide === true, "reglage invalide -> journal + invalide : " + raw + " -> " + JSON.stringify(v)); }
        assert.ok(F("{}").variante === "hybride" && F("{}").invalide !== true, "objet sans variante : hybride"); }
      { fs.writeFileSync(VARIANTE_FILE, '{"variante":"inconnue"}'); const F = fresh(); orMode = "ok";
        const pl = F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: [{ role: "user", content: "a" }, { role: "user", content: FC.INVITE + " fin" }] } }, () => confIn());
        assert.ok(pl.go && pl.variante === "journal" && pl.invalide === true, "variante inconnue : journal (DR-116), le plan porte invalide"); }
      // DR-118 : tete-queue ; DR-115 : court = 3000 fixe
      { const mk = (n) => { const m = []; for (let i = 0; i < n; i++) { m.push({ role: "user", content: "TETE-Q" + i + " " + "x".repeat(300) }); m.push({ role: "assistant", content: "TETE-R" + i + " " + "y".repeat(300) }); } m.push({ role: "user", content: FC.INVITE + " fin" }); return m; };
        const plan = (msgs, extra, free) => { fs.writeFileSync(VARIANTE_FILE, JSON.stringify(Object.assign({ variante: "tete-queue" }, extra))); const F = fresh(); return { F, pl: F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: msgs } }, () => confIn(free)) }; };
        const msgs = mk(60);
        { const { pl } = plan(msgs, { tete_jetons: 400, queue_jetons: 400 });
          assert.ok(pl.go && pl.variante === "tete-queue" && !pl.invalide && pl.maxTokens === 8000, "tete-queue : plan, plafond de sortie 8000 comme hybride (DR-122)");
          assert.ok(pl.text.includes("TETE-Q0 ") && pl.text.includes("TETE-R59 ") && !pl.text.includes("TETE-Q30 ") && pl.text.includes("PARTIE OMISE") && /debut/i.test(pl.text), "tete-queue : le debut et la fin partent, pas le milieu, une marque d'omission : " + pl.text.length);
          assert.ok(pl.text.indexOf("TETE-Q0 ") < pl.text.indexOf("PARTIE OMISE") && pl.text.indexOf("PARTIE OMISE") < pl.text.indexOf("TETE-R59 "), "tete-queue : la marque est entre la tete et la queue"); }
        { const { pl } = plan(mk(3), { tete_jetons: 800, queue_jetons: 800 }); // tete + queue couvrent tout
          const count = (t, s) => t.split(s).length - 1;
          assert.ok(pl.go && ["TETE-Q0 ", "TETE-R0 ", "TETE-Q1 ", "TETE-R1 ", "TETE-Q2 ", "TETE-R2 "].every((k) => count(pl.text, k) === 1), "tete-queue : recouvrement, chaque echange une seule fois");
          assert.ok(!pl.text.includes("PARTIE OMISE"), "tete-queue : recouvrement, aucune marque d'omission"); }
        { const sec = mk(60); sec[0] = { role: "user", content: "debut avec " + TOKEN_ANT + " et password=" + PASSWORD + " fin" };
          const { F, pl } = plan(sec, { tete_jetons: 400, queue_jetons: 400 }); orMode = "ok"; const n0 = orBodies.length; const r = await F.run(pl, {}, {});
          const vu = orBodies[orBodies.length - 1].messages[0].content;
          assert.ok(orBodies.length === n0 + 1 && vu.includes("debut avec") && !vu.includes(TOKEN_ANT) && !vu.includes(PASSWORD) && vu.includes("[SECRET-MASQUE]"), "tete-queue : secrets masques dans la tete : " + vu.slice(0, 160));
          assert.ok(r.ok && r.variante === "tete-queue", "tete-queue : resume rendu"); }
        { const { F, pl } = plan(msgs, { tete_jetons: 400, queue_jetons: 400 }, { fallback: "journal" }); orMode = "500";
          const r = await F.run(pl, { messages: [{ role: "user", content: "TEXTE-UTILISATEUR-VU" }] }, {});
          assert.ok(r.ok && r.variante === "journal" && r.repli === "http-500" && r.text.includes("TEXTE-UTILISATEUR-VU"), "tete-queue : echec -> journal : " + JSON.stringify(r).slice(0, 160)); orMode = "ok"; }
        // revue : le premier message est masque AVANT la coupe de la tete (un secret coupe sous son seuil n'est plus reconnu)
        { const GHP = "ghp_" + "Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDeFgHiJ", ANT = "sk-ant-oat01-" + "FAKE-A1b2C3d4E5f6G7h8I9j0KlMnOp", OR = FAKE_OR_KEY;
          for (const [nom, sec] of [["ghp", GHP], ["sk-ant", ANT], ["cle OpenRouter", OR]]) {
            for (let off = 1180; off <= 1290; off += 9) {
              const sec0 = mk(60); sec0[0] = { role: "user", content: ("ab ".repeat(Math.ceil(off / 3))).slice(0, off) + " " + sec + " " + "cd ".repeat(2000) };
              const { F, pl } = plan(sec0, { tete_jetons: 400, queue_jetons: 400 });
              assert.ok(pl.go && pl.variante === "tete-queue" && pl.text.includes("PARTIE OMISE"), "premier message enorme : tete coupee");
              for (let k = 6; k <= sec.length; k++) assert.ok(!pl.text.includes(sec.slice(0, k)), nom + " (decalage " + off + ") : prefixe de " + k + " caracteres dans le texte du plan");
              if (off === 1180 + 9 * 6) { orMode = "ok"; const n0 = orBodies.length; await F.run(pl, {}, {}); const vu = orBodies[orBodies.length - 1].messages[0].content;
                assert.ok(orBodies.length === n0 + 1 && !vu.includes(sec.slice(0, 6)), nom + " : rien du secret dans le corps envoye"); }
            } } }
        assert.strictEqual((fs.writeFileSync(VARIANTE_FILE, '{"variante":"tete-queue","tete_jetons":99999999}'), FC.readVariante().teteJetons), 50000, "tete_jetons plafonne a 50000");
        assert.strictEqual((fs.writeFileSync(VARIANTE_FILE, '{"variante":"tete-queue","tete_jetons":"9"}'), FC.readVariante().teteJetons), 8000, "tete_jetons texte : defaut 8000");
        // fichier absent : hybride, sans invalide ; inconnue : journal + invalide
        fs.rmSync(VARIANTE_FILE, { force: true }); { const F = fresh(); const pl = F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: msgs } }, () => confIn());
          assert.ok(pl.go && pl.variante === "hybride" && !pl.invalide, "fichier absent : hybride, sans marque"); }
        fs.writeFileSync(VARIANTE_FILE, '{"variante":"nimporte"}'); { const F = fresh(); const pl = F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: msgs } }, () => confIn());
          assert.ok(pl.go && pl.variante === "journal" && pl.invalide === true, "variante inconnue : journal + invalide"); }
        // court : 3000 fixe, ou court_max_jetons + 200 au-dela
        for (const [cm, att] of [[500, 3000], [1500, 3000], [2800, 3000], [3500, 3700], [8000, 8200]]) { fs.writeFileSync(VARIANTE_FILE, JSON.stringify({ variante: "court", court_max_jetons: cm })); const F = fresh();
          assert.strictEqual(F.decide({ url: "/v1/messages", headers: AUTO, body: { messages: msgs } }, () => confIn()).maxTokens, att, "court : max_tokens pour court_max_jetons " + cm); }
        setVariante("court"); }
      // dossier personnel : son nom seul (basename), different du nom d'utilisateur, est masque puis remis en clair
      { const F = fresh(), oh = os.homedir, ou = os.userInfo, n0 = orBodies.length; orMode = "ok"; let r;
        os.homedir = () => "C:\\Users\\Zebulon-Dossier"; os.userInfo = () => ({ username: "autre-nom-utilisateur" });
        try { r = await F.run(decideIn(F, "projet range dans Zebulon-Dossier par autre-nom-utilisateur"), {}, {}); } finally { os.homedir = oh; os.userInfo = ou; }
        const vu = orBodies[orBodies.length - 1].messages[0].content;
        assert.ok(orBodies.length === n0 + 1 && !/zebulon-dossier/i.test(vu) && !/autre-nom-utilisateur/i.test(vu) && /\[PERSO-[0-9a-f]{6}-\d+\]/.test(vu), "dossier : le nom du dossier personnel, seul, est masque : " + vu.slice(0, 200));
        assert.ok(r.ok && r.text.includes("Zebulon-Dossier") && r.text.includes("autre-nom-utilisateur") && !/\[PERSO-[0-9a-f]{6}-/.test(r.text), "dossier : remis en clair dans le resume"); }
      // nom d'utilisateur et dossier de 1 ou 2 caracteres : jamais masques seuls (ils couperaient les mots), le chemin complet l'est toujours
      { const F = fresh(), oh = os.homedir, ou = os.userInfo, n0 = orBodies.length; orMode = "ok"; let r;
        os.homedir = () => "C:\\Users\\ab"; os.userInfo = () => ({ username: "ab" });
        try { r = await F.run(decideIn(F, "table abattue dans C:\\Users\\ab\\projet"), {}, {}); } finally { os.homedir = oh; os.userInfo = ou; }
        const vu = orBodies[orBodies.length - 1].messages[0].content;
        assert.ok(orBodies.length === n0 + 1 && vu.includes("table abattue") && !vu.includes("C:\\Users\\ab") && /\[PERSO-[0-9a-f]{6}-\d+\]/.test(vu), "nom court : les mots ordinaires restent, le chemin est masque : " + vu.slice(0, 200));
        assert.ok(r.ok && r.text.includes("C:\\Users\\ab") && !/\[PERSO-[0-9a-f]{6}-/.test(r.text), "nom court : le chemin est remis en clair dans le resume"); }
    } finally { for (const [k, v] of envSave) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } orMode = "ok"; }
    console.log("PASS — en process : duree du blocage (vide/nulle/negative ignorees), adresse imposee, reponse piegee, dossier personnel");

    // --- client parti : l'appel a Nemotron est coupe, Claude n'est pas appele, pas de blocage ---
    writeConf(DIR_A, PORT_A, CONF(FREE({ timeoutMs: 30000 }))); orMode = "hang";
    { const b = snap(), c0 = orClosed;
      await ask(PORT_A, compactBody(), AUTO, { abortAfterMs: 400 });
      for (let i = 0; i < 20 && orClosed === c0; i++) await sleep(100);
      assert.ok(orClosed > c0, "client parti : l'appel au faux OpenRouter est coupe");
      for (let i = 0; i < 40 && !/COMPACT-GRATUIT abandon raison=client-parti/.test(logOf(DIR_A)); i++) await sleep(50);
      assert.ok(/COMPACT-GRATUIT abandon raison=client-parti/.test(logOf(DIR_A)), "client parti : ligne de journal");
      orMode = "ok";
      // tout de suite, avant la fin des 400 ms de blocage du banc : un depart du client ne doit ni appeler Claude ni bloquer Nemotron
      const r = await ask(PORT_A, compactBody(), AUTO);
      assert.deepStrictEqual(snap(), { anth: b.anth, or: b.or + 2 }, "client parti : Claude n'est pas appele (ni a sa place, ni par un blocage a tort)");
      assert.ok(r.raw.includes("<summary>"), "client parti : le detour reprend aussitot"); }
    console.log("PASS — client parti : appel coupe, pas de repli, pas de blocage");

    // --- commande cqr compact gratuit (copie jetable, jamais le vrai tokens.json) ---
    const DIR_C = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-free-c-"));
    try {
      for (const f of ["cli.js", "lib.js", "compaction.js", "free-compact.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR_C, f));
      fs.writeFileSync(p.join(DIR_C, "tokens.json"), JSON.stringify({ port: 8787, compaction: { enabled: true, dryRun: false, keepToolUses: 7 }, tokens: [{ name: "1", token: FAKE, enabled: true }] }));
      const cli = (...a) => cp.spawnSync(process.execPath, [p.join(DIR_C, "cli.js"), ...a], { encoding: "utf8", windowsHide: true, env: Object.assign({}, process.env, { OPENROUTER_API_KEY: FAKE_OR_KEY }) });
      const conf = () => JSON.parse(fs.readFileSync(p.join(DIR_C, "tokens.json"), "utf8"));
      let r = cli("compact", "gratuit", "status");
      assert.strictEqual(r.status, 0, "cli status : sortie 0 : " + r.stderr);
      assert.ok(/coupé \(défaut\)/.test(r.stdout) && r.stdout.includes("nvidia/nemotron-3-ultra-550b-a55b:free"), "cli status : coupe par defaut, modele affiche");
      r = cli("compact", "gratuit", "on");
      assert.strictEqual(r.status, 0, "cli on : sortie 0 : " + r.stderr);
      assert.strictEqual(conf().compaction.free.enabled, true, "cli on : reglage ecrit");
      assert.strictEqual(conf().compaction.keepToolUses, 7, "cli on : le reste de la config est intact");
      assert.strictEqual(conf().tokens[0].token, FAKE, "cli on : les jetons sont intacts");
      r = cli("compact", "gratuit", "noms", "Alice, Bob ,Alice");
      assert.deepStrictEqual(conf().compaction.free.names, ["Alice", "Bob"], "cli noms : liste nettoyee et dedoublonnee");
      r = cli("compact", "gratuit", "status");
      assert.ok(/ACTIVÉ/.test(r.stdout) && r.stdout.includes("Alice, Bob") && /présente dans ce terminal/.test(r.stdout), "cli status : actif, noms, cle presente (sans la montrer)");
      for (const c of [["compact", "gratuit", "on"], ["compact", "gratuit", "status"], ["compact", "gratuit", "noms", "xyz"], ["compact"]]) { const o = cli(...c); assert.ok(!(o.stdout + o.stderr).includes(FAKE) && !(o.stdout + o.stderr).includes(FAKE_OR_KEY) && !/"tokens"/.test(o.stdout), "cli " + c.join(" ") + " : ni jeton, ni cle, ni fichier"); }
      assert.ok(/gratuit\s*:\s*ACTIVÉ/.test(cli("compact").stdout), "cli compact : la ligne gratuit apparait");
      cli("compact", "gratuit", "noms", "");
      assert.deepStrictEqual(conf().compaction.free.names, [], "cli noms \"\" : liste videe");
      r = cli("compact", "gratuit", "off");
      assert.strictEqual(conf().compaction.free.enabled, false, "cli off : coupe");
      // noms : moins de 3 caracteres refuse, rien n'est ecrit
      cli("compact", "gratuit", "noms", "Alice,Bob");
      r = cli("compact", "gratuit", "noms", "Carole,xy");
      assert.strictEqual(r.status, 1, "cli noms court : sortie 1");
      assert.ok(/3 caractères/.test(r.stderr) && r.stderr.includes("xy") && !r.stderr.includes("Carole"), "cli noms court : message clair, le nom fautif nomme : " + r.stderr);
      assert.deepStrictEqual(conf().compaction.free.names, ["Alice", "Bob"], "cli noms court : la liste n'a pas bougé");
      assert.strictEqual(cli("compact", "gratuit", "noms", "abc").status, 0, "cli noms : 3 caracteres acceptes");
      // compaction coupee ou absente : pas de detournement, on le dit en une ligne, et la ligne gratuit montre l'etat effectif
      for (const [nom, couper] of [["cqr compact off", () => cli("compact", "off")], ["compaction.enabled absent", () => { const c = conf(); delete c.compaction.enabled; fs.writeFileSync(p.join(DIR_C, "tokens.json"), JSON.stringify(c)); }]]) {
        cli("compact", "on"); cli("compact", "gratuit", "on"); couper();
        r = cli("compact", "gratuit", "on");
        assert.strictEqual(r.stdout.split("\n").filter((l) => /compactage coupé : /.test(l) && l.includes("cqr compact on")).length, 1, nom + " : gratuit on dit en une ligne que le compactage est coupe : " + r.stdout);
        const st = cli("compact").stdout;
        assert.ok(/gratuit\s*:\s*sans effet/.test(st) && !/gratuit\s*:\s*ACTIVÉ/.test(st), nom + " : la ligne gratuit montre l'etat effectif : " + st.split("\n").filter((l) => /gratuit/.test(l)).join(" | "));
        assert.ok(/compactage coupé/.test(cli("compact", "gratuit", "status").stdout), nom + " : gratuit status le dit aussi");
      }
      cli("compact", "on");
      assert.ok(/gratuit\s*:\s*ACTIVÉ/.test(cli("compact").stdout), "cli : compaction rallumee, la ligne gratuit redevient ACTIVÉ");
      cli("compact", "gratuit", "off");
      r = cli("compact", "gratuit", "n'importe quoi");
      assert.strictEqual(r.status, 1, "cli : sous-commande inconnue -> sortie 1");
      assert.ok(cli("help").stdout.includes("cqr compact gratuit"), "cli help : la commande est listee");
    } finally { try { fs.rmSync(DIR_C, { recursive: true, force: true }); } catch (e) {} }
    console.log("PASS — commande : on/off/status/noms (3 caracteres minimum), compactage coupe ou absent, config et jetons intacts, jamais le fichier ni une cle");
  } catch (e) { failed = e; }
  finally {
    try { fs.rmSync(VARIANTE_FILE, { force: true }); } catch (e) {}
    for (const c of [relayA, relayB, relayC, relayD, relayE]) try { c && c.kill(); } catch (e) {}
    try { mockAnth.close(); mockOr.close(); } catch (e) {}
    await sleep(200);
    for (const d of [DIR_A, DIR_B, DIR_C2, DIR_D, DIR_E]) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  }
  if (failed) { console.error("FAIL:", failed.message); process.exit(1); }
})();
