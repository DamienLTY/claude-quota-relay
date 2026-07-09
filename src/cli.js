#!/usr/bin/env node
/* claude-quota-relay CLI (`cqr`) — pilote le proxy de failover de tokens.
 *
 * Usage:
 *   cqr status                 etat des tokens + quota vu + attente en cours
 *   cqr list                   liste les tokens (masques)
 *   cqr use <nom|index>        EPINGLE le token actif (effet immediat, ignore regles+attente)
 *   cqr auto                   revient au mode automatique (failover + waiting)
 *   cqr reset                  oublie l'etat "epuise" (re-essaie tous les tokens)
 *   cqr set <nom> <token>      renseigne/ecrase le token d'un compte (script/manuel, sans prompt)
 *   cqr remove <nom>           retire un compte de la config
 *   cqr login <nom> [--paste]  recapture un token (navigateur, ou --paste pour le coller soi-meme)
 *   cqr add [nom] [--paste]    ajoute un compte (navigateur, ou --paste pour le coller soi-meme)
 *   cqr policy [<cle> <val>]   affiche/modifie la politique (switch|block7d|waitsoft|maxwait)
 *   cqr start|stop|restart     gere le process proxy (portable, via PID file)
 *
 * Portable : Windows / macOS / Linux (arret via PID file + process.kill, pas de netstat/lsof).
 */
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http");
const cp = require("child_process");
const lib = require("./lib.js");
const comp = require("./compaction.js");

// Repertoire d'installation = dossier de ce script (proxy.js, tokens.json, state.json sont a cote).
const DIR = __dirname;
const SETTINGS = p.join(p.dirname(DIR), "settings.json"); // install dir = <config>/claude-quota-relay
const CONF = p.join(DIR, "tokens.json");
const STATE = p.join(DIR, "state.json");
const PROXY = p.join(DIR, "proxy.js");
const PIDFILE = p.join(DIR, "proxy.pid");

function readConf() { return JSON.parse(fs.readFileSync(CONF, "utf8")); }
function writeConf(c) { fs.writeFileSync(CONF, JSON.stringify(c, null, 2)); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { return { activeIndex: 0, exhausted: {}, pct: {} }; } }
function writeState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
function isPlaceholder(t) { return !t || !t.token || /^(PASTE|REMPLACE|<)/i.test(t.token); }
function mask(tok) { return isPlaceholder({ token: tok }) ? "(vide)" : tok.slice(0, 14) + "..." + tok.slice(-4); }

function health(cb) {
  let c; try { c = readConf(); } catch (e) { return cb(null); }
  const req = http.get("http://127.0.0.1:" + (c.port || 8787) + "/__proxy_health", (r) => {
    let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => { try { cb(JSON.parse(d)); } catch (e) { cb(null); } });
  });
  req.on("error", () => cb(null));
  req.setTimeout(1500, () => { req.destroy(); cb(null); });
}

const OUT_LOG = p.join(DIR, "proxy.out.log");
const LOG = p.join(DIR, "proxy.log");

// Quand Claude Code démarre le proxy lui-même (hook ensure-proxy.js), il injecte l'env de
// settings.json (dont ANTHROPIC_TARGET_API_URL sur les réseaux d'entreprise) à ses process
// enfants. Un `cqr start`/`restart` lancé à la main depuis un terminal nu n'a PAS cette
// variable dans son propre process.env -> le proxy retombe sur api.anthropic.com direct,
// bloqué sur ces réseaux, alors que Claude Code fonctionne. Il faut la relire depuis
// settings.json et l'injecter explicitement, pour que démarrage manuel = démarrage auto.
function targetApiUrlFromSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
    return (JSON.parse(raw).env || {}).ANTHROPIC_TARGET_API_URL || null;
  } catch (e) { return null; }
}
function startProxy() {
  const out = fs.openSync(OUT_LOG, "a");
  const env = Object.assign({}, process.env);
  const target = targetApiUrlFromSettings();
  if (target && !env.ANTHROPIC_TARGET_API_URL) env.ANTHROPIC_TARGET_API_URL = target;
  const child = cp.spawn(process.execPath, [PROXY], { detached: true, stdio: ["ignore", out, out], windowsHide: true, env });
  child.unref();
}

