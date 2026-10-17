// Parite des deux masques de secrets : free-compact.js (cqr) et openrouter-relay/src/filtre.js (DR-042, DR-089, DR-297, DR-393).
// Chaque copie porte ses motifs ; ce test echoue si l'une masque une famille que l'autre laisse passer.
// Faux secrets assembles a l'execution (le scan des commits ne les voit pas dans le source). Aucun reseau.
const assert = require("assert");
const fs = require("fs"), p = require("path");
const FC = require("../src/free-compact.js");

const FILTRE = p.join(__dirname, "..", "..", "openrouter-relay", "src", "filtre.js");
if (!fs.existsSync(FILTRE)) { console.log("parite-masques : openrouter-relay absent, saut"); process.exit(0); }
const FILT = require(FILTRE);

const A = (...x) => x.join("");
const CORPS = "Fake0123456789abcdefABCDEF0123456789"; // 36 car. : passe les seuils de longueur
// famille -> [texte complet, fragment qui ne doit plus apparaitre]
const FAMILLES = {
  "sk-ant": [A("cle ", "sk-ant-", "api03-", CORPS), CORPS],
  "sk-or": [A("cle ", "sk-or-", "v1-", CORPS), CORPS],
  "sk-proj": [A("cle ", "sk-proj-", CORPS), CORPS],
  "ghp_": [A("jeton ", "ghp", "_", CORPS), CORPS],
  "github_pat_": [A("jeton ", "github", "_pat_", "11AFAKE0123456789abcdef"), "11AFAKE0123456789abcdef"],
  "AKIA": [A("cle ", "AKIA", "FAKE0123456789AB"), "FAKE0123456789AB"],
  "ASIA": [A("cle ", "ASIA", "FAKE0123456789AB"), "FAKE0123456789AB"],
  "AIza": [A("cle ", "AIza", "SyFake0123456789abcdefABCDEF0123456"), "SyFake0123456789abcdefABCDEF0123456"],
  "xoxb": [A("jeton ", "xoxb", "-", "0123456789-FakeAbcdef"), "0123456789-FakeAbcdef"],
  "xapp": [A("jeton ", "xapp", "-", "1-FakeAbcdef012345"), "FakeAbcdef012345"],
  "sk_live": [A("cle ", "sk_", "live_", "Fake0123456789abcdefAB"), "Fake0123456789abcdefAB"],
  "npm_": [A("jeton ", "npm", "_", CORPS), CORPS],
  "hf_": [A("jeton ", "hf", "_", CORPS), CORPS],
  "glpat-": [A("jeton ", "glpat", "-", "Fake0123456789abcdefAB"), "Fake0123456789abcdefAB"],
  "gsk_": [A("cle ", "gsk", "_", CORPS), CORPS],
  "xai-": [A("cle ", "xai", "-", CORPS), CORPS],
  "tvly-": [A("cle ", "tvly", "-", CORPS), CORPS],
  "ya29.": [A("jeton ", "ya29", ".", "Fake0123456789abcdefABCDEF"), "Fake0123456789abcdefABCDEF"],
  "JWT": [A("jwt ", "eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiJmYXV4In0", ".", "FakeSignature_0123456789"), "FakeSignature_0123456789"],
  "Bearer nu": [A("Bearer", " ", "Fake0123456789abcdefABCDEF"), "Fake0123456789abcdefABCDEF"],
  "Authorization": [A("Authorization", ": ", "Basic ", "ZmF1eDpmYXV4MTIz"), "ZmF1eDpmYXV4MTIz"],
  "password=": [A("password", "=", "FauxMotDePasse42"), "FauxMotDePasse42"],
  "token=": [A("api_key", ": ", "Fake0123456789abcdefABCDEF"), "Fake0123456789abcdefABCDEF"],
  "URL postgres": [A("postgres://u:", "FauxMdp9Xy", "@h/base"), "FauxMdp9Xy"],
  "PEM": [A("-----BEGIN ", "PRIVATE KEY-----\nMIIFauxCorps0123\nLigne2Faux==\n-----END ", "PRIVATE KEY-----"), "MIIFauxCorps0123"],
  "cookie": [A("Cookie", ": ", "sid=Fake0123456789abc"), "Fake0123456789abc"],
};

