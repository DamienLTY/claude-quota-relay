#!/usr/bin/env node
/*
 * Claude auth failover proxy  (v2 : routage + waiting anti-"continue")
 * ===================================================================
 * Ecoute en local et relaie vers api.anthropic.com en reecrivant le Bearer
 * avec le token choisi. Lit les en-tetes anthropic-ratelimit-unified-* pour :
 *   - preferer un token <switchAtPercent (5h),
 *   - JAMAIS router vers un token >= sevenDayBlockPercent (7j),
 *   - sur 401/429 : marquer le token + rejouer sur un autre,
 *   - si aucun token disponible : RETENIR la requete (hold) jusqu'a ce qu'une
 *     fenetre se reinitialise (le token "qui revient a zero en premier"),
 *     puis forwarder -> Claude croit que le serveur est lent et reprend seul.
 * Aucune dependance externe.
 *
 * Procedures (resumé, detail dans README.md) :
 *   P1 il existe un token frais (<switch, 7j<bloc, non rejeté)        -> route (meilleur)
 *   P2 tous >=switch mais non rejetés, waitAtSoftPercent=null (defaut)-> on utilise la marge jusqu'au rejet
 *   P2'waitAtSoftPercent=N et tous >=N                                -> WAIT reset 5h le plus proche
 *   P3 un/des token(s) rejeté(s), un autre frais éligible            -> route l'autre (rejeu)
 *   P4 tous les éligibles (7j<bloc) rejetés                          -> WAIT reset 5h le plus proche, puis route
 *   P5 cible potentielle a 7j>=bloc                                  -> exclue ; on attend le token éligible
 *   P6 tous les tokens a 7j>=bloc                                    -> WAIT reset 7j le plus proche (plafonné maxWaitMs)
 *   P7 401 (token invalide)                                          -> cooldown court (5min), pas d'attente de plusieurs heures
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const comp = require("./compaction.js");

const DIR = __dirname;
const CONF = path.join(DIR, "tokens.json");
const STATE = path.join(DIR, "state.json");
const LOG = path.join(DIR, "proxy.log");
// Upstream is api.anthropic.com over https. Overridable via env for tests / gateways.
// ponytail: env seam, only touched when CQR_UPSTREAM_* is set; default unchanged.
const UPSTREAM_HOST = process.env.CQR_UPSTREAM_HOST || "api.anthropic.com";
const UPSTREAM_PORT = Number(process.env.CQR_UPSTREAM_PORT) || 443;
const UPSTREAM = process.env.CQR_UPSTREAM_HTTP ? require("http") : https;
const FIVE_H_MS = 5 * 60 * 60 * 1000;
const AUTH_COOLDOWN_MS = 5 * 60 * 1000; // 401 -> petit cooldown
const TRANSIENT_COOLDOWN_MS = 90 * 1000; // 429 sans aucune info de fenetre -> transitoire, pas un epuisement

function ts() { return new Date().toISOString(); }
function now() { return Date.now(); }
function log(...a) {
  const line = `[${ts()}] ${a.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch (e) {}
  try { const st = fs.statSync(LOG); if (st.size > 2_000_000) fs.writeFileSync(LOG, fs.readFileSync(LOG, "utf8").slice(-500_000)); } catch (e) {}
}

function readConf() {
  const c = JSON.parse(fs.readFileSync(CONF, "utf8"));
  c.tokens = Array.isArray(c.tokens) ? c.tokens : [];
  c.port = c.port || 8787;
  c.switchAtPercent = num(c.switchAtPercent, 98);          // 5h : seuil de preference
  c.sevenDayBlockPercent = num(c.sevenDayBlockPercent, 99); // 7j : on ne route jamais au-dela
  c.waitAtSoftPercent = c.waitAtSoftPercent == null ? null : num(c.waitAtSoftPercent, null); // null=utiliser la marge
  c.pollMs = num(c.pollMs, 15000);
  c.maxWaitMs = num(c.maxWaitMs, 6 * 60 * 60 * 1000);       // plafond d'attente d'une requete
  return c;
}
function num(v, d) { const n = Number(v); return isNaN(n) ? d : n; }
function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { return { activeIndex: 0, exhausted: {}, pct: {}, reset5h: {}, reset7d: {} }; } }
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (e) { log("writeState err", e.message); } }
function isPlaceholder(t) { return !t || !t.token || /^(PASTE|REMPLACE|<)/i.test(t.token); }

// Coupure reseau (DNS, connexion refusee/coupee, timeout de connexion) : aucune reponse HTTP
// n'a jamais ete recue d'Anthropic. A distinguer d'un vrai rejet HTTP (429/401/529), qui lui
// arrive avec un statusCode et est gere ailleurs (retry sur autre token / WAIT quota).
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EPIPE", "ECONNABORTED",
]);
function isNetworkError(e) {
  if (e && NETWORK_ERROR_CODES.has(e.code)) return true;
  const msg = String((e && e.message) || "");
  return /socket hang up|network|getaddrinfo|connect ETIMEDOUT/i.test(msg);
}

function parseEpochMs(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!isNaN(n)) return n > 1e12 ? n : n * 1000; // epoch s ou ms
  const d = Date.parse(v);
  return isNaN(d) ? null : d;
}

// ----- selection du token -----
// renvoie {idx} pour router maintenant, ou {wait:true, idx, untilMs, reason}
function pickRoute(conf, state) {
  const t0 = now();
  state.exhausted = state.exhausted || {}; state.reset5h = state.reset5h || {}; state.reset7d = state.reset7d || {}; state.pct = state.pct || {};
  const SW = conf.switchAtPercent, BLOCK = conf.sevenDayBlockPercent, SOFT = conf.waitAtSoftPercent;

  // override manuel (claude-auth use) : on force ce token, sans regle ni attente
  if (state.forceIndex != null) {
    const ft = conf.tokens[state.forceIndex];
    if (ft && ft.enabled && !isPlaceholder(ft)) return { idx: state.forceIndex, forced: true };
  }

  const items = conf.tokens.map((t, i) => {
    const name = t.name;
    const p = state.pct[name] || {};
    const r5 = state.reset5h[name] || null;
    const r7 = state.reset7d[name] || null;
    // fenetre rolled -> utilisation consideree remise a zero
    let u5 = p.h5 == null ? null : p.h5;
    let u7 = p.d7 == null ? null : p.d7;
    if (r5 && t0 >= r5) u5 = 0;
    if (r7 && t0 >= r7) u7 = 0;
    let exUntil = state.exhausted[name] || 0;
    if (exUntil && t0 >= exUntil) exUntil = 0; // expiré -> dispo
    // wake5h : quand ce token redevient utilisable cote 5h
    const wake5h = exUntil ? exUntil : (r5 && (u5 != null && u5 >= (SOFT != null ? SOFT : 101)) ? r5 : null);
    return { t, i, name, u5, u7, exUntil, r5, r7, wake5h, ok: t.enabled && !isPlaceholder(t) };
  }).filter((x) => x.ok);

  if (!items.length) return { none: true };

  const eligible = items.filter((x) => x.u7 == null || x.u7 < BLOCK); // securite 7j

  // fresh = eligible, non rejeté, et (si SOFT) sous le seuil soft 5h
  let fresh = eligible.filter((x) => !x.exUntil);
  if (SOFT != null) fresh = fresh.filter((x) => x.u5 == null || x.u5 < SOFT);

  if (fresh.length) {
    // hysteresis : garder l'actif s'il est encore "bon" (<switch)
    const act = fresh.find((x) => x.i === (state.activeIndex || 0));
    if (act && (act.u5 == null || act.u5 < SW)) return { idx: act.i };
    fresh.sort((a, b) => (a.u5 == null ? -1 : a.u5) - (b.u5 == null ? -1 : b.u5));
    return { idx: fresh[0].i };
  }

  // il faut attendre : cible = eligible dont la fenetre 5h revient en premier
  if (eligible.length) {
    const cand = eligible.map((x) => ({ i: x.i, until: x.wake5h || x.r5 || (t0 + FIVE_H_MS) }));
    cand.sort((a, b) => a.until - b.until);
    return { wait: true, idx: cand[0].i, untilMs: cand[0].until, reason: "5h" };
  }

  // aucun eligible : tous a 7j>=bloc -> attendre le reset 7j le plus proche
  const cand7 = items.map((x) => ({ i: x.i, until: x.r7 || (t0 + 7 * 24 * 3600 * 1000) }));
  cand7.sort((a, b) => a.until - b.until);
  return { wait: true, idx: cand7[0].i, untilMs: cand7[0].until, reason: "7d", weekly: true };
}

// ----- sonde de quota quasi gratuite -----
// Requete max_tokens:0 sur haiku : ~8 tokens d'input, 0 output, mais renvoie
// tous les en-tetes anthropic-ratelimit-unified-*. Sert de "half-open" du
// circuit breaker : verifier l'etat REEL d'un token sans lacher une vraie requete.
const PROBE_BODY = JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 0, messages: [{ role: "user", content: "ping" }] });
const PROBE_REFRESH_MS = 5 * 60 * 1000; // au plus une sonde / 5 min / token
const lastProbeAt = {};

function probeToken(conf, idx, done) {
  const tok = conf.tokens[idx];
  if (!tok || isPlaceholder(tok)) { if (done) done(false); return; }
  lastProbeAt[tok.name] = now();
  const req = UPSTREAM.request({
    hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: "/v1/messages", method: "POST",
    headers: {
      "authorization": "Bearer " + tok.token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(PROBE_BODY),
    },
  }, (pres) => {
    pres.resume();
    const q = readQuotaHeaders(pres.headers);
    const st = readState();
    if (q.max != null) { st.pct = st.pct || {}; st.pct[tok.name] = { max: q.max, h5: q.u5h, d7: q.u7d, at: ts() }; }
    if (q.r5) { st.reset5h = st.reset5h || {}; st.reset5h[tok.name] = q.r5; }
    if (q.r7) { st.reset7d = st.reset7d || {}; st.reset7d[tok.name] = q.r7; }
    st.exhausted = st.exhausted || {};
    const allowed = pres.statusCode === 200 && q.statuses.indexOf("rejected") < 0;
    if (allowed) {
      if (st.exhausted[tok.name]) { delete st.exhausted[tok.name]; log("PROBE", tok.name, "OK -> deblocage anticipe (5h=" + q.u5h + "% 7j=" + q.u7d + "%)"); }
      else log("PROBE", tok.name, "5h=" + q.u5h + "% 7j=" + q.u7d + "%");
    } else if (pres.statusCode === 429) {
      const until = q.retryAfterMs || q.r5 || (now() + TRANSIENT_COOLDOWN_MS);
      st.exhausted[tok.name] = until;
      log("PROBE", tok.name, "encore bloque -> cooldown jusqu'a", new Date(until).toISOString());
    } else {
      log("PROBE", tok.name, "http" + pres.statusCode);
    }
    writeState(st);
    if (done) done(allowed);
  });
  req.setTimeout(10000, () => { try { req.destroy(new Error("probe timeout")); } catch (e) {} });
  req.on("error", (e) => { log("PROBE err", tok.name, e.message); if (done) done(false); });
  req.write(PROBE_BODY);
  req.end();
}

function readQuotaHeaders(headers) {
  const u5 = Number(headers["anthropic-ratelimit-unified-5h-utilization"]);
  const u7 = Number(headers["anthropic-ratelimit-unified-7d-utilization"]);
  const ug = Number(headers["anthropic-ratelimit-unified-utilization"]);
  const utils = [u5, u7, ug].filter((x) => !isNaN(x));
  return {
    statuses: [headers["anthropic-ratelimit-unified-status"], headers["anthropic-ratelimit-unified-5h-status"], headers["anthropic-ratelimit-unified-7d-status"]]
      .filter(Boolean).map((s) => String(s).toLowerCase()),
    u5h: isNaN(u5) ? null : Math.round(u5 * 100),
    u7d: isNaN(u7) ? null : Math.round(u7 * 100),
    max: utils.length ? Math.round(Math.max.apply(null, utils) * 100) : null,
    r5: parseEpochMs(headers["anthropic-ratelimit-unified-5h-reset"]),
    r7: parseEpochMs(headers["anthropic-ratelimit-unified-7d-reset"]),
    retryAfterMs: (() => { const ra = Number(headers["retry-after"]); return isNaN(ra) ? null : now() + ra * 1000; })(),
  };
}
function logRate(headers, statusCode, name) {
  const rl = {}; for (const k of Object.keys(headers)) if (/^anthropic-ratelimit/i.test(k) || k === "retry-after") rl[k] = headers[k];
  if (Object.keys(rl).length || statusCode >= 400) log("RESP", statusCode, "token=" + name, "rl=", rl);
}

// ----- decision d'auto-compaction -----
// Compacte la requete sortante quand on bascule vers un autre compte parce que le
// compte quitte a atteint son seuil (par modele), OU quand on relache une requete
// apres une attente de quota. Ne fait rien si compaction desactivee.
function decideCompaction(conf, state, bodyObj, prevActive, newIdx, ctx, switching) {
  const cc = conf.compaction || {};
  if (!cc.enabled && !cc.dryRun) return null;
  // only compact requests that actually carry a conversation (not count_tokens, etc.)
  if (!bodyObj || !Array.isArray(bodyObj.messages) || !bodyObj.messages.length) return null;
  const model = bodyObj && bodyObj.model;
  const thr = comp.modelThreshold(model, cc.thresholds);
  const prevName = (conf.tokens[prevActive] || {}).name;
  const prevU5 = prevName && state.pct && state.pct[prevName] ? state.pct[prevName].h5 : null;
  let compact = false, reason = "";
  if (ctx.resumed) { compact = true; reason = "resume"; ctx.resumed = false; }
  else if (switching && prevU5 != null && prevU5 >= thr) { compact = true; reason = "switch@" + prevU5 + ">=" + thr + "%"; }
  if (!compact) return null;
  // Cooldown : une fois tous les comptes au-dessus de leur seuil, pickRoute (a raison, pour
  // le failover) continue d'alterner sur celui qui a le u5 le plus bas -> sans ce garde-fou on
  // recompacterait (et rappellerait Haiku) a CHAQUE requete. Le cooldown lisse ce ping-pong :
  // on ne recompacte pas plus souvent que compactionCooldownMs, quel que soit le nombre de
  // bascules entre-temps. Applique aussi en dry-run pour que les logs reproduisent fidelement
  // ce qui se passerait une fois active.
  const cooldownMs = num(cc.compactionCooldownMs, 600000);
  const last = state.lastCompactAt || 0;
  if (cooldownMs > 0 && now() - last < cooldownMs) return null;
  return { compact: true, reason, dryRun: !cc.enabled && !!cc.dryRun, mode: cc.mode === "strip" ? "strip" : "native", keepToolUses: num(cc.keepToolUses, 10), triggerTokens: num(cc.triggerTokens, 2000) };
}

// ----- coeur : route puis (forward | wait->forward), avec rejeu sur rejet -----
function serve(creq, cres) {
  if (creq.url === "/__proxy_health") {
    cres.writeHead(200, { "content-type": "application/json" });
    cres.end(JSON.stringify({ ok: true, ts: ts(), state: readState() }));
    return;
  }
  const chunks = [];
  let clientGone = false;
  const reqStart = now();
  creq.on("data", (c) => chunks.push(c));
  creq.on("error", (e) => { clientGone = true; log("CLIENT error", e.message, "elapsedMs=" + (now() - reqStart)); });
  creq.on("aborted", () => { clientGone = true; log("CLIENT aborted", "elapsedMs=" + (now() - reqStart)); });
  cres.on("close", () => { if (!cres.writableFinished) { clientGone = true; log("CLIENT close (writableFinished=false)", "elapsedMs=" + (now() - reqStart)); } });
  creq.on("end", () => {
    const body = Buffer.concat(chunks);
    let bodyObj = null;
    try { bodyObj = JSON.parse(body.toString("utf8")); } catch (e) {}
    const isStream = !!(bodyObj && bodyObj.stream === true);
    const ctx = { tried: new Set(), waitStart: 0, polls: 0, sse: false, ka: null, netRetries: 0, resumed: false };
    function stopKeepalive() { if (ctx.ka) { clearInterval(ctx.ka); ctx.ka = null; } }
    function sseError(msg) {
      try {
        cres.write("event: error\ndata: " + JSON.stringify({ type: "error", error: { type: "overloaded_error", message: msg } }) + "\n\n");
        cres.end();
      } catch (e) {}
    }
    attempt();

    function attempt() {
      if (clientGone) return;
      let conf, state;
      try { conf = readConf(); state = readState(); }
      catch (e) { try { cres.writeHead(500); cres.end("proxy: conf illisible: " + e.message); } catch (x) {} return; }

      const route = pickRoute(conf, state);
      if (route.none) { try { cres.writeHead(502); cres.end("proxy: aucun token configuré"); } catch (x) {} return; }

      if (route.wait) return enterWait(conf, state, route);

      // route immediate
      const prevActive = state.activeIndex || 0;
      const switching = prevActive !== route.idx;
      if (state.waiting) { delete state.waiting; }
      if (switching) { state.activeIndex = route.idx; }
      // decide compaction BEFORE overwriting the "previous account" utilization view.
      // Only for the real /v1/messages endpoint (never count_tokens or other JSON paths).
      const isMsgs = String(creq.url || "").split("?")[0] === "/v1/messages";
      const compactInfo = isMsgs ? decideCompaction(conf, state, bodyObj, prevActive, route.idx, ctx, switching) : null;
      if (compactInfo && compactInfo.compact) {
        // toujours tamponne (reel ou dry-run) : c'est ce que le cooldown de decideCompaction lit
        // pour eviter de recompacter a chaque requete pendant un ping-pong entre comptes chauds.
        state.lastCompactAt = now();
        if (!compactInfo.dryRun) {
          state.compaction = { at: now(), from: (conf.tokens[prevActive] || {}).name, to: (conf.tokens[route.idx] || {}).name, model: bodyObj && bodyObj.model, reason: compactInfo.reason };
        }
      }
      writeState(state);
      stopKeepalive();
      // forced (pin manuel) -> pas de failover/attente, on rend le resultat brut
      forward(conf, route.idx, route.forced === true, compactInfo);
    }

    function enterWait(conf, state, route) {
      if (!ctx.waitStart) ctx.waitStart = now();
      // non-stream : pas de keepalive applicatif possible, mais le TCP keepalive (setKeepAlive
      // plus bas) couvre le risque NAT/firewall ; le client tolere un hold jusqu'a API_TIMEOUT_MS
      // (meme plafond que le stream), donc meme capMs pour les deux.
      const deadline = ctx.waitStart + conf.maxWaitMs;
      if (now() >= deadline) {
        // plafond atteint : on forwarde quand meme pour rendre l'erreur reelle au client
        log("WAIT giveup maxWaitMs token=" + conf.tokens[route.idx].name);
        if (state.waiting) { delete state.waiting; writeState(state); }
        return forward(conf, route.idx, true);
      }
      const tName = conf.tokens[route.idx].name;
      const untilISO = new Date(route.untilMs).toISOString();
      state.waiting = { since: new Date(ctx.waitStart).toISOString(), until: untilISO, reason: route.reason, target: tName, polls: ctx.polls };
      writeState(state);
      if (ctx.polls === 0) log("WAIT", route.reason, "jusqu'a", untilISO, "(token", tName + ") - hold de la requete" + (isStream ? " (keepalive SSE)" : ""));
      ctx.polls++;
      // streaming : on garde la connexion vivante par des commentaires SSE (sinon Claude coupe ~5min)
      if (isStream) {
        if (!ctx.sse) {
          ctx.sse = true;
          try {
            cres.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" });
            cres.write(": claude-auth-proxy: attente de quota, reprise automatique\n\n");
          } catch (e) {}
        }
        if (!ctx.ka) ctx.ka = setInterval(() => {
          if (clientGone) { stopKeepalive(); return; }
          try { cres.write(": keepalive\n\n"); } catch (e) {}
        }, 20000);
      }
      // dort jusqu'au reset (borné par pollMs pour re-évaluer / detecter un override manuel)
      // jitter aleatoire : plusieurs requetes retenues ne doivent pas repartir au meme instant (rafale -> 429)
      const jitter = 1500 + Math.floor(Math.random() * 3000);
      const sleep = Math.max(1000, Math.min(conf.pollMs, route.untilMs - now() + jitter));
      setTimeout(() => {
        ctx.tried.clear();
        if (clientGone) { stopKeepalive(); return; }
        // half-open : au reveil (reset atteint) ou toutes les 5 min, sonder le token
        // cible (8 tokens haiku) pour verifier/corriger l'etat AVANT de relacher la requete
        const wakeReached = now() >= route.untilMs;
        // reprise apres attente de quota -> on compacte la requete qu'on relache
        if (wakeReached && conf.compaction && (conf.compaction.enabled || conf.compaction.dryRun) && conf.compaction.compactBeforeResume !== false) ctx.resumed = true;
        const probeDue = wakeReached || (now() - (lastProbeAt[tName] || 0)) >= PROBE_REFRESH_MS;
        if (probeDue) probeToken(conf, route.idx, () => { if (!clientGone) attempt(); });
        else attempt();
      }, sleep);
    }

    function forward(conf, idx, lastResort, compactInfo) {
      if (clientGone) return;
      const state = readState();
      const tok = conf.tokens[idx];
      if (!tok || isPlaceholder(tok)) { try { cres.writeHead(502); cres.end("proxy: token cible invalide"); } catch (x) {} return; }
      ctx.tried.add(tok.name);

      const headers = Object.assign({}, creq.headers);
      headers["host"] = UPSTREAM_HOST;
      headers["authorization"] = "Bearer " + tok.token;
      delete headers["x-api-key"];
      // we always send with an explicit content-length -> drop any chunked encoding from the client
      delete headers["transfer-encoding"];

      // --- auto-compaction : reduit les tokens envoyes au compte cible (0 token) ---
      let sendBody = body;
      if (compactInfo && compactInfo.compact && bodyObj) {
        if (compactInfo.dryRun) {
          log("COMPACT dry-run", compactInfo.reason, "model=" + (bodyObj.model || "?"), "token=" + tok.name, "(aucune modif)");
        } else {
          try {
            const clone = JSON.parse(JSON.stringify(bodyObj));
            if (compactInfo.mode === "strip") {
              const r = comp.stripOldToolResults(clone, compactInfo.keepToolUses);
              sendBody = Buffer.from(JSON.stringify(r.body));
              log("COMPACT strip", compactInfo.reason, "stubbed=" + r.stubbed, "token=" + tok.name);
            } else {
              const r = comp.injectNative(clone, compactInfo.keepToolUses, compactInfo.triggerTokens);
              comp.mergeBeta(headers);
              sendBody = Buffer.from(JSON.stringify(r.body));
              log("COMPACT native", compactInfo.reason, r.added ? "clear_tool_uses(keep " + compactInfo.keepToolUses + ")" : "deja present", "token=" + tok.name);
            }
          } catch (e) { log("COMPACT err", e.message, "-> body inchange"); sendBody = body; }
        }
      }

      if (sendBody.length) headers["content-length"] = Buffer.byteLength(sendBody);
      // en mode keepalive SSE on a deja envoye nos en-tetes sans content-encoding :
      // on force une reponse upstream non compressee pour pouvoir la relayer telle quelle
      if (ctx.sse) delete headers["accept-encoding"];

      const preq = UPSTREAM.request({ hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: creq.url, method: creq.method, headers }, (pres) => {
        ctx.netRetries = 0; // une reponse (meme un rejet HTTP) prouve que le reseau fonctionne
        logRate(pres.headers, pres.statusCode, tok.name);
        const q = readQuotaHeaders(pres.headers);
        const st = readState();
        if (q.max != null) { st.pct = st.pct || {}; st.pct[tok.name] = { max: q.max, h5: q.u5h, d7: q.u7d, at: ts() }; }
        if (q.r5) { st.reset5h = st.reset5h || {}; st.reset5h[tok.name] = q.r5; }
        if (q.r7) { st.reset7d = st.reset7d || {}; st.reset7d[tok.name] = q.r7; }

        const rejected = pres.statusCode === 429 || q.statuses.indexOf("rejected") >= 0;
        const authFail = pres.statusCode === 401 || pres.statusCode === 403;
        const overloaded = pres.statusCode === 529; // serveur Anthropic surcharge : rien a voir avec le quota

        if ((rejected || authFail || overloaded) && !lastResort) {
          // 429 SANS retry-after NI reset 5h = transitoire (surcharge, requete trop grosse...)
          // -> cooldown court, surtout pas 5h (sinon on bloque un compte encore frais)
          const transient = overloaded || (!authFail && q.retryAfterMs == null && q.r5 == null);
          const until = authFail ? now() + AUTH_COOLDOWN_MS
            : transient ? now() + TRANSIENT_COOLDOWN_MS
            : (q.retryAfterMs || q.r5);
          st.exhausted = st.exhausted || {}; st.exhausted[tok.name] = until;
          writeState(st);
          log(authFail ? "AUTHFAIL" : overloaded ? "OVERLOADED(529)" : (transient ? "REJECTED(transitoire)" : "REJECTED"), tok.name, "http" + pres.statusCode, "-> cooldown jusqu'a", new Date(until).toISOString());
          pres.resume(); // draine
          // re-pick (un autre token frais, sinon WAIT)
          return attempt();
        }

        writeState(st);
        stopKeepalive();
        if (ctx.sse) {
          // flux SSE deja ouvert (keepalive) : on relaie seulement le corps si succes
          if (pres.statusCode >= 200 && pres.statusCode < 300) {
            pres.pipe(cres);
          } else {
            pres.resume();
            sseError("limite atteinte (http " + pres.statusCode + ")");
          }
        } else {
          if (!cres.headersSent) cres.writeHead(pres.statusCode, pres.headers);
          pres.pipe(cres);
        }
      });
      preq.on("error", (e) => {
        // coupure reseau (pas de reponse Anthropic recue) vs vrai rejet HTTP : deux choses
        // differentes. Un rejet HTTP (429/401/529) est deja gere dans le callback pres ci-dessus.
        // Ici, aucune reponse n'est jamais arrivee -> DNS/connexion coupee (coupure internet,
        // wifi qui tombe, VPN qui reconnecte...). Avant, on abandonnait tout de suite (502 au
        // client) : une coupure de quelques minutes suffisait a faire echouer la requete alors
        // que le client (API_TIMEOUT_MS tres large) aurait pu patienter. Meme logique que le
        // hold quota : on retente avec backoff tant que le budget maxWaitMs n'est pas depasse.
        if (isNetworkError(e) && !clientGone && (now() - reqStart) < conf.maxWaitMs) {
          ctx.netRetries = (ctx.netRetries || 0) + 1;
          const delay = Math.min(30000, 2000 * Math.pow(2, ctx.netRetries - 1));
          log("NETWORK err", e.message, "token=" + tok.name, "retry #" + ctx.netRetries, "in", Math.round(delay / 1000) + "s");
          if (isStream && !ctx.sse) {
            ctx.sse = true;
            try {
              cres.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" });
              cres.write(": claude-auth-proxy: coupure reseau detectee, nouvelle tentative automatique\n\n");
            } catch (x) {}
          }
          if (!ctx.ka && ctx.sse) ctx.ka = setInterval(() => {
            if (clientGone) { stopKeepalive(); return; }
            try { cres.write(": keepalive\n\n"); } catch (x) {}
          }, 20000);
          setTimeout(() => { if (!clientGone) forward(conf, idx, lastResort, compactInfo); }, delay);
          return;
        }
        log("UPSTREAM err", e.message, "token=" + tok.name, ctx.netRetries ? ("apres " + ctx.netRetries + " tentatives") : "");
        stopKeepalive();
        if (ctx.sse) { sseError("erreur upstream: " + e.message); return; }
        if (!cres.headersSent) { try { cres.writeHead(502, { "content-type": "text/plain" }); } catch (x) {} }
        try { cres.end("proxy: erreur upstream: " + e.message); } catch (x) {}
      });
      if (sendBody.length) preq.write(sendBody);
      preq.end();
    }
  });
}

// Pure decision helpers are exported for tests; the server only boots when run directly.
module.exports = { pickRoute, decideCompaction, readQuotaHeaders };

if (require.main === module) {
  const conf0 = readConf();
  const server = http.createServer(serve);
  // pas de timeout : on doit pouvoir retenir une requete longtemps
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 75_000;
  server.on("connection", (s) => { try { s.setKeepAlive(true, 30_000); } catch (e) {} });
  server.on("error", (e) => { log("SERVER err", e.message); process.exit(1); });
  // PID file : permet un arret portable (sans netstat/taskkill/lsof) depuis le CLI.
  const PIDFILE = path.join(DIR, "proxy.pid");
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch (e) {}
  function cleanupPid() { try { if (fs.readFileSync(PIDFILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PIDFILE); } catch (e) {} }
  process.on("exit", cleanupPid);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  server.listen(conf0.port, "127.0.0.1", () => {
    log("PROXY v3 up http://127.0.0.1:" + conf0.port,
      "switch=" + conf0.switchAtPercent + "% bloc7j=" + conf0.sevenDayBlockPercent + "% softWait=" + conf0.waitAtSoftPercent + " maxWait=" + Math.round(conf0.maxWaitMs / 60000) + "min",
      "tokens=" + conf0.tokens.map((t) => t.name + (isPlaceholder(t) ? "(vide)" : "")).join(","));
    // sonde de demarrage : etat reel des quotas sans attendre la 1re vraie reponse
    conf0.tokens.forEach((t, i) => {
      if (t.enabled && !isPlaceholder(t)) setTimeout(() => probeToken(conf0, i), 500 + i * 2000);
    });
  });
}