// Last N lines of a (small) log file, or null if it doesn't exist / can't be read.
function tailFile(path, maxLines) {
  try {
    const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch (e) { return null; }
}

// startProxy() spawns a DETACHED child and returns immediately -- it can't tell you whether
// the process actually stayed up (crashed on a missing file, a port already in use, or killed
// outright by corporate antivirus/EDR software that distrusts detached background processes,
// all real failure modes reported by users). This polls the health endpoint for a few seconds
// after spawning and, on failure, surfaces the crash log tail instead of a false "started".
function startProxyAndVerify(cb) {
  startProxy();
  let tries = 0;
  const check = () => {
    health((h) => {
      if (h) return cb(true);
      tries++;
      if (tries < 15) return setTimeout(check, 200); // ~3s total
      cb(false);
    });
  };
  setTimeout(check, 200);
}
function reportStartFailure() {
  console.error("Le proxy a été lancé mais ne répond pas après 3 secondes (il a probablement planté).");
  // proxy.out.log ne capture que les crashs bruts (exception non attrapée avant que notre
  // propre log ne soit prêt) ; les erreurs GÉRÉES (port déjà pris, etc.) passent par notre
  // propre journal structuré (proxy.log) via log() -- il faut lire les DEUX, sinon on rate
  // exactement le cas le plus fréquent (EADDRINUSE), déjà arrivé en vrai à un utilisateur.
  const out = tailFile(OUT_LOG, 20);
  const structured = tailFile(LOG, 8);
  const port = (() => { try { return readConf().port || 8787; } catch (e) { return 8787; } })();
  const eaddrinuse = /EADDRINUSE/.test(out || "") || /EADDRINUSE/.test(structured || "");
  if (eaddrinuse) {
    console.error("\nCause identifiée (proxy.log) : le port " + port + " est déjà utilisé par un AUTRE programme sur cette machine (EADDRINUSE).");
    console.error("(Si vous utilisez Cloudflare Workers, `wrangler dev` prend exactement ce port par défaut — un conflit fréquent.)");
    console.error("\nSolution la plus simple — changez le port de claude-quota-relay :");
    console.error("  cqr policy port " + (Number(port) + 3) + "     # met à jour tokens.json ET settings.json, puis : cqr restart");
    return;
  }
  if (out) console.error("\nDernières lignes de proxy.out.log :\n" + out);
  else console.error("(proxy.out.log est vide ou introuvable)");
  if (structured) console.error("\nDernières lignes de proxy.log :\n" + structured);
  console.error("\nCauses fréquentes :");
  console.error("  - un fichier du proxy manque ou est corrompu -> relancez : node src/install.js (depuis le dossier du repo)");
  console.error("  - le port " + port + " est déjà utilisé par autre chose -> cqr policy port <n>");
  console.error("  - un antivirus/EDR d'entreprise bloque les process détachés en arrière-plan -> vérifiez les journaux de votre antivirus, ou lancez le proxy au premier plan pour voir l'erreur : node \"" + PROXY + "\"");
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

// Arret portable : lit le PID file ecrit par le proxy, envoie SIGTERM (ou taskkill en dernier
// recours Windows si le signal ne suffit pas). Pas de netstat/lsof — marche partout.
function stopProxy(cb) {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(PIDFILE, "utf8").trim(), 10); } catch (e) {}
  if (!pid || !pidAlive(pid)) {
    return health((h) => cb(h ? "unknown" : false));
  }
  try { process.kill(pid, "SIGTERM"); } catch (e) {}
  setTimeout(() => {
    if (!pidAlive(pid)) { try { fs.unlinkSync(PIDFILE); } catch (e) {} return cb(true); }
    if (process.platform === "win32") {
      cp.exec("taskkill /PID " + pid + " /F", { windowsHide: true }, () => { try { fs.unlinkSync(PIDFILE); } catch (e) {} cb(true); });
    } else {
      try { process.kill(pid, "SIGKILL"); } catch (e) {}
      try { fs.unlinkSync(PIDFILE); } catch (e) {}
      cb(true);
    }
  }, 1000);
}

