/*
 * Compactage gratuit (DR-069 a DR-072, DR-042, DR-066)
 * ====================================================
 * Quand Claude Code compacte (auto ou /compact), le relais peut faire ecrire le resume par Nemotron 3 Ultra
 * (gratuit, OpenRouter) au lieu de Claude, puis rendre ce resume a Claude Code comme si Claude l'avait ecrit.
 * Au moindre doute, ou au moindre echec, Claude sert : ce fichier ne decide jamais qu'un compactage est perdu.
 *
 * Ce qui part chez le tiers : le texte de la conversation (messages, appels d'outils, resultats), jamais le
 * systeme, les definitions d'outils ni le raisonnement. Les jetons et mots de passe sont masques DEFINITIVEMENT ;
 * le dossier personnel, le nom d'utilisateur et les noms de la config sont remplaces par un repere puis remis
 * en clair dans le resume rendu. Aucun envoi sans ce filtre (DR-042).
 *
 * Coupe par defaut (compaction.free.enabled) : DR-070, ce n'est voulu que sur certains postes.
 */
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const INVITE = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."; // debut de l'invite native de Claude Code
const KINDS_OK = ["auto", "manual"]; // DR-071 : "reactive" (debordement d'urgence) reste chez Claude, meme si la config le demande
const DEFAULT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const MAX_TOKENS_EST = 900000; // au-dela, Claude sert
const DEFAULT_BLOCK_MS = 10 * 60 * 1000; // apres une panne du service, Claude sert pendant ce temps
const DEFAULT_HOLD_MS = 60 * 1000; // delai avant d'ouvrir le flux du client : sous sa fenetre de premier octet (120 s)
const MAX_REPLY = 2 * 1024 * 1024; // octets : une reponse plus grosse est coupee, Claude sert
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"]; // seuls hotes pour lesquels CQR_FREE_COMPACT_URL est honoree
const REFUS_QUALITE = /^(texte-vide|sans-summary|trop-court|repere-inconnu|finish-)/; // un resume refuse ne pose pas de blocage
const MASK = "[SECRET-MASQUE]";
const MAX_DELAY = 2 ** 31 - 1; // setTimeout : au-dela, le delai retombe a 1 ms

