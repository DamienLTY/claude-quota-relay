#!/usr/bin/env node
/* claude-quota-relay CLI (`cqr`) — pilote le proxy de failover de tokens.
 *
 * Usage:
 *   cqr status                 etat des tokens + quota vu + attente en cours
 *   cqr list                   liste les tokens (masques)
 *   cqr use <nom|index>        EPINGLE le token actif (effet immediat, ignore regles+attente)
 *   cqr auto                   revient au mode automatique (failover + waiting)
 *   cqr reset                  oublie l'etat "epuise" (re-essaie tous les tokens)
 *   cqr set <nom> <token>      renseigne/ecrase le token d'un compte
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
function mask(tok) { return isPlaceholder({ token: tok }) ? "(empty)" : tok.slice(0, 14) + "..." + tok.slice(-4); }

function health(cb) {
  let c; try { c = readConf(); } catch (e) { return cb(null); }
  const req = http.get("http://127.0.0.1:" + (c.port || 8787) + "/__proxy_health", (r) => {
    let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => { try { cb(JSON.parse(d)); } catch (e) { cb(null); } });
  });
  req.on("error", () => cb(null));
  req.setTimeout(1500, () => { req.destroy(); cb(null); });
}

function startProxy() {
  const out = fs.openSync(p.join(DIR, "proxy.out.log"), "a");
  const child = cp.spawn(process.execPath, [PROXY], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
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

const [cmd, a1, a2] = process.argv.slice(2);

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
  const d = ms - Date.now(); if (d <= 0) return "now";
  const m = Math.round(d / 60000);
  return m >= 60 ? Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") : m + "min";
}
function showStatus() {
  let c, s;
  try { c = readConf(); } catch (e) { console.error("No tokens.json in " + DIR + " — run the installer first."); process.exit(1); }
  s = readState();
  const soft = c.waitAtSoftPercent == null ? "off (use the 90-100% margin before waiting)" : c.waitAtSoftPercent + "%";
  health((h) => {
    console.log("Proxy      :", h ? "RUNNING (port " + (c.port || 8787) + ")" : "STOPPED");
    console.log("Policy     : switch5h=" + (c.switchAtPercent || 94) + "%  block7d=" + (c.sevenDayBlockPercent || 99) + "%  waitSoft=" + soft + "  maxWait=" + Math.round((c.maxWaitMs || 604800000) / 60000) + "min");
    const pin = s.forceIndex != null && c.tokens[s.forceIndex] ? " [PINNED: " + c.tokens[s.forceIndex].name + "]" : "";
    console.log("Active     :", ((c.tokens[s.activeIndex] && c.tokens[s.activeIndex].name) || "?") + pin);
    if (s.waiting) console.log("WAITING    : " + s.waiting.reason + " -> '" + s.waiting.target + "' resumes in ~" + eta(Date.parse(s.waiting.until)));
    console.log("");
    c.tokens.forEach((t, i) => {
      const act = i === s.activeIndex ? ">" : " ";
      const ex = s.exhausted && s.exhausted[t.name] && Date.now() < s.exhausted[t.name];
      const exTxt = ex ? " [blocked, free in ~" + eta(s.exhausted[t.name]) + "]" : "";
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
    if (idx < 0 || idx >= c.tokens.length) { console.error("Token not found:", a1); process.exit(1); }
    s.activeIndex = idx; s.forceIndex = idx;
    if (s.exhausted) delete s.exhausted[c.tokens[idx].name];
    writeState(s);
    console.log("PINNED -> " + c.tokens[idx].name + " (forced, effective immediately). Run `cqr auto` to return to automatic mode.");
    break;
  }
  case "login": case "add": {
    // login <name|index> : (re)capture a token for an existing account via `claude setup-token`.
    // add [name]         : capture a token for a NEW account and append it.
    (async () => {
      const c = readConf();
      const tok = await lib.captureSetupToken();
      if (!tok) { console.error("\nNo token captured."); process.exit(1); }
      let name;
      if (cmd === "add") {
        name = a1 || ("account-" + (c.tokens.length + 1));
        let t = c.tokens.find((x) => x.name === name);
        if (t) { t.token = tok; t.enabled = true; } else c.tokens.push({ name, token: tok, enabled: true });
      } else {
        let idx = c.tokens.findIndex((t) => t.name === a1);
        if (idx < 0 && /^\d+$/.test(a1 || "")) idx = Number(a1);
        if (idx < 0) idx = 0;
        if (!c.tokens[idx]) { console.error("Account not found:", a1); process.exit(1); }
        c.tokens[idx].token = tok; c.tokens[idx].enabled = true; name = c.tokens[idx].name;
      }
      writeConf(c);
      const synced = lib.syncAuthToken(c, SETTINGS);
      console.log("\n✓ token saved for '" + name + "' (" + mask(tok) + ")" + (synced ? " and synced into settings.json" : "") + ".");
      console.log("Run `cqr restart` then restart Claude Code for it to take effect.");
      process.exit(0);
    })();
    break;
  }
  case "sync-env": {
    const c = readConf();
    const okk = lib.syncAuthToken(c, SETTINGS);
    console.log(okk ? "Synced first token into settings.json (ANTHROPIC_AUTH_TOKEN)." : "No usable token or no settings.json found.");
    break;
  }
  case "auto": { const s = readState(); delete s.forceIndex; writeState(s); console.log("Automatic mode re-enabled (failover + waiting per policy)."); break; }
  case "reset": { const s = readState(); s.exhausted = {}; writeState(s); console.log("'exhausted' state cleared."); break; }
  case "set": {
    if (!a1 || !a2) { console.error("Usage: cqr set <name> <token>"); process.exit(1); }
    const c = readConf(); let t = c.tokens.find((x) => x.name === a1);
    if (!t) { t = { name: a1, token: a2, enabled: true }; c.tokens.push(t); } else { t.token = a2; t.enabled = true; }
    writeConf(c); console.log("Token '" + a1 + "' saved (" + mask(a2) + ").");
    break;
  }
  case "policy": {
    const c = readConf();
    if (!a1) {
      console.log("switch5h :", (c.switchAtPercent || 94) + "%   (prefer a token below this 5h %)");
      console.log("block7d  :", (c.sevenDayBlockPercent || 99) + "%   (never route to a token above this 7d %)");
      console.log("waitSoft :", c.waitAtSoftPercent == null ? "off" : c.waitAtSoftPercent + "%", "  (off = consume the 90-100% margin before waiting)");
      console.log("maxWait  :", Math.round((c.maxWaitMs || 604800000) / 60000) + "min", "  (cap on how long a request is held)");
      console.log("");
      console.log("Change   : cqr policy <switch|block7d|waitsoft|maxwait> <value>   (waitsoft off|<N>, maxwait <minutes>)");
      break;
    }
    const v = a2;
    if (a1 === "switch") c.switchAtPercent = Number(v);
    else if (a1 === "block7d") c.sevenDayBlockPercent = Number(v);
    else if (a1 === "waitsoft") c.waitAtSoftPercent = (v === "off" || v === "null") ? null : Number(v);
    else if (a1 === "maxwait") c.maxWaitMs = Number(v) * 60000;
    else { console.error("Unknown key:", a1); process.exit(1); }
    writeConf(c); console.log("Policy updated:", a1, "=", v);
    break;
  }
  case "compact": {
    const c = readConf(); c.compaction = c.compaction || {};
    const cc = c.compaction;
    if (a1 === "on") { cc.enabled = true; cc.dryRun = false; writeConf(c); console.log("Compaction ON (native clear_tool_uses + per-project memory). Restart the proxy: cqr restart"); }
    else if (a1 === "off") { cc.enabled = false; cc.dryRun = false; writeConf(c); console.log("Compaction OFF."); }
    else if (a1 === "dry-run" || a1 === "dryrun") { cc.enabled = false; cc.dryRun = true; writeConf(c); console.log("Compaction DRY-RUN: proxy only LOGS what it would compact (no request change); memory still builds. Watch: proxy.log"); }
    else if (a1 === "mode") { cc.mode = a2 === "strip" ? "strip" : "native"; writeConf(c); console.log("Compaction mode = " + cc.mode + (cc.mode === "strip" ? " (proxy stubs old tool results; use if Claude Code chokes on native)" : " (Anthropic context-editing, 0 token)")); }
    else if (a1 === "keep") { cc.keepToolUses = Number(a2) || 10; writeConf(c); console.log("Keep last " + cc.keepToolUses + " tool results raw."); }
    else if (a1 === "cooldown") { cc.compactionCooldownMs = Math.max(0, Number(a2) || 0) * 60000; writeConf(c); console.log("Compaction cooldown = " + (a2 || 0) + "min."); }
    else if (a1 === "memory") {
      const mf = p.join(process.cwd(), cc.memoryFile || ".cqr-memory.md");
      if (fs.existsSync(mf)) console.log(fs.readFileSync(mf, "utf8")); else console.log("(no memory file yet in " + process.cwd() + ")");
    }
    else if (a1 === "status" || !a1) {
      console.log("enabled  :", !!cc.enabled);
      console.log("dryRun   :", !!cc.dryRun);
      console.log("mode     :", cc.mode || "native");
      console.log("keep     :", cc.keepToolUses || 10, "tool results");
      console.log("resume   :", cc.compactBeforeResume !== false ? "compact before resuming after a wait" : "off");
      console.log("cooldown :", Math.round((cc.compactionCooldownMs == null ? 600000 : cc.compactionCooldownMs) / 60000) + "min (prevents recompacting on every account ping-pong once both are hot)");
      console.log("thresholds:", JSON.stringify(Object.assign({}, comp.DEFAULT_THRESHOLDS, cc.thresholds || {})));
      console.log("memory   :", cc.memoryFile || ".cqr-memory.md", "(per project, max " + (cc.memoryMaxLines || 400) + " lines)");
    }
    else console.error("Usage: cqr compact [status|on|off|dry-run|mode native|strip|keep <n>|cooldown <min>|memory]");
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
      ? "\nOK — freshest account " + best + "% < " + percent + "%. Safe to fan out a workflow."
      : "\nRISKY — freshest account " + (best == null ? "unknown" : best + "%") + " (need < " + percent + "%). Prefer inline work or wait for a reset.");
    process.exit(good ? 0 : 1);
  }
  case "guard": {
    const c = readConf(); c.workflowGuard = Object.assign({ enabled: true, mode: "ask", percent: 50 }, c.workflowGuard || {});
    const wg = c.workflowGuard;
    if (a1 === "on") wg.enabled = true;
    else if (a1 === "off") wg.enabled = false;
    else if (a1 === "ask" || a1 === "deny") { wg.enabled = true; wg.mode = a1; }
    else if (a1 && /^\d+$/.test(a1)) { wg.enabled = true; wg.percent = Number(a1); }
    else if (a1 && a1 !== "status") { console.error("Usage: cqr guard [status|on|off|ask|deny|<percent>]"); process.exit(1); }
    if (a1 && a1 !== "status") writeConf(c);
    console.log("workflowGuard:", JSON.stringify(wg));
    break;
  }
  case "start": health((h) => { if (h) console.log("Already running."); else { startProxy(); console.log("Proxy started."); } }); break;
  case "stop": stopProxy((ok) => console.log(ok === true ? "Proxy stopped." : ok === "unknown" ? "Proxy responds but no PID file (started outside the CLI?)." : "No proxy running.")); break;
  case "restart": stopProxy(() => setTimeout(() => { startProxy(); console.log("Proxy restarted."); }, 800)); break;
  default: console.error("Unknown command. See the header of cli.js or the README."); process.exit(1);
}