// strip known bare flags before positional destructuring, so `cqr add --paste` doesn't
// treat "--paste" as the account name.
const [cmd, a1, a2, a3] = process.argv.slice(2).filter((x) => x !== "--paste");

function fmtPct(pctObj) {
  if (!pctObj) return "?";
  if (typeof pctObj === "number") return pctObj + "%";
  const parts = [];
  if (pctObj.h5 != null) parts.push("5h=" + pctObj.h5 + "%");
  if (pctObj.d7 != null) parts.push("7d=" + pctObj.d7 + "%");
  return parts.length ? parts.join(" ") : (pctObj.max != null ? pctObj.max + "%" : "?");
}
function eta(ms) {
  if (!ms) return "";
  const d = ms - Date.now(); if (d <= 0) return "maintenant";
  const m = Math.round(d / 60000);
  return m >= 60 ? Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") : m + "min";
}
function showStatus() {
  let c, s;
  try { c = readConf(); } catch (e) { console.error("Aucun tokens.json dans " + DIR + " — lancez d'abord l'installeur."); process.exit(1); }
  s = readState();
  const soft = c.waitAtSoftPercent == null ? "désactivé (utilise la marge 90-100% avant d'attendre)" : c.waitAtSoftPercent + "%";
  health((h) => {
    console.log("Proxy      :", h ? "EN COURS (port " + (c.port || 8787) + ")" : "ARRÊTÉ");
    console.log("Politique  : switch5h=" + (c.switchAtPercent || 94) + "%  block7d=" + (c.sevenDayBlockPercent || 99) + "%  waitSoft=" + soft + "  maxWait=" + Math.round((c.maxWaitMs || 604800000) / 60000) + "min");
    const pin = s.forceIndex != null && c.tokens[s.forceIndex] ? " [ÉPINGLÉ: " + c.tokens[s.forceIndex].name + "]" : "";
    console.log("Actif      :", ((c.tokens[s.activeIndex] && c.tokens[s.activeIndex].name) || "?") + pin);
    if (s.waiting) console.log("ATTENTE    : " + s.waiting.reason + " -> '" + s.waiting.target + "' reprend dans ~" + eta(Date.parse(s.waiting.until)));
    console.log("");
    c.tokens.forEach((t, i) => {
      const act = i === s.activeIndex ? ">" : " ";
      const ex = s.exhausted && s.exhausted[t.name] && Date.now() < s.exhausted[t.name];
      const exTxt = ex ? " [bloqué, libre dans ~" + eta(s.exhausted[t.name]) + "]" : "";
      const r5 = s.reset5h && s.reset5h[t.name]; const r7 = s.reset7d && s.reset7d[t.name];
      const resets = [r5 ? "reset5h~" + eta(r5) : "", r7 ? "reset7d~" + eta(r7) : ""].filter(Boolean).join(" ");
      console.log(` ${act} [${i}] ${t.name.padEnd(12)} ${t.enabled ? "on " : "off"} ${mask(t.token).padEnd(22)} quota:${fmtPct(s.pct && s.pct[t.name])}  ${resets}${exTxt}`);
    });
  });
}

