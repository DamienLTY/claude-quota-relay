// Essai de bout en bout du compactage anticipe avec le VRAI code (hors `npm test`) : a rejouer apres une mise a jour de Claude Code (DR-980, R1).
// Montage : copie de src/ (proxy.js + anticipe.js...) dans un dossier d'essai, port libre, chainee sur le relais du poste (8787) comme AMONT seulement
// (il n'est ni modifie, ni arrete, ni redemarre) ; profil Claude jetable (CLAUDE_CONFIG_DIR) ; vraies sessions `claude -p` Haiku, tout en windowsHide.
// Scenarios : S1 (sous-agent de fond : ANTICIPE gonfle puis compactage auto), S0p (aucun sous-agent : rien), S3 (agent lance, notification recue
// avant la fin de tour : rien). Oracle : hook Stop qui compte les background_tasks de type subagent ; le `agents=` du relais doit lui etre egal.
// Usage : node test/manuel/essai-anticipe.js [dossier-de-sortie] [S1,S0p,S3]
// Ratio 0,05 : le declenchement tombe sur le contexte reel de l'essai (~30 k) ; le module accepte tout ratio de la configuration (0,5-0,99 = bornes de la CLI seulement).
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");

const SRC = path.join(__dirname, "..", "..", "src");
const OUT = path.resolve(process.argv[2] || path.join(process.env.TEMP || os.tmpdir(), "essai-compactage-anticipe", "bout-en-bout"));
const QUELS = (process.argv[3] || "S1,S0p,S3").split(",");
const AMONT_PORT = Number(process.env.CQR_ESSAI_AMONT_PORT) || 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok, ko) => { const s = net.createServer(); s.on("error", ko); s.listen(0, "127.0.0.1", () => { const n = s.address().port; s.close(() => ok(n)); }); });
const tuer = (pid) => { try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch (e) { /* deja parti */ } }; // par PID lance ici, jamais par nom
const lire = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return ""; } };

const PROMPTS = {
  S1: "Lance avec l outil Agent (subagent_type general-purpose, run_in_background true), un sous-agent qui execute `sleep 45` avec Bash puis repond FINI. N'attends pas : termine ton tour tout de suite.",
  S0p: "Reponds seulement OK.",
  S3: "Lance avec l outil Agent (subagent_type general-purpose, run_in_background true), un sous-agent qui repond FINI tout de suite. Puis attends sa fin en executant au premier plan, avec Bash, `node -e \"setTimeout(()=>{},30000)\"`. Quand c'est fait, reponds seulement TERMINE.",
};

async function scenario(nom) {
  const dir = path.join(OUT, nom); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const relais = path.join(dir, "relais"), profil = path.join(dir, "profil"), projet = path.join(dir, "projet");
  for (const d of [relais, profil, projet]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["proxy.js", "compaction.js", "lib.js", "anticipe.js", "sonde-sse.js"]) fs.copyFileSync(path.join(SRC, f), path.join(relais, f));
  const port = await freePort();
  fs.writeFileSync(path.join(relais, "tokens.json"), JSON.stringify({ port, switchAtPercent: 94, sevenDayBlockPercent: 99, maxWaitMs: 600000, pollMs: 15000, livePollMs: 0,
    compaction: { enabled: false, anticipe: { enabled: true, ratio: 0.05, fenetres: { "claude-haiku-5-5": 333000 } } },
    tokens: [{ name: "essai", token: "sk-ant-oat01-ESSAI-FACTICE-remplace-par-8787-0000", enabled: true }] })); // 8787 remplace ce jeton
  fs.writeFileSync(path.join(relais, "state.json"), JSON.stringify({ activeIndex: 0, pct: {}, exhausted: {}, reset5h: {}, reset7d: {} }));
  const oracle = path.join(dir, "stop-oracle.js"), stopLog = path.join(dir, "stop.log");
  fs.writeFileSync(oracle, 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let n=-1;try{const j=JSON.parse(s);n=(j.background_tasks||[]).filter(t=>t&&t.type==="subagent"&&(!t.status||t.status==="running")).length;}catch(e){}require("fs").appendFileSync(' + JSON.stringify(stopLog) + ',new Date().toISOString()+" STOP subagent="+n+"\\n");});\n');
  fs.writeFileSync(path.join(profil, "settings.json"), JSON.stringify({
    modelSettings: { "claude-haiku-5-5": { autoCompactWindow: 333000 } }, // meme source et meme valeur que le poste
    hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "' + oracle.split(path.sep).join("/") + '"' }] }] },
  }, null, 2));

  const env = Object.assign({}, process.env, { CQR_UPSTREAM_HOST: "127.0.0.1", CQR_UPSTREAM_PORT: String(AMONT_PORT), CQR_UPSTREAM_HTTP: "1", CQR_SONDE: "0", CQR_NO_POPUP: "1" });
  const rel = spawn(process.execPath, [path.join(relais, "proxy.js")], { env, windowsHide: true, stdio: "ignore" });
  const envC = Object.assign({}, process.env);
  for (const k of ["ANTHROPIC_MODEL", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_USE_OPENROUTER", "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_EFFORT", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) delete envC[k];
  Object.assign(envC, { ANTHROPIC_BASE_URL: "http://127.0.0.1:" + port, CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CONFIG_DIR: profil });
  let cl = null;
  const fin = () => { if (cl) tuer(cl.pid); tuer(rel.pid); };
  try {
    for (let i = 0; i < 60; i++) { try { const ok = await new Promise((r) => { const q = require("http").get("http://127.0.0.1:" + port + "/__proxy_health", (x) => { x.resume(); r(x.statusCode === 200); }); q.on("error", () => r(false)); }); if (ok) break; } catch (e) { /* pas encore pret */ } await sleep(200); }
    const claude = fs.existsSync(path.join(os.homedir(), ".local", "bin", "claude.exe")) ? path.join(os.homedir(), ".local", "bin", "claude.exe") : "claude";
    cl = spawn(claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "claude-haiku-5-5", "--permission-mode", "bypassPermissions", "--debug-file", path.join(dir, "debug.log")],
      { cwd: projet, env: envC, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const out = fs.createWriteStream(path.join(dir, "out.jsonl"));
    let results = 0, buf = "", fini = false;
    const attendu = nom === "S1" ? 2 : 1; // S1 : le tour reveille par la notification apres compactage
    const fermer = (ms) => setTimeout(() => { fini = true; fin(); }, ms);
    cl.stdout.on("data", (c) => { out.write(c); buf += c.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { if (JSON.parse(l).type === "result") { results++; if (results === attendu) fermer(nom === "S1" ? 6000 : 3000); } } catch (e) { /* ligne non JSON */ } } });
    cl.on("exit", () => { if (!fini) fermer(300); });
    cl.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: PROMPTS[nom] } }) + "\n");
    const t0 = Date.now();
    while (!fini && Date.now() - t0 < 8 * 60 * 1000) await sleep(500); // delai maximal 8 min
    if (!fini) fin();
    await sleep(800);
  } finally { fin(); }
  return analyser(nom, dir, relais, stopLog);
}

