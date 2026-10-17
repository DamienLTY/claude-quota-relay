// Ecriture atomique de tokens.json (revue securite M3) : une coupure en cours d'ecriture laisse l'ancien fichier intact.
const fs = require("fs"), os = require("os"), p = require("path");
const assert = require("assert");
const lib = require("../src/lib.js");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const dir = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-atom-"));
const f = p.join(dir, "tokens.json");
const lu = () => JSON.parse(fs.readFileSync(f, "utf8"));
const reste = () => fs.readdirSync(dir).filter((x) => x !== "tokens.json");

// (a) creation puis remplacement d'un fichier existant (rename sous Windows inclus) : complet et valide
lib.writeConf(f, { port: 1, tokens: [{ name: "a" }] });
ok(lu().port === 1, "creation : fichier valide");
lib.writeConf(f, { port: 2, tokens: [{ name: "a" }, { name: "b" }] });
ok(lu().port === 2 && lu().tokens.length === 2, "remplacement d'un fichier existant : complet et valide");
// (c) aucun temporaire apres un succes
ok(reste().length === 0, "aucun temporaire apres succes : " + reste());

// (b) coupure pendant l'ecriture du temporaire (moitie ecrite puis erreur) : l'ancien fichier reste intact
const avant = fs.readFileSync(f, "utf8");
const wf = fs.writeFileSync;
fs.writeFileSync = (path, data, ...r) => { wf(path, String(data).slice(0, 10), ...r); throw new Error("coupure simulee"); };
let leve = false;
try { lib.writeConf(f, { port: 3, tokens: [] }); } catch (e) { leve = /coupure/.test(e.message); } finally { fs.writeFileSync = wf; }
ok(leve, "l'erreur remonte a l'appelant");
ok(fs.readFileSync(f, "utf8") === avant, "coupure pendant l'ecriture : ancien fichier intact");
ok(lu().port === 2, "ancien fichier lisible");
ok(reste().length === 0, "temporaire nettoye apres coupure : " + reste());

// (b bis) crash avant le rename : l'ancien fichier reste intact
const rn = fs.renameSync;
fs.renameSync = () => { throw new Error("crash avant rename"); };
try { lib.writeConf(f, { port: 4 }); } catch (e) {} finally { fs.renameSync = rn; }
ok(fs.readFileSync(f, "utf8") === avant, "crash avant rename : ancien fichier intact");

console.log("conf-atomique : " + n + " verifications OK");
