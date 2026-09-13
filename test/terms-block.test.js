// Refus administratif d'Anthropic (DR-010) : detection du corps, et fenetre d'alerte.
// Aucun reseau, aucune fenetre ouverte (CQR_NO_POPUP + spawn factice). Run: node test/terms-block.test.js
const assert = require("assert");
const zlib = require("zlib");
const lib = require("../src/lib.js");

// le message exact rendu par Anthropic, tel que Claude Code l'affiche (releve du 2026-09-12)
const REAL = JSON.stringify({ type: "error", error: { type: "invalid_request_error",
  message: "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue." } });

// --- le motif reconnait le blocage, et LUI SEUL ---
assert.strictEqual(lib.isTermsBlock(REAL), true, "le message reel d'Anthropic doit etre reconnu");
assert.strictEqual(lib.isTermsBlock("You'll need to accept them in claude.ai"), true, "variante sans le mot Terms");
assert.strictEqual(lib.isTermsBlock(JSON.stringify({ type: "error", error: { message: "max_tokens: 1 is too small" } })), false,
  "un 400 ordinaire ne doit PAS etre pris pour un blocage (sinon on met un compte sain en quarantaine)");
assert.strictEqual(lib.isTermsBlock(""), false, "corps vide");
assert.strictEqual(lib.isTermsBlock(null), false, "corps absent");

// --- le corps arrive souvent compresse : le lire brut ne verrait rien ---
for (const [enc, zip] of [["gzip", zlib.gzipSync], ["deflate", zlib.deflateSync], ["br", zlib.brotliCompressSync]]) {
  const packed = zip(Buffer.from(REAL));
  assert.notStrictEqual(packed.toString("utf8"), REAL, enc + " : le corps compresse ne contient pas le texte en clair");
  assert.strictEqual(lib.isTermsBlock(lib.decodeBody(packed, enc)), true, enc + " : blocage reconnu apres decompression");
}
assert.strictEqual(lib.decodeBody(Buffer.from(REAL), null), REAL, "sans encodage : corps rendu tel quel");
assert.strictEqual(lib.decodeBody(Buffer.from("pas du gzip"), "gzip"), "pas du gzip",
  "en-tete menteur ou corps tronque : on rend les octets bruts plutot que de jeter la reponse");

// --- la fenetre : ce qui est REELLEMENT lance, et ce que le .vbs contient ---
// (l'affichage lui-meme a ete verifie a l'ecran le 2026-09-12 : wscript detache, MainWindowHandle
// non nul, message reel de ~400 caracteres -- ni PowerShell detache ni mshta ne tenaient, voir
// le commentaire de notifyWindows.)
{
  const prev = process.env.CQR_NO_POPUP; delete process.env.CQR_NO_POPUP;
  let call = null;
  const ok = lib.notifyWindows("titre : compte2", "ligne 1 jusqu'a" + String.fromCharCode(10) + 'avec un "guillemet"',
    (exe, args) => { call = { exe: exe, args: args }; return { unref() {} } });
  if (process.platform === "win32") {
    assert.strictEqual(ok, true, "notifyWindows doit rendre true");
    assert.strictEqual(call.exe, "wscript.exe", "lance wscript (pas mshta : limite de longueur, pas PowerShell : detache muet)");
    const vbs = require("fs").readFileSync(call.args[1], "utf8");
    assert.ok(/^MsgBox /.test(vbs), "le .vbs appelle MsgBox : " + vbs);
    assert.ok(vbs.indexOf("Chr(10)") > 0, "les retours a la ligne passent par Chr(10)");
    assert.ok(vbs.indexOf('""guillemet""') > 0, "un guillemet du message est double, sinon le script ne compile pas");
    assert.ok(vbs.indexOf("jusqu'a") > 0, "une apostrophe n'a pas a etre echappee en VBScript");
    assert.ok(/, 48, "titre : compte2"$/.test(vbs), "icone d'avertissement et titre en fin d'appel : " + vbs);
  }
  process.env.CQR_NO_POPUP = "1";
  assert.strictEqual(lib.notifyWindows("t", "m", () => { throw new Error("CQR_NO_POPUP doit empecher tout lancement"); }), false,
    "CQR_NO_POPUP=1 coupe la fenetre");
  if (prev === undefined) delete process.env.CQR_NO_POPUP; else process.env.CQR_NO_POPUP = prev;
}

console.log("terms-block.test.js OK");
