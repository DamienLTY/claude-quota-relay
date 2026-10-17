/*
 * Noms et domaines de l'entreprise a masquer avant tout envoi gratuit (DR-297, DR-393)
 * =====================================================================================
 * Meme source que openrouter-relay, sans copier la liste : du dossier du relais gratuit (CQR_ENTREPRISE_DIR, sinon la premiere
 * ligne de ~/.claude-fcc/relay-dir.txt) on ne lit QUE config.json (`names`, `internes`), du JSON : aucun code de ce dossier n'est charge.
 * Les domaines de la machine (domaine Windows, suffixes DNS) sont lus par PowerShell, code recopie ici de openrouter-relay/src/domaines.js,
 * en asynchrone : le resultat est garde en cache, prechauffe au demarrage du relais ; un relais ne se fige jamais pour l'attendre.
 * Comme le relais gratuit (DR-393) : dossier inconnu, config.json illisible, lecture Windows en echec ou pas encore prete -> `repli`
 * renseigne, et free-compact.js ne part pas au modele gratuit (Claude, ou le journal, sert). Une liste vide reste acceptee (alerte, on continue).
 * Un domaine d'un seul mot (home, lan) n'est pas masque : il masquerait ce mot partout.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const REPRISE_MS = 10 * 60 * 1000; // apres un echec de la lecture Windows, pas de nouvel essai avant ce delai
const TEST = process.env.NODE_ENV === "test"; // les variables de surcharge CQR_POWERSHELL* ne valent que dans les tests : jamais un programme choisi par l environnement en production
const POWERSHELL = (TEST && process.env.CQR_POWERSHELL) || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$o=[ordered]@{",
  "d=[string](Get-CimInstance Win32_ComputerSystem).Domain;",
  "s=@(Get-DnsClient | ForEach-Object { [string]$_.ConnectionSpecificSuffix });",
  "l=@((Get-DnsClientGlobalSetting).SuffixSearchList | ForEach-Object { [string]$_ })",
  "}",
  "$o | ConvertTo-Json -Compress",
].join("\n");
const VALID = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

let ARGS = ["-NoProfile", "-NonInteractive", "-Command", SCRIPT];
if (TEST && process.env.CQR_POWERSHELL_ARGS) { try { const a = JSON.parse(process.env.CQR_POWERSHELL_ARGS); if (Array.isArray(a)) ARGS = a.map(String); } catch { /* valeur invalide : arguments par defaut */ } }
let lancer = () => new Promise((ok, ko) => cp.execFile(POWERSHELL, ARGS, { windowsHide: true, encoding: "utf8", timeout: 30000 }, (e, out) => (e ? ko(e) : ok(out))));
// Lue une fois par demarrage du relais (une lecture reussie est gardee, rafraichie au redemarrage : un changement de domaine ou de VPN n est vu qu apres) ; un echec est retente toutes les 10 min.
let win = null; // { domaines } | { enCours: true } | { echecJusqua, raison }

const erreur = (code) => Object.assign(new Error(code), { code });
function normaliser(liste) {
  const out = new Set();
  for (const v of liste) {
    if (v == null) continue;
    const d = String(v).trim().toLowerCase().replace(/^(\*\.)?\.*/, "").replace(/\.+$/, "");
    if (!d || d === "workgroup") continue;
    if (!VALID.test(d)) throw erreur("domaine-invalide"); // jamais la valeur dans l'erreur
    out.add(d);
  }
  return [...out];
}
function lireWindows() {
  if (win && (win.enCours || win.domaines || Date.now() < win.echecJusqua)) return;
  if (process.platform !== "win32" && lancer.name !== "injecte" && !(TEST && process.env.CQR_POWERSHELL)) { win = { domaines: [] }; return; } // hors Windows : aucune source systeme
  win = { enCours: true };
  const mine = win;
  const fin = (r) => { if (win === mine) win = r; };
  lancer().then((out) => {
    const j = JSON.parse(String(out).replace(/^﻿/, ""));
    if (!j || typeof j !== "object") throw erreur("reponse-inattendue");
    const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    fin({ domaines: normaliser([j.d, ...arr(j.s), ...arr(j.l)]) });
  }).catch((e) => fin({ echecJusqua: Date.now() + REPRISE_MS, raison: typeof (e && e.code) === "string" ? e.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || "erreur" : "erreur" }));
}
function prechauffer() { lireWindows(); }
function reinitialiser(fn) { win = null; if (fn) { const f = () => fn(); Object.defineProperty(f, "name", { value: "injecte" }); lancer = f; } }

// chemin absolu exigé : pas de relatif, pas de chemin reseau (\hote ou //hote)
const sur = (d) => typeof d === "string" && d && path.isAbsolute(d) && !/^[\\/]{2}/.test(d);
function dossierRelais() {
  let d = process.env.CQR_ENTREPRISE_DIR;
  if (!d) { try { d = fs.readFileSync(path.join(os.homedir(), ".claude-fcc", "relay-dir.txt"), "utf8").split(/\r?\n/)[0].trim(); } catch { return null; } }
  return sur(d) ? d : null;
}
const liste = (v) => (Array.isArray(v) ? v : []).map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
// formes du nom que le masque exact ne verrait pas : sans accents, accents decomposes (NFD), espaces encodes (%20, +)
function variantes(nom) {
  const s = new Set([nom, nom.normalize("NFC"), nom.normalize("NFD"), nom.normalize("NFD").replace(/\p{M}/gu, "")]);
  for (const v of [...s]) if (v.includes(" ")) { s.add(v.replace(/ /g, "%20")); s.add(v.replace(/ /g, "+")); }
  return [...s];
}

// { noms, domaines, alertes[], repli } ; ne leve jamais. repli : raison (texte fixe) pour ne PAS partir au modele gratuit, sinon null.
function charger() {
  const dir = dossierRelais();
  const vide = (repli, detail) => ({ noms: [], domaines: [], alertes: [repli + (detail ? ":" + detail : "")], repli });
  if (!dir) return vide("masque-dossier-inconnu");
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); } catch { return vide("masque-config-illisible"); }
  // cle absente = liste vide (comme le relais gratuit) ; presente, elle doit etre un tableau de chaines, sinon config illisible (DR-393)
  const tabChaines = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  if (!j || typeof j !== "object" || !tabChaines(j.names) || !tabChaines(j.internes)) return vide("masque-config-illisible");
  lireWindows();
  if (!win || win.enCours) return vide("masque-pas-pret");
  if (!win.domaines) return vide("masque-windows-illisible", win.raison);
  let internes;
  try { internes = normaliser(liste(j && j.internes)); } catch { return vide("masque-config-illisible"); }
  const domaines = [...new Set([...win.domaines, ...internes])].filter((d) => d.includes("."));
  const noms = [...new Set(liste(j && j.names).filter((n) => n.length >= 3).flatMap(variantes))];
  return { noms, domaines, alertes: !noms.length && !domaines.length ? ["liste-vide"] : [], repli: null };
}

module.exports = { charger, prechauffer, reinitialiser };