// Rend { familleRatee: true } pour chaque famille dont le fragment survit au masque.
function ratees(masque) {
  const r = [];
  for (const [nom, [texte, reste]] of Object.entries(FAMILLES)) {
    let sortie;
    try { sortie = masque(`avant\n${texte}\napres`); } catch (e) { sortie = texte; }
    if (sortie.includes(reste)) r.push(nom);
  }
  return r;
}
// Compare deux masques : familles ratees par l'un seulement (divergence), et par les deux (trou commun).
function comparer(a, b) {
  const ra = ratees(a), rb = ratees(b);
  return { seulA: ra.filter((x) => !rb.includes(x)), seulB: rb.filter((x) => !ra.includes(x)), communes: ra.filter((x) => rb.includes(x)) };
}

const cqr = (t) => FC.maskSecrets(t, []);
const orr = (t) => FILT.maskSecrets(t, []);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// 1. Les listes de motifs partagees sont strictement identiques (type, source, drapeaux, presence du predicat).
const forme = (L) => L.map(([type, re, reel]) => [type, re.source, re.flags, !!reel].join("|"));
assert.deepStrictEqual(forme(FC.MOTIFS_SOURCE), forme(FILT.MOTIFS_SOURCE), "MOTIFS_SOURCE a derive entre free-compact.js et filtre.js");
n++;

// 2. Chaque secret disparait des DEUX sorties ; sinon la famille divergente est nommee.
const cmp = comparer(cqr, orr);
ok(cmp.seulA.length === 0 && cmp.seulB.length === 0,
  "couverture divergente : ratee par cqr seul = [" + cmp.seulA + "] ; par openrouter-relay seul = [" + cmp.seulB + "]");
// Aucun trou commun : gsk_, xai-, tvly-, ya29. (couvertes aussi par outils/deleguer.mjs) doivent etre masquees par les deux (DR-042).
ok(cmp.communes.length === 0, "famille ratee par les deux masques : " + cmp.communes);

// 2b. Faux positifs : du texte ordinaire qui ressemble a ces prefixes reste intact.
for (const t of ["le taxai-bleu roule", "texai-conduite", "xai-court", "gsk_court", "tvly-court", "ya29.court", "ya29 est un code", "mon tvly-12 et xai-3", "pitaya29.5 kg", "agsk_" + "a".repeat(8)]) {
  ok(cqr(t) === t && orr(t) === t, "faux positif : " + t);
}

// 3. Meme sortie sur un texte melange (pas seulement 'disparait' : le meme masquage).
const tout = Object.values(FAMILLES).map((v) => v[0]).join("\n");
ok(cqr(tout) === orr(tout), "sorties differentes sur le jeu complet");

// 4. Contre-epreuve : le comparateur detecte une famille retiree d'une copie, et un masque identite.
for (const nom of ["JWT", "AKIA", "password=", "URL postgres", "PEM", "sk-ant"]) {
  // masque degrade : applique cqr a tout, sauf aux lignes de la famille, rendues telles quelles
  const [texte] = FAMILLES[nom];
  const degrade = (t) => cqr(t.split(texte).join("\u0001")).split("\u0001").join(texte);
  const c = comparer(degrade, orr);
  ok(c.seulA.includes(nom), "contre-epreuve : " + nom + " retiree de cqr doit etre signalee, obtenu " + JSON.stringify(c));
  ok(comparer(orr, degrade).seulB.includes(nom), "contre-epreuve symetrique : " + nom);
}
const identite = comparer((t) => t, orr);
ok(identite.seulA.length >= Object.keys(FAMILLES).length - 4, "masque identite : presque toutes les familles signalees (" + identite.seulA.length + ")");

console.log("parite-masques : " + n + " verifications OK");
