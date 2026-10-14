// Repli de tokens.json (DR-220, DR-226 permanent) : ~/.etabli/cles/cqr-tokens.json lu ET ecrit s'il existe, sinon l'ancien.
const fs = require("fs"), os = require("os"), p = require("path");
const assert = require("assert");
const tmp = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-cles-"));
process.env.HOME = tmp; process.env.USERPROFILE = tmp; delete process.env.CLAUDE_CONFIG_DIR;
const lib = require("../src/lib.js");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const std = p.join(tmp, ".claude", "claude-quota-relay");
const cles = p.join(tmp, ".etabli", "cles", "cqr-tokens.json");
fs.mkdirSync(std, { recursive: true });
fs.writeFileSync(p.join(std, "tokens.json"), JSON.stringify({ port: 1111 }));

// 1. sans ~/.etabli/cles : l'ancien emplacement, comme avant etabli
ok(lib.confPath(std) === p.join(std, "tokens.json"), "sans cles : ancien tokens.json");
// 2. avec le fichier : lu ici
fs.mkdirSync(p.dirname(cles), { recursive: true });
fs.writeFileSync(cles, JSON.stringify({ port: 2222 }));
ok(lib.confPath(std) === cles, "avec cles : le fichier de ~/.etabli/cles");
ok(lib.readConf(lib.confPath(std)).port === 2222, "lu dans cles, pas dans l'ancien");
// 3. ecrit au meme endroit (cqr policy, install.js) ; l'ancien reste intact (DR-221)
const c = lib.readConf(lib.confPath(std)); c.port = 3333; lib.writeConf(lib.confPath(std), c);
ok(JSON.parse(fs.readFileSync(cles, "utf8")).port === 3333, "ecriture dans cles");
ok(JSON.parse(fs.readFileSync(p.join(std, "tokens.json"), "utf8")).port === 1111, "l'ancien n'est pas touche");
// 4. un dossier qui n'est pas l'installation standard (copie de test) garde son tokens.json
const autre = p.join(tmp, "copie-de-test"); fs.mkdirSync(autre);
ok(lib.confPath(autre) === p.join(autre, "tokens.json"), "dossier hors installation : jamais redirige");
// 5. le fichier de cles disparait : retour a l'ancien
fs.rmSync(cles);
ok(lib.confPath(std) === p.join(std, "tokens.json"), "cles retire : retour a l'ancien");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("cles-etabli : " + n + " verifications OK");

// memory-hook.js porte sa propre copie de la regle (il ne charge pas lib.js) : les deux doivent rendre la meme chose.
{
  const t = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-cles2-"));
  process.env.HOME = t; process.env.USERPROFILE = t;
  const copies = ["memory-hook.js", "ensure-proxy.js"].map((nom) => {
    const src = fs.readFileSync(p.join(__dirname, "..", "src", nom), "utf8");
    const m = /function confPath\(dir\) \{[\s\S]*?\n\}\n/.exec(src);
    ok(m, "confPath trouve dans " + nom);
    return new Function("p", "fs", "process", "require", m[0] + "\nreturn confPath;")(p, fs, process, require);
  });
  const std2 = p.join(t, ".claude", "claude-quota-relay");
  fs.mkdirSync(std2, { recursive: true });
  for (const copie of copies) {
    ok(copie(std2) === lib.confPath(std2), "sans cles : meme chemin");
    fs.mkdirSync(p.join(t, ".etabli", "cles"), { recursive: true });
    fs.writeFileSync(p.join(t, ".etabli", "cles", "cqr-tokens.json"), "{}");
    ok(copie(std2) === lib.confPath(std2) && copie(std2).includes("cles"), "avec cles : meme chemin, dans cles");
    ok(copie(p.join(t, "autre")) === lib.confPath(p.join(t, "autre")), "dossier hors installation : meme chemin");
  }
  fs.rmSync(t, { recursive: true, force: true });
  console.log("cles-etabli (memory-hook) : " + n + " verifications au total");
}