// ----- masquage definitif des secrets -----
// Copie des motifs de etabli/outils/scan-secrets.mjs (MAQUETTE, REEL, MOT_DE_PASSE, MOTIFS), a l'identique :
// test/free-compact.test.js compare ce tableau au fichier source quand il existe. FACTICE n'est PAS repris : le scanner
// laisse passer un jeton qui se dit faux, un masqueur doit au contraire masquer dans le doute.
const MAQUETTE = /(^|[-_])(fake|test|dummy|mock|example|exemple|factice|placeholder|redacted|your|votre)([-_]|$)/i;
const REEL = (v) => /\d/.test(v) && /[a-z]/i.test(v) && !/(.)\1{5}/.test(v);
const MOT_DE_PASSE = (v) => REEL(v) && !(/^([a-z0-9_-]+|[A-Z0-9_-]+)$/.test(v) && (MAQUETTE.test(v) || /(^|[-_])passw(or)?d([-_]|$)/i.test(v)));
const MOTIFS_SOURCE = [
  ["jeton Anthropic", /(sk-ant-[\w-]{20,})/],
  ["jeton GitHub", /(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/],
  ["clé AWS", /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/],
  ["clé Google", /(AIza[\w-]{35})/],
  ["jeton OpenAI ou OpenRouter", /(sk-(?:proj|or)-[\w-]{20,}|\bsk-[A-Za-z0-9]{32,})/],
  ["jeton Slack", /(xox[a-z]-[\w-]{10,}|xapp-[\w-]{10,}|hooks\.slack\.com\/services\/[\w/]{20,})/],
  ["jeton Stripe, npm, Hugging Face ou GitLab", /\b(sk_live_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{36,}|hf_[A-Za-z0-9]{34,}|glpat-[\w-]{20,})/],
  ["clé privée", /(-----BEGIN [A-Z ]*PRIVATE KEY)/],
  ["affectation de secret", /(?:token|secret|api[_-]?key)\w{0,30}["'\\]*\s*[:=]\s*[\\"']*([\w+/=.~-]{20,})/i, REEL],
  ["mot de passe", /(?:pass|pwd)\w{0,30}["'\\]*\s*[:=]\s*[\\"']*([^\s"'\\,;<>${}()[\]]{8,})/i, MOT_DE_PASSE],
];
// Formes que le scanner ne voit pas, a part : test/free-compact.test.js compare MOTIFS_SOURCE au scanner, pas cette liste.
// Meme forme ; la valeur a masquer est le DERNIER groupe capturant. Ici, pas de seuil de longueur ni de chiffre : dans le doute, on masque.
const AFFECTATION = "(?:(?:password|passwd|pwd|secret|token|(?:private|access)[_-]?key|api[_-]?key)\\w{0,30}|(?<![A-Za-z0-9])pass)[\"'\\\\]*\\s*[:=!]+\\s*"; // pass seul (PASS=, DB_PASS:) mais pas passed: ni bypass= ; key seul jamais : il masquerait trop de code ordinaire
// Un nombre de jetons (max_tokens: 32768) n'est pas un secret : la famille token garde son nombre, pas password, secret ni api_key.
// Le motif commence au mot-cle (le plus a gauche) : m[0] debute donc par "token" quand c'est la famille token.
const PAS_UN_NOMBRE = (v, m) => !(/^tokens?(?!\w*(?:secret|pass|pwd|key))/i.test(m[0]) && /^\d[\d_ ,.]*$/.test(v));
const MOTIFS_PLUS = [
  ["JWT", /(eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*)/],
  ["en-tête Authorization", /authorization["'\\]*\s*[:=]\s*[\\"']*(?:bearer|basic)\s+([^\s"'\\]+)/i],
  ["mot de passe d'une adresse", /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:([^\s/]+)@/i], // schema borne : sans borne, une ligne a.b-a.b-... est quadratique (320 Ko = 111 s, relais fige)
  ["cookie", /\b(?:set-)?cookie["'\\]*\s*[:=]\s*[\\"']*([^\r\n]+)/i],
  ["affectation entre guillemets", new RegExp(AFFECTATION + "\\\\*([\"'])((?:(?!\\1)[^\\\\\\r\\n])+)", "i"), PAS_UN_NOMBRE],
  ["affectation", new RegExp(AFFECTATION + "([^\\s\"'\\\\,;<>${}()[\\]]+)", "i"), PAS_UN_NOMBRE],
  ["clé Stripe", /((?:sk|rk)_(?:test|live)_[A-Za-z0-9]+)/],
  ["sshpass", /\bsshpass\s+-p\s*["']?([^\s"']+)/],
  ["mysql", /\bmysql\w*\b[^\n]{0,200}?\s-p["']?([^\s"']+)/],
  ["option --password", /--(?:password|passwd|pwd|token|secret)[ =]+["']?([^\s"']+)/i],
  ["curl -u", /\bcurl\b[^\n]{0,200}?\s(?:-u|--user)[ =]+["']?[^\s:"']+:([^\s"']+)/i],
  ["login -p", /\blogin\b[^\n]{0,200}?\s(?:-p|--password)[ =]+["']?([^\s"']+)/i],
];
const CLE_PRIVEE = /-----BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?(?:-----END [A-Z ]*-----|(?=\n=== )|$)/g; // du BEGIN au premier END ou au prochain en-tete de role du rendu (\n=== ), sinon a la fin du texte
// "g" : toutes les occurrences ; "d" : indices des groupes, pour ne remplacer que la valeur
const MOTIFS = [...MOTIFS_SOURCE, ...MOTIFS_PLUS].map(([type, motif, reel]) => [type, new RegExp(motif.source, motif.flags + "gd"), reel]);

// exact : valeurs connues du relais (cle OpenRouter, jetons de la config), masquees telles quelles avant tout motif.
// Ligne par ligne, comme le scanner : ses motifs ont ete valides ainsi, et \s* ne doit pas enjamber un saut de ligne.
// La cle privee, elle, s'etend sur plusieurs lignes : masquee sur le texte entier, avant le decoupage.
function maskSecrets(text, exact) {
  for (const s of exact || []) text = text.split(s).join(MASK);
  return text.replace(CLE_PRIVEE, MASK).split("\n").map((ligne) => {
    for (const [, motif, reel] of MOTIFS) {
      let out = "", last = 0;
      for (const m of ligne.matchAll(motif)) {
        if (reel && !reel(m[m.length - 1], m)) continue;
        const [a, b] = m.indices[m.length - 1];
        out += ligne.slice(last, a) + MASK; last = b;
      }
      if (last) ligne = out + ligne.slice(last);
    }
    return ligne;
  }).join("\n");
}

// ----- masquage reversible : dossier personnel, nom d'utilisateur, noms de la config -----
function homeVariants(home) {
  const v = new Set([home, home.replace(/\\/g, "/"), home.replace(/[^A-Za-z0-9]/g, "-")]); // la derniere : C--Users-nom, le nom de dossier de projet de Claude Code
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(home);
  if (m) v.add("/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/")); // /c/Users/nom (Git Bash)
  return [...v];
}
function personalStrings(extraNames) {
  const s = [];
  const long = (n) => String(n).length >= 3; // un nom de 1 ou 2 caracteres masquerait des mots ordinaires : meme regle que les noms de la config
  try { const h = os.homedir(), b = path.basename(h); s.push(...homeVariants(h)); if (long(b)) s.push(b); } catch (e) {} // basename : le nom du dossier seul, il peut differer du nom d'utilisateur
  try { const u = os.userInfo().username; if (long(u)) s.push(u); } catch (e) {}
  return s.concat(extraNames || []);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Un repere par chaine d'origine, casse comprise : "Damie" et "damie" ont chacun le leur, et reviennent tels quels.
// Le repere porte un nonce tire a chaque appel : un "[PERSO-1]" deja dans le texte d'origine ne lui ressemble pas et n'est jamais
// restitue. unmask leve (raison "repere-inconnu") si un repere de ce nonce reste apres restitution : le modele en a invente un.
function makeMasker(strings) {
  const list = [...new Set(strings.filter((s) => typeof s === "string" && s.trim()))].sort((a, b) => b.length - a.length); // le plus long d'abord
  const re = list.length ? new RegExp(list.map(escapeRe).join("|"), "gi") : null;
  const nonce = crypto.randomBytes(3).toString("hex"), mine = new RegExp("\\[PERSO-" + nonce + "-\\d+\\]", "gi"); // "i" : un repere dont le modele a change la casse est inconnu, pas ignore
  const toMark = new Map(), toText = new Map();
  return {
    mask: (t) => (re ? t.replace(re, (s) => {
      let k = toMark.get(s);
      if (!k) { k = "[PERSO-" + nonce + "-" + (toMark.size + 1) + "]"; toMark.set(s, k); toText.set(k, s); }
      return k;
    }) : t),
    unmask: (t) => {
      const out = t.replace(mine, (k) => (toText.has(k) ? toText.get(k) : k));
      if (out.search(mine) !== -1) throw Object.assign(new Error("repere-inconnu"), { raison: "repere-inconnu" });
      return out;
    },
  };
}

// ----- rendu texte du corps de l'API (meme methode que le banc : generer.py / convertir.py) -----
const id6 = (id) => String(id == null ? "" : id).slice(-6);
function blockText(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(blockText).join("\n");
  if (typeof c === "object") {
    if (c.type === "text") return c.text || "";
    if (c.type === "image") return "[image]";
    if (c.type === "document") return "[document]";
    if (c.type === "tool_reference") return "[tool_reference " + (c.tool_name || "") + "]";
    return JSON.stringify(c);
  }
  return String(c);
}
const renderInput = (inp) => (inp && typeof inp === "object"
  ? Object.entries(inp).map(([k, v]) => k + ": " + (typeof v === "string" ? v : JSON.stringify(v))).join("\n")
  : String(inp));
// Garde texte, tool_use et tool_result ; ecarte thinking, redacted_thinking, systeme et definitions d'outils (hors de messages).
function renderConversation(body) {
  const out = []; let cur = null;
  const open = (role) => { if (cur !== role) { out.push("\n=== " + role + " ==="); cur = role; } };
  for (const m of (body && body.messages) || []) {
    const role = String((m && m.role) || "").toUpperCase();
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_result") { cur = null; open("USER [tool result #" + id6(b.tool_use_id) + "]"); cur = null; out.push(blockText(b.content)); continue; }
      const t = b.type === "text" ? b.text || ""
        : b.type === "image" ? "[image]"
        : b.type === "document" ? "[document]"
        : b.type === "tool_use" ? "[tool call " + b.name + " #" + id6(b.id) + "]\n" + renderInput(b.input) : null;
      if (t !== null) { open(role); out.push(t); }
    }
  }
  return out.join("\n").replace(/^\n+/, "") + "\n";
}

// ----- reconnaissance d'une demande de compactage -----
const hv = (v) => String(Array.isArray(v) ? v[0] : v == null ? "" : v).trim().toLowerCase();
function lastTextOfLastUser(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  const m = msgs.filter((x) => x && x.role !== "system").pop(); // Claude Code 2.1.289 termine la requete par un message "system" vide : l'invite est dans le dernier message non "system"
  if (!m || m.role !== "user") return "";
  if (typeof m.content === "string") return m.content;
  const texts = Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "text" && typeof b.text === "string") : [];
  return texts.length ? texts[texts.length - 1].text : ""; // l'invite est le dernier bloc, meme fusionnee avec un tool_result precedent
}
// { kind } si /v1/messages + en-tete de type + invite native en dernier ; null sinon. Un type absent = ce n'est pas un
// compactage connu : Claude sert (la classe, quand elle est annoncee, doit etre "compaction").
function recognize(url, headers, body) {
  if (String(url || "").split("?")[0] !== "/v1/messages") return null;
  const h = headers || {};
  const kind = hv(h["x-claude-code-compaction"]);
  if (!kind) return null;
  const cls = hv(h["x-claude-code-request-class"]);
  if (cls && cls !== "compaction") return null;
  if (!lastTextOfLastUser(body).trimStart().startsWith(INVITE)) return null;
  return { kind };
}

// ----- configuration compaction.free -----
function resolveConfig(f) {
  f = f && typeof f === "object" ? f : {};
  const pos = (v, d) => (Number(v) > 0 ? Math.min(Number(v), MAX_DELAY) : d);
  return {
    enabled: f.enabled === true,
    model: typeof f.model === "string" && f.model.trim() ? f.model.trim() : DEFAULT_MODEL,
    kinds: Array.isArray(f.kinds) ? f.kinds.map((k) => String(k).toLowerCase()).filter((k) => KINDS_OK.includes(k)) : KINDS_OK.slice(),
    timeoutMs: pos(f.timeoutMs, 240000),
    minSummaryChars: pos(f.minSummaryChars, 1500),
    names: Array.isArray(f.names) ? f.names.map((n) => String(n).trim()).filter(Boolean) : [],
    fallback: String(f.fallback || "").toLowerCase() === "claude" ? "claude" : "journal", // DR-106/108 : un echec rend le resume "journal", Claude ne sert plus que sur demande explicite
  };
}

// ----- variantes du compactage (DR-106, DR-108) : etabli/compactage.json, relu a chaque requete -----
// hybride : seule la queue (queue_jetons) part chez Nemotron ; journal : aucun appel, recopie des derniers echanges ;
// court : toute la conversation, resume plafonne a court_max_jetons ; tete-queue (DR-118) : comme hybride, plus les tete_jetons premiers jetons.
// Fichier absent : hybride, sans rien dire. Illisible, trop gros ou variante inconnue : journal (DR-116), avec invalide:true.
const VARIANTES = ["hybride", "journal", "court", "tete-queue"];
const CHARS_PAR_JETON = 3.2;
const JOURNAL_CHARS = 6000;
const MAX_FICHIER = 64 * 1024; // octets : un fichier de variante plus gros est refuse
// Fichier absent : defauts, sans rien dire. Illisible, trop gros ou variante inconnue : variante journal, avec invalide:true (le relais le journalise).
function readVariante() {
  const file = process.env.CQR_COMPACTAGE_FILE || path.join(os.homedir(), ".etabli", "compactage.json");
  let j = {}, invalide = false;
  try {
    if (fs.statSync(file).size > MAX_FICHIER) throw new Error("trop-gros");
    j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("pas-un-objet");
  } catch (e) { j = {}; invalide = e.code !== "ENOENT"; }
  const pos = (v, d, max) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : d);
  if (j.variante !== undefined && !VARIANTES.includes(j.variante)) invalide = true; // exactement dans la liste : ni String() ni minuscules (DR-116)
  const out = { variante: invalide ? "journal" : j.variante === undefined ? "hybride" : j.variante, queueJetons: pos(j.queue_jetons, 25000, 200000), courtMax: pos(j.court_max_jetons, 1500, 8000), teteJetons: pos(j.tete_jetons, 8000, 50000) };
  if (invalide) out.invalide = true;
  return out;
}
const hasToolResult = (m) => !!m && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result");
// Garde les derniers messages dans la limite de maxChars (rendu texte), coupe sur une limite de message ; ne commence jamais par
// un tool_result dont le tool_use est parti. Le dernier message (l'invite) reste toujours.
function tailMessages(msgs, maxChars) {
  let start = msgs.length - 1, used = renderConversation({ messages: [msgs[start]] }).length;
  while (start > 0) {
    const n = renderConversation({ messages: [msgs[start - 1]] }).length;
    if (used + n > maxChars) break;
    used += n; start--;
  }
  while (start < msgs.length - 1 && hasToolResult(msgs[start])) start++;
  return msgs.slice(start);
}
// Nombre de premiers messages qui tiennent dans maxChars (rendu texte), sans jamais depasser l'index `avant` (le debut de la queue).
function headMessages(msgs, maxChars, avant) {
  let end = 0, used = 0;
  while (end < avant) {
    const n = renderConversation({ messages: [msgs[end]] }).length;
    if (used + n > maxChars) break;
    used += n; end++;
  }
  return end;
}
// Texte utilisateur et assistant seulement : ni resultats d'outils, ni appels, ni raisonnement.
// sansInvite : le bloc dont le texte commence par l'invite native est retire, ou qu'il soit dans le message.
function plainText(m, sansInvite) {
  if (!m) return "";
  const garde = (t) => !(sansInvite && t.trimStart().startsWith(INVITE));
  if (typeof m.content === "string") return garde(m.content) ? m.content : "";
  return Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "text" && typeof b.text === "string" && garde(b.text)).map((b) => b.text).join("\n") : "";
}
const JOURNAL_SECOURS = "<summary>\nCompactage sans resume (variante journal, texte indisponible). Le journal de session est reinjecte apres ce compactage : il porte la tache en cours, les decisions et les fichiers touches.\n</summary>";
function journalSummary(body) {
  const parts = []; let used = 0;
  const msgs = ((body && body.messages) || []).filter((m) => m && (m.role === "user" || m.role === "assistant"));
  for (let i = msgs.length - 1; i >= 0 && used < JOURNAL_CHARS; i--) {
    let t = plainText(msgs[i], true).trim();
    if (!t) continue;
    t = t.replace(/<(\/?)summary>/gi, "[$1summary]"); // Claude Code s'arrete a la premiere balise fermante : le texte recopie ne doit pas en porter
    const keep = Math.max(200, JOURNAL_CHARS - used);
    if (used + t.length > JOURNAL_CHARS && t.length > keep) t = "[...] " + t.slice(t.length - keep);
    parts.unshift("=== " + String(msgs[i].role).toUpperCase() + " ===\n" + t); used += t.length;
  }
  return "<summary>\nCompactage sans resume ecrit par un modele (variante journal). Le journal de session est reinjecte apres ce compactage : "
    + "il porte la tache en cours, les decisions et les fichiers touches. Derniers echanges, recopies tels quels :\n\n" + (parts.join("\n\n") || "(aucun texte)") + "\n</summary>";
}

// ----- decision avant tout octet -----
let blockedUntil = 0; // apres une panne du service, Claude sert jusque-la (en memoire : un redemarrage du relais l'efface)
// Duree lue dans l'environnement : vide, non numerique, nulle ou negative = ignoree, la valeur par defaut vaut.
const envMs = (nom, defaut) => { const n = Number(process.env[nom]); return process.env[nom] != null && isFinite(n) && n > 0 ? Math.min(n, MAX_DELAY) : defaut; };
const blockMs = () => envMs("CQR_FREE_COMPACT_BLOCK_MS", DEFAULT_BLOCK_MS);
const holdMs = () => envMs("CQR_FREE_COMPACT_HOLD_MS", DEFAULT_HOLD_MS);
const hasKey = () => !!String(process.env.OPENROUTER_API_KEY || "").trim();
// CQR_FREE_COMPACT_URL n'est honoree que vers la machine elle-meme : sur un autre hote, la variable partirait avec la conversation
// et la cle. Ignoree -> l'adresse d'OpenRouter, et le relais le dit (urlIgnoree), sans jamais ecrire l'adresse.
function endpoint() {
  const o = String(process.env.CQR_FREE_COMPACT_URL || "").trim();
  if (!o) return { url: DEFAULT_URL };
  try { if (LOCAL_HOSTS.includes(new URL(o).hostname)) return { url: o }; } catch (e) {}
  return { url: DEFAULT_URL, urlIgnoree: true };
}

// null : pas un compactage reconnu, rien a dire. { go:false, raison, quiet } : Claude sert (quiet = reglage coupe, rien a journaliser).
// { go:true, kind, cfg, text, url, urlIgnoree, secrets } : on detourne. secrets : valeurs exactes a masquer (cle OpenRouter, jetons de la config).
function decide(req, getConf) { // getConf : la config ne se lit que pour un vrai compactage, pas a chaque requete
  const rec = recognize(req.url, req.headers, req.body);
  if (!rec) return null;
  const conf = getConf();
  const cc = (conf && conf.compaction) || {};
  const cfg = resolveConfig(cc.free);
  const no = (raison, quiet) => ({ go: false, kind: rec.kind, raison, quiet: !!quiet });
  if (!cfg.enabled) return no("reglage-coupe", true);
  if (!cc.enabled) return no("compaction-coupee"); // DR-066 : cqr compact off coupe tout ; absent = coupe, comme pour le proxy
  if (!cfg.kinds.includes(rec.kind)) return no("type-non-liste");
  const V = readVariante();
  const journal = (repli) => ({ go: true, kind: rec.kind, cfg, variante: "journal", repli, text: "", secrets: [], invalide: V.invalide });
  const repli = (raison) => cfg.fallback === "journal" ? journal(raison) : no(raison); // un repli rend le journal, sauf demande explicite de Claude
  if (V.variante === "journal") return journal(null); // aucun appel : ni cle ni service requis
  if (!hasKey()) return repli("cle-absente");
  if (Date.now() < blockedUntil) return repli("blocage");
  const secrets = [process.env.OPENROUTER_API_KEY, ...(Array.isArray(conf && conf.tokens) ? conf.tokens.map((t) => t && t.token) : [])]
    .map((v) => String(v == null ? "" : v).trim()).filter((v) => v.length >= 8).sort((a, b) => b.length - a.length); // le plus long d'abord
  let text, note;
  if (V.variante === "court") {
    text = renderConversation(req.body);
    note = "Ecris le <summary> en " + V.courtMax + " jetons au plus (resume bref, sans recopier les resultats d'outils).";
  } else if (V.variante === "tete-queue") {
    const msgs = (req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
    const tail = tailMessages(msgs, Math.floor(V.queueJetons * CHARS_PAR_JETON)), start = msgs.length - tail.length;
    const headMax = Math.floor(V.teteJetons * CHARS_PAR_JETON), end = headMessages(msgs, headMax, start);
    if (end >= start) { // tete et queue se touchent ou se recouvrent : la conversation entiere, une seule fois
      text = renderConversation({ messages: msgs });
      note = "La conversation t'est montree en entier. Garde les faits etablis au debut (contexte, decisions, contraintes) et l'etat courant a la fin : but, avancement, prochaine etape.";
    } else {
      let head;
      if (end) head = renderConversation({ messages: msgs.slice(0, end) });
      else { // un premier message plus gros que la tete : masque d'abord (un secret coupe ne serait plus reconnu), puis coupe, reculee au dernier blanc pour ne pas trancher un repere
        const m1 = maskSecrets(renderConversation({ messages: msgs.slice(0, 1) }), secrets);
        head = m1.slice(0, headMax);
        if (m1.length > headMax && !/\s/.test(m1[headMax])) head = head.replace(/\S+$/, "");
        head += "\n";
      }
      const omis = start - end;
      text = head + "\n[... PARTIE OMISE : " + omis + " message" + (omis > 1 ? "s" : "") + " du milieu de la conversation ne sont pas montres ...]\n\n" + renderConversation({ messages: tail });
      note = "Seuls le debut et la fin de la conversation t'ont ete montres ; le milieu est absent (une marque entre crochets le signale). Garde les faits etablis au debut (contexte, decisions, contraintes) et l'etat courant a la fin : but, avancement, prochaine etape.";
    }
  } else {
    const msgs = (req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
    text = renderConversation({ messages: tailMessages(msgs, Math.floor(V.queueJetons * CHARS_PAR_JETON)) });
    note = "Seule la fin de la conversation (les derniers echanges) t'est montree ; le debut est omis. Resume la tache en cours : but, etat d'avancement, prochaine etape.";
  }
  text = "[Consigne : " + note + "]\n\n" + text;
  if (Math.ceil(text.length / 3.5) > MAX_TOKENS_EST) return repli("trop-gros"); // meme estimation que compaction.js, legerement pessimiste
  return Object.assign({ go: true, kind: rec.kind, cfg, text, secrets, variante: V.variante, invalide: V.invalide, maxTokens: V.variante === "court" ? Math.max(3000, V.courtMax + 200) : 8000 }, endpoint()); // court (DR-115) : 3000 fixe (la place du bloc <analysis> avant le <summary>), sauf si court_max_jetons le depasse : il + 200
}

// ----- appel -----
// POST JSON ; rejette avec .code ("DELAI" au-dela de timeoutMs, "COUPE" si la reponse s'interrompt) ou .raison ("trop-gros" au-dela de
// MAX_REPLY octets : la connexion est coupee). La promesse se regle toujours. La cle n'est jamais dans une erreur.
function post(url, headers, bodyStr, timeoutMs, onReq) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    let timedOut = false, tooBig = false, size = 0;
    const fail = (e) => { clearTimeout(timer); reject(timedOut ? Object.assign(new Error("delai"), { code: "DELAI" }) : tooBig ? Object.assign(new Error("trop-gros"), { raison: "trop-gros" }) : e); };
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method: "POST", headers: Object.assign({}, headers, { "content-length": Buffer.byteLength(bodyStr) }) }, (res) => {
      const chunks = [];
      res.on("data", (c) => { size += c.length; if (size > MAX_REPLY) { tooBig = true; req.destroy(); fail(); } else chunks.push(c); });
      res.on("end", () => { clearTimeout(timer); try { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); } catch (e) { fail(e); } });
      res.on("error", fail);
      res.on("close", () => { if (!res.complete) fail(Object.assign(new Error("coupe"), { code: "COUPE" })); });
    });
    const timer = setTimeout(() => { timedOut = true; req.destroy(); }, timeoutMs);
    req.on("error", fail);
    if (onReq) onReq(req);
    req.end(bodyStr);
  });
}

// Valide ce que Nemotron a rendu : { text } ou { raison } (brute : le relais la passe par tag() avant le journal). Le texte est le brut,
// balises comprises : Claude Code en extrait <summary> lui-meme.
function validate(status, bodyText, cfg) {
  if (status !== 200) return { raison: "http-" + status };
  let j; try { j = JSON.parse(bodyText); } catch (e) { return { raison: "json-invalide" }; }
  const ch = j && j.choices && j.choices[0];
  if (!ch) return { raison: "sans-choix" };
  if (ch.finish_reason !== "stop") return { raison: "finish-" + ch.finish_reason };
  const text = ch.message && ch.message.content;
  if (typeof text !== "string" || !text.trim()) return { raison: "texte-vide" };
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text); // la meme extraction que Claude Code : la premiere balise fermee
  if (!m) return { raison: "sans-summary" };
  if (m[1].trim().length < cfg.minSummaryChars) return { raison: "trop-court" };
  return { text };
}

// Fait le detour. Ne rejette jamais : { ok:true, text, ms } ou { ok:false, raison }. io.onReq recoit la requete sortante (pour
// la couper si le client part), io.gone() dit si le client est parti. Une panne du service (HTTP, reseau, delai, reponse trop grosse) pose
// le blocage ; un resume refuse (REFUS_QUALITE) ou un client parti, non.
async function run(plan, body, io) {
  const t0 = Date.now();
  io = io || {};
  const viaJournal = (repli) => { let text; try { text = journalSummary(body); } catch (e) { text = JOURNAL_SECOURS; } return { ok: true, text, ms: Date.now() - t0, variante: "journal", repli, entree: plan.text ? plan.text.length : 0, sortie: text.length }; };
  if (plan.variante === "journal") return viaJournal(plan.repli || null);
  try {
    const masker = makeMasker(personalStrings(plan.cfg.names));
    const sent = masker.mask(maskSecrets(plan.text, plan.secrets)); // les secrets d'abord : un secret ne doit jamais entrer dans la table des reperes
    const reqBody = JSON.stringify({ model: plan.cfg.model, messages: [{ role: "user", content: sent }], max_tokens: plan.maxTokens || 8000, reasoning: { effort: "low" }, stream: false });
    const r = await post(plan.url, { "content-type": "application/json", "authorization": "Bearer " + String(process.env.OPENROUTER_API_KEY).trim() }, reqBody, plan.cfg.timeoutMs, io.onReq);
    const v = validate(r.status, r.body, plan.cfg);
    if (v.raison) throw Object.assign(new Error(v.raison), { raison: v.raison });
    const out = masker.unmask(v.text);
    return { ok: true, text: out, ms: Date.now() - t0, variante: plan.variante, repli: null, entree: plan.text.length, sortie: out.length };
  } catch (e) {
    if (io.gone && io.gone()) return { ok: false, raison: "client-parti" };
    const raison = e.raison || (e.code === "DELAI" ? "delai" : e.code ? "reseau-" + e.code : "erreur-" + e.name);
    if (!REFUS_QUALITE.test(raison)) blockedUntil = Date.now() + blockMs();
    return plan.cfg.fallback === "journal" ? viaJournal(raison) : { ok: false, raison };
  }
}

// ----- ecriture au client : le flux SSE complet d'Anthropic, ou un JSON si stream est faux -----
function sendSummary(res, body, text, stream) {
  const model = typeof (body && body.model) === "string" ? body.model : "claude";
  const message = { id: "msg_" + crypto.randomBytes(12).toString("hex"), type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Object.assign({}, message, { content: [{ type: "text", text }], stop_reason: "end_turn" })));
    return;
  }
  if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" });
  const ev = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
  res.end(
    ev("message_start", { type: "message_start", message }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }) +
    ev("message_stop", { type: "message_stop" }));
}

module.exports = { INVITE, MOTIFS_SOURCE, MAQUETTE, REEL, MOT_DE_PASSE, holdMs, readVariante, tailMessages, journalSummary, maskSecrets, makeMasker, renderConversation, recognize, resolveConfig, decide, validate, run, sendSummary };