function analyser(nom, dir, relais, stopLog) {
  const log = lire(path.join(relais, "proxy.log")), debug = lire(path.join(dir, "debug.log")), stop = lire(stopLog);
  const transcrit = (() => { const base = path.join(dir, "profil", "projects"); let t = ""; try { for (const d of fs.readdirSync(base)) for (const f of fs.readdirSync(path.join(base, d))) if (f.endsWith(".jsonl")) t += lire(path.join(base, d, f)); } catch (e) { /* pas de transcrit */ } return t; })();
  const gonfle = (log.match(/ANTICIPE gonfle .*/g) || []), compact = (log.match(/CLAUDE-COMPACT motif=auto.*/g) || []);
  const agentsRelais = gonfle.map((l) => Number((/agents=(\d+)/.exec(l) || [])[1]));
  const agentsStop = (stop.match(/subagent=(-?\d+)/g) || []).map((x) => Number(x.split("=")[1])).filter((n) => n > 0);
  const nivCompact = /level=compact/.test(debug);
  // premiere requete API apres level=compact : doit etre le compactage (avant toute relecture des rapports)
  const apres = debug.split("level=compact")[1] || "";
  const premiere = (/\[API REQUEST\] \/v1\/messages source=(\w+)/.exec(apres) || [])[1] || null;
  const boundary = /"subtype":"compact_boundary"/.test(transcrit);
  const lance = /Async agent launched/.test(transcrit), notif = /<task-notification>/.test(transcrit);
  const checks = [];
  const ck = (ok, msg) => checks.push({ ok: !!ok, msg });
  if (nom === "S1") {
    ck(lance, "un sous-agent de fond a ete lance (validite)");
    ck(gonfle.length >= 1, "ANTICIPE gonfle au journal du relais : " + gonfle.length);
    ck(gonfle.length && agentsRelais.every((n) => n === 1), "agents=1 : " + JSON.stringify(agentsRelais));
    ck(compact.length >= 1, "CLAUDE-COMPACT motif=auto au journal du relais : " + compact.length);
    ck(nivCompact && premiere === "compact", "level=compact au --debug-file, puis la premiere requete API est source=compact (" + premiere + ")");
    ck(log.indexOf("ANTICIPE gonfle") >= 0 && log.indexOf("ANTICIPE gonfle") < log.indexOf("CLAUDE-COMPACT motif=auto"), "ANTICIPE gonfle avant CLAUDE-COMPACT");
    ck(boundary, "compact_boundary au transcrit");
  } else {
    ck(nom === "S0p" || lance, "validite : agent lance");
    ck(nom === "S0p" || notif, "validite : notification recue avant la fin de tour");
    ck(gonfle.length === 0, "aucun ANTICIPE gonfle : " + gonfle.length);
    ck(compact.length === 0 && !nivCompact && !boundary, "aucun compactage (CLAUDE-COMPACT, level=compact, compact_boundary)");
  }
  ck(JSON.stringify(agentsRelais) === JSON.stringify(agentsStop), "agents= du relais " + JSON.stringify(agentsRelais) + " == compte subagent de stop.log " + JSON.stringify(agentsStop));
  return { nom, checks };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let echec = 0;
  for (const nom of QUELS) {
    if (!PROMPTS[nom]) { console.error("scenario inconnu : " + nom); process.exit(2); }
    const r = await scenario(nom);
    console.log("=== " + nom);
    for (const c of r.checks) { console.log((c.ok ? "PASS " : "FAIL ") + c.msg); if (!c.ok) echec++; }
  }
  console.log(echec ? "ECHEC : " + echec + " controle(s)" : "PASS : bout en bout");
  process.exit(echec ? 1 : 0);
})();