switch (cmd) {
  case "status": case undefined: showStatus(); break;
  case "list": {
    const c = readConf();
    c.tokens.forEach((t, i) => console.log(`[${i}] ${t.name}  ${t.enabled ? "on" : "off"}  ${mask(t.token)}`));
    break;
  }
  case "use": {
    const c = readConf(); const s = readState();
    let idx = c.tokens.findIndex((t) => t.name === a1);
    if (idx < 0 && /^\d+$/.test(a1)) idx = Number(a1);
    if (idx < 0 || idx >= c.tokens.length) { console.error("Compte introuvable :", a1); process.exit(1); }
    s.activeIndex = idx; s.forceIndex = idx;
    if (s.exhausted) delete s.exhausted[c.tokens[idx].name];
    writeState(s);
    console.log("ÉPINGLÉ -> " + c.tokens[idx].name + " (forcé, effectif immédiatement). Lancez `cqr auto` pour revenir au mode automatique.");
    break;
  }
  case "login": case "add": {
    // login <name|index> [--paste] : (re)capture a token for an existing account, via
    //   `claude setup-token` (default) or by pasting one yourself (--paste, no browser).
    // add [name] [--paste]         : capture a token for a NEW account and append it.
    (async () => {
      const c = readConf();
      const paste = process.argv.includes("--paste");
      const tok = paste ? await lib.pasteTokenManually() : await lib.captureSetupToken();
      if (!tok) { console.error("\nAucun token récupéré. Vous ne voulez pas du navigateur ? Essayez : cqr " + cmd + " " + (a1 || "") + " --paste  (ou : cqr set <nom> <token>)"); process.exit(1); }
      let name;
      if (cmd === "add") {
        name = a1 || ("account-" + (c.tokens.length + 1));
        let t = c.tokens.find((x) => x.name === name);
        if (t) { t.token = tok; t.enabled = true; } else c.tokens.push({ name, token: tok, enabled: true });
      } else {
        let idx = c.tokens.findIndex((t) => t.name === a1);
        if (idx < 0 && /^\d+$/.test(a1 || "")) idx = Number(a1);
        if (idx < 0) idx = 0;
        if (!c.tokens[idx]) { console.error("Compte introuvable :", a1); process.exit(1); }
        c.tokens[idx].token = tok; c.tokens[idx].enabled = true; name = c.tokens[idx].name;
      }
      writeConf(c);
      const synced = lib.syncAuthToken(c, SETTINGS);
      console.log("\n✓ token enregistré pour '" + name + "' (" + mask(tok) + ")" + (synced ? " et synchronisé dans settings.json" : "") + ".");
      console.log("Lancez `cqr restart` puis redémarrez Claude Code pour que ce soit pris en compte.");
      process.exit(0);
    })();
    break;
  }
  case "sync-env": {
    const c = readConf();
    const okk = lib.syncAuthToken(c, SETTINGS);
    console.log(okk ? "1er token synchronisé dans settings.json (ANTHROPIC_AUTH_TOKEN)." : "Aucun token utilisable, ou settings.json introuvable.");
    break;
  }
  case "auto": { const s = readState(); delete s.forceIndex; writeState(s); console.log("Mode automatique réactivé (bascule + attente selon la politique)."); break; }
  case "reset": { const s = readState(); s.exhausted = {}; writeState(s); console.log("État 'épuisé' effacé."); break; }
  case "set": {
    if (!a1 || !a2) { console.error("Usage : cqr set <nom> <token>"); process.exit(1); }
    const c = readConf(); let t = c.tokens.find((x) => x.name === a1);
    if (!t) { t = { name: a1, token: a2, enabled: true }; c.tokens.push(t); } else { t.token = a2; t.enabled = true; }
    writeConf(c); console.log("Token '" + a1 + "' enregistré (" + mask(a2) + ").");
    break;
  }
  case "remove": case "rm": case "del": {
    if (!a1) { console.error("Usage : cqr remove <nom>"); process.exit(1); }
    const c = readConf();
    const before = c.tokens.length;
    c.tokens = c.tokens.filter((x) => x.name !== a1);
    if (c.tokens.length === before) { console.error("Aucun compte nommé '" + a1 + "'. Voir : cqr list"); process.exit(1); }
    writeConf(c);
    console.log("Compte '" + a1 + "' retiré. Redémarrez le proxy : cqr restart");
    break;
  }
  case "policy": {
    const c = readConf();
    if (!a1) {
      console.log("switch5h :", (c.switchAtPercent || 94) + "%   (préférer un compte sous ce % de 5h)");
      console.log("block7d  :", (c.sevenDayBlockPercent || 99) + "%   (ne jamais router vers un compte au-delà de ce % sur 7j)");
      console.log("waitSoft :", c.waitAtSoftPercent == null ? "désactivé" : c.waitAtSoftPercent + "%", "  (désactivé = consommer la marge 90-100% avant d'attendre)");
      console.log("maxWait  :", Math.round((c.maxWaitMs || 604800000) / 60000) + "min", "  (durée max de rétention d'une requête)");
      console.log("");
      console.log("port     :", c.port || 8787, "  (port local du proxy)");
      console.log("");
      console.log("Modifier : cqr policy <switch|block7d|waitsoft|maxwait|port> <valeur>   (waitsoft off|<N>, maxwait <minutes>)");
      break;
    }
    const v = a2;
    if (a1 === "switch") c.switchAtPercent = Number(v);
    else if (a1 === "block7d") c.sevenDayBlockPercent = Number(v);
    else if (a1 === "waitsoft") c.waitAtSoftPercent = (v === "off" || v === "null") ? null : Number(v);
    else if (a1 === "maxwait") c.maxWaitMs = Number(v) * 60000;
    else if (a1 === "port") {
      const newPort = Number(v);
      if (!newPort || newPort < 1 || newPort > 65535) { console.error("Port invalide :", v); process.exit(1); }
      c.port = newPort;
      writeConf(c);
      if (fs.existsSync(SETTINGS)) {
        const raw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
        const s = JSON.parse(raw);
        s.env = s.env || {};
        s.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + newPort;
        fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
      }
      console.log("Port changé pour " + newPort + " (tokens.json + settings.json mis à jour). Redémarrez : cqr restart");
      break;
    }
    else { console.error("Clé inconnue :", a1); process.exit(1); }
    writeConf(c); console.log("Politique mise à jour :", a1, "=", v);
    break;
  }
  case "live": {
    // Background quota poll (statusline "live" refresh) -- see src/proxy.js startLivePolling.
    const c = readConf();
    if (a1 === "off") { c.livePollMs = 0; writeConf(c); console.log("Rafraîchissement live désactivé (le quota ne se met à jour qu'avec de vraies requêtes). Redémarrez le proxy : cqr restart"); }
    else if (a1 && /^\d+$/.test(a1)) { c.livePollMs = Number(a1) * 1000; writeConf(c); console.log("Rafraîchissement toutes les " + a1 + "s. Redémarrez le proxy : cqr restart"); }
    else if (!a1 || a1 === "status") { console.log("livePollMs :", c.livePollMs == null ? "45000 (défaut)" : c.livePollMs, "-- sonde en arrière-plan (quasi gratuite : ~8 tokens d'entrée, 0 en sortie) qui garde le quota des DEUX comptes à jour pour la statusline, même à l'arrêt"); }
    else console.error("Usage : cqr live [status|<secondes>|off]");
    break;
  }
  case "compact": {
    const c = readConf(); c.compaction = c.compaction || {};
    const cc = c.compaction;
    if (a1 === "on") { cc.enabled = true; cc.dryRun = false; writeConf(c); console.log("Auto-compaction activée (clear_tool_uses natif + mémoire par projet). Redémarrez le proxy : cqr restart"); }
    else if (a1 === "off") { cc.enabled = false; cc.dryRun = false; writeConf(c); console.log("Auto-compaction désactivée."); }
    else if (a1 === "dry-run" || a1 === "dryrun") { cc.enabled = false; cc.dryRun = true; writeConf(c); console.log("Mode simulation : le proxy LOGUE seulement ce qu'il compacterait (rien ne change) ; la mémoire se construit quand même. Voir : proxy.log"); }
    else if (a1 === "mode") { cc.mode = a2 === "strip" ? "strip" : "native"; writeConf(c); console.log("Mode de compaction = " + cc.mode + (cc.mode === "strip" ? " (le proxy tronque lui-même les vieux résultats ; utile si Claude Code n'aime pas le mode natif)" : " (context-editing natif Anthropic, 0 token)")); }
    else if (a1 === "keep") { cc.keepToolUses = Number(a2) || 10; writeConf(c); console.log("Garde les " + cc.keepToolUses + " derniers résultats d'outils intacts."); }
    else if (a1 === "cooldown") { cc.compactionCooldownMs = Math.max(0, Number(a2) || 0) * 60000; writeConf(c); console.log("Délai minimum entre deux compactages = " + (a2 || 0) + "min."); }
    else if (a1 === "buffer") { cc.dynamicSafetyBufferPoints = Math.max(0, Number(a2) || 0); writeConf(c); console.log("Marge de sécurité dynamique = " + cc.dynamicSafetyBufferPoints + " points."); }
    else if (a1 === "threshold" || a1 === "seuil") {
      // cqr compact threshold <modele> <pct> : ajuste le % de bascule/compaction pour un modele
      const models = ["fable", "opus", "sonnet", "haiku", "default"];
      const m = String(a2 || "").toLowerCase(); const pct = Number(a3);
      if (!models.includes(m) || !(pct >= 50 && pct <= 100)) { console.error("Usage : cqr compact threshold <fable|opus|sonnet|haiku|default> <50-100>"); process.exit(1); }
      cc.thresholds = Object.assign({}, comp.DEFAULT_THRESHOLDS, cc.thresholds || {}); cc.thresholds[m] = pct;
      writeConf(c); console.log("Seuil " + m + " = " + pct + "% (bascule + compaction quand le compte actif dépasse ce % sur 5h). Redémarrez : cqr restart");
    }
    else if (a1 === "dynamic") {
      // Seuil dynamique (baisse le point de bascule quand le contexte est deja gros). Opt-in :
      // trop agressif avec la compaction active (elle reduit deja la requete). Defaut = off.
      if (a2 === "on") { cc.dynamicThreshold = true; writeConf(c); console.log("Seuil dynamique ACTIVÉ : la bascule peut se déclencher plus tôt que le seuil statique si le contexte est déjà très gros (ex. Opus à ~800k tokens -> ~68%). Redémarrez : cqr restart"); }
      else if (a2 === "off") { cc.dynamicThreshold = false; writeConf(c); console.log("Seuil dynamique désactivé : la bascule utilise le seuil statique par modèle (Opus 89%, etc.). Redémarrez : cqr restart"); }
      else console.error("Usage : cqr compact dynamic on|off");
    }
    else if (a1 === "memory") {
      const mf = p.join(process.cwd(), cc.memoryFile || ".cqr-memory.md");
      if (fs.existsSync(mf)) console.log(fs.readFileSync(mf, "utf8")); else console.log("(pas encore de fichier mémoire dans " + process.cwd() + ")");
    }
    else if (a1 === "status" || !a1) {
      console.log("activée  :", !!cc.enabled);
      console.log("dry-run  :", !!cc.dryRun);
      console.log("mode     :", cc.mode || "native");
      console.log("garde    :", cc.keepToolUses || 10, "résultats d'outils intacts");
      console.log("reprise  :", cc.compactBeforeResume !== false ? "compacte avant de reprendre après une attente" : "désactivé");
      console.log("cooldown :", Math.round((cc.compactionCooldownMs == null ? 600000 : cc.compactionCooldownMs) / 60000) + "min (évite de recompacter à chaque ping-pong une fois les 2 comptes chauds)");
      console.log("seuils   :", JSON.stringify(Object.assign({}, comp.DEFAULT_THRESHOLDS, cc.thresholds || {})), "(% de bascule/compaction par modèle -- cqr compact threshold <modèle> <pct>)");
      console.log("dynamique:", cc.dynamicThreshold ? "ACTIVÉ (peut baisser le seuil si le contexte est déjà gros)" : "désactivé (bascule au seuil statique ci-dessus)", "-- cqr compact dynamic on|off");
      if (cc.dynamicThreshold) console.log("marge    :", (cc.dynamicSafetyBufferPoints == null ? 4 : cc.dynamicSafetyBufferPoints) + " points (marge du seuil dynamique)");
      console.log("mémoire  :", cc.memoryFile || ".cqr-memory.md", "(par projet, max " + (cc.memoryMaxLines || 400) + " lignes)");
    }
    else console.error("Usage : cqr compact [status|on|off|dry-run|mode native|strip|keep <n>|cooldown <min>|threshold <modèle> <pct>|dynamic on|off|buffer <points>|memory]");
    break;
  }
  case "preflight": {
    // Is it safe to launch a big Workflow? Exit 0 if a fresh-enough account exists, else 1.
    const c = readConf(); const s = readState();
    const g = c.workflowGuard || {}; const percent = g.percent == null ? 50 : g.percent;
    lib.accounts(c, s).forEach((a) => console.log("API-" + (a.idx + 1) + " " + a.name + ": 5h " + (a.h5 == null ? "?" : a.h5 + "%") + " (reset " + lib.fmtDur(a.reset5) + ")  |  7j " + (a.d7 == null ? "?" : a.d7 + "%") + " (reset " + lib.fmtDur(a.reset7) + ")"));
    const best = lib.bestHeadroom(c, s);
    const good = best != null && best < percent;
    console.log(good
      ? "\nOK — le compte le plus frais est à " + best + "% < " + percent + "%. Prudent de lancer un workflow."
      : "\nRISQUÉ — le compte le plus frais est à " + (best == null ? "inconnu" : best + "%") + " (il faudrait < " + percent + "%). Préférez travailler en inline ou attendre un reset.");
    process.exit(good ? 0 : 1);
  }
  case "guard": {
    const c = readConf(); c.workflowGuard = Object.assign({ enabled: true, mode: "ask", percent: 50 }, c.workflowGuard || {});
    const wg = c.workflowGuard;
    if (a1 === "on") wg.enabled = true;
    else if (a1 === "off") wg.enabled = false;
    else if (a1 === "ask" || a1 === "deny") { wg.enabled = true; wg.mode = a1; }
    else if (a1 && /^\d+$/.test(a1)) { wg.enabled = true; wg.percent = Number(a1); }
    else if (a1 && a1 !== "status") { console.error("Usage : cqr guard [status|on|off|ask|deny|<pourcentage>]"); process.exit(1); }
    if (a1 && a1 !== "status") writeConf(c);
    console.log("workflowGuard :", JSON.stringify(wg));
    break;
  }
  case "start": health((h) => { if (h) console.log("Déjà en cours."); else startProxyAndVerify((ok) => { if (ok) console.log("Proxy démarré et opérationnel."); else { reportStartFailure(); process.exit(1); } }); }); break;
  case "stop": stopProxy((ok) => console.log(ok === true ? "Proxy arrêté." : ok === "unknown" ? "Le proxy répond mais aucun fichier PID (démarré hors du CLI ?)." : "Aucun proxy en cours.")); break;
  case "restart": stopProxy(() => setTimeout(() => { startProxyAndVerify((ok) => { if (ok) console.log("Proxy redémarré et opérationnel."); else { reportStartFailure(); process.exit(1); } }); }, 800)); break;
  default: console.error("Commande inconnue. Voir l'en-tête de cli.js ou le README."); process.exit(1);
}
