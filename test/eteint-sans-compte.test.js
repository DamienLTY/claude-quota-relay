// J7B-020 / DR-271 : cqr « installe, eteint » sans compte ; branche et demarre au premier compte ; et, avec au moins
// un compte, comportement IDENTIQUE a celui d'avant (octet pour octet). Run: node test/eteint-sans-compte.test.js
//   C2 : ensure-proxy.js et `cqr start|restart` ne lancent rien sans compte (parite isPlaceholder, contre-epreuve possible)
//   C3 : install.js sans compte = pas de routage ; `cqr set` du 1er compte = routage + jeton + relais ; 2e compte = rien
//   C4 : non-regression contre l'etat d'avant la voie C (REF, par defaut le commit 85a0b5a) avec 1 puis 6 comptes
// Tout est jetable : HOME/USERPROFILE/CLAUDE_CONFIG_DIR dans un dossier temporaire, port tire au hasard (jamais 8787).
// Variables : CQR_SRC = dossier src a tester (contre-epreuve C2 : pointer sur l'ancien src) ; CQR_REF = commit de reference.
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), http = require("http"), net = require("net"), cp = require("child_process"), crypto = require("crypto");

const REPO = p.join(__dirname, "..");
const SRC = process.env.CQR_SRC || p.join(REPO, "src");
const REF = process.env.CQR_REF || "85a0b5a";
// Faux jetons coupes en deux : jamais un vrai jeton, et le hook pre-commit ne s'y trompe pas.
const FAUX = (n) => "sk-ant-" + "oat01-FAUX" + String(n).padStart(2, "0") + "-" + "A".repeat(30);
const TMPS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function mk(prefix) { const d = fs.mkdtempSync(p.join(os.tmpdir(), prefix)); TMPS.push(d); return d; }
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => res(port)); }); });
}
function health(port) {
  return new Promise((res) => {
    const req = http.get("http://127.0.0.1:" + port + "/__proxy_health", (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false)); req.setTimeout(800, () => { req.destroy(); res(false); });
  });
}
async function waitFor(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; }

// Un « poste » jetable : HOME, <HOME>/.claude (config), son dossier cqr et son settings.json.
function poste(srcDir, files) {
  const home = mk("cqr-eteint-");
  const cfg = p.join(home, ".claude"), idir = p.join(cfg, "claude-quota-relay");
  fs.mkdirSync(idir, { recursive: true });
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, CQR_SKIP_PATH_REGISTER: "1", CQR_NO_POPUP: "1" });
  delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_AUTH_TOKEN;
  for (const f of files || []) fs.copyFileSync(p.join(srcDir, f), p.join(idir, f));
  return { home, cfg, idir, env, settings: p.join(cfg, "settings.json"), tokens: p.join(idir, "tokens.json") };
}
function ecrireComptes(P, port, jetons) {
  fs.writeFileSync(P.tokens, JSON.stringify({ port, switchAtPercent: 94, sevenDayBlockPercent: 99, tokens: jetons.map((t, i) => ({ name: "c" + (i + 1), token: t, enabled: true })) }));
}
function run(P, script, args, input) {
  return cp.spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000, windowsHide: true, env: P.env, input });
}
function arreter(P) { try { run(P, p.join(P.idir, "cli.js"), ["stop"]); } catch (e) {} }

// Faux proxy.js : pose un marqueur (preuve qu'il a ete lance) puis sort.
const FAUX_PROXY = 'require("fs").writeFileSync(require("path").join(__dirname, "lance.marqueur"), String(process.pid));';
const lance = (P) => fs.existsSync(p.join(P.idir, "lance.marqueur"));

const PLACEHOLDERS = ["PASTE_TOKEN_FROM_claude_setup-token", "REMPLACE_MOI", "<mon jeton>", ""];

(async () => {
  // ---------------- C2 : ensure-proxy.js ----------------
  {
    // Parite : la copie d'isPlaceholder dans ensure-proxy.js rend le meme verdict que lib.isPlaceholder.
    const lib = require(p.join(SRC, "lib.js"));
    const m = fs.readFileSync(p.join(SRC, "ensure-proxy.js"), "utf8").match(/function isPlaceholder\(t\) \{[^\n]*\}/);
    if (m) {
      const copie = new Function(m[0] + "; return isPlaceholder;")();
      const entrees = [{ token: "" }, { token: "PASTE_x" }, { token: "REMPLACE_x" }, { token: "<x>" }, { token: FAUX(1) }, null];
      for (const e of entrees) assert.strictEqual(copie(e), lib.isPlaceholder(e), "parite isPlaceholder sur " + JSON.stringify(e));
      console.log("PASS — C2 isPlaceholder de ensure-proxy.js = lib.isPlaceholder (6 entrees)");
    } else if (!process.env.CQR_SRC) assert.fail("isPlaceholder introuvable dans ensure-proxy.js");

    // Sans compte (tous fictifs, ou liste vide) : sortie 0, faux proxy jamais lance, port muet.
    for (const jetons of [PLACEHOLDERS, []]) {
      const P = poste(SRC, ["ensure-proxy.js"]); const port = await freePort();
      fs.writeFileSync(p.join(P.idir, "proxy.js"), FAUX_PROXY);
      ecrireComptes(P, port, jetons);
      const r = run(P, p.join(P.idir, "ensure-proxy.js"), []);
      await sleep(800);
      assert.strictEqual(r.status, 0, "ensure-proxy sans compte sort en 0");
      assert.ok(!lance(P), "ensure-proxy sans compte (" + jetons.length + " fictifs) ne lance rien");
      assert.ok(!(await health(port)), "port muet");
    }
    console.log("PASS — C2 ensure-proxy.js sans compte : code 0, rien lance, port muet");

    // Un vrai jeton (parmi des fictifs) : le faux proxy est lance, comme avant.
    {
      const P = poste(SRC, ["ensure-proxy.js"]); const port = await freePort();
      fs.writeFileSync(p.join(P.idir, "proxy.js"), FAUX_PROXY);
      ecrireComptes(P, port, ["PASTE_x", FAUX(1)]);
      run(P, p.join(P.idir, "ensure-proxy.js"), []);
      assert.ok(await waitFor(async () => lance(P), 5000), "ensure-proxy avec un vrai jeton lance le proxy");
    }
    // Fichier de comptes sans liste de comptes : comportement d'avant (lance), on ne casse pas un poste dont le fichier est en cours d'ecriture.
    // Fichier de comptes absent : comportement d'avant (lance). Le port retombe sur 8787 -- le vrai relais d'un poste equipe --
    // donc le test n'a lieu que si 8787 est libre (on tente de s'y mettre en ecoute, sans jamais s'y connecter), sinon SKIP.
    {
      const P = poste(SRC, ["ensure-proxy.js"]); const port = await freePort();
      fs.writeFileSync(p.join(P.idir, "proxy.js"), FAUX_PROXY);
      fs.writeFileSync(P.tokens, JSON.stringify({ port }));
      run(P, p.join(P.idir, "ensure-proxy.js"), []);
      assert.ok(await waitFor(async () => lance(P), 5000), "fichier de comptes sans liste : lance comme avant");
    }
    {
      const libre = await new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(8787, "127.0.0.1", () => s.close(() => res(true))); });
      if (!libre) console.log("SKIP — C2 ensure-proxy.js fichier de comptes absent : 8787 occupe (vrai relais), pas touche");
      else {
        const P = poste(SRC, ["ensure-proxy.js"]);
        fs.writeFileSync(p.join(P.idir, "proxy.js"), FAUX_PROXY);
        run(P, p.join(P.idir, "ensure-proxy.js"), []);
        assert.ok(await waitFor(async () => lance(P), 5000), "fichier de comptes absent : lance comme avant");
      }
    }
    console.log("PASS — C2 ensure-proxy.js : un vrai jeton, fichier sans liste ou absent -> lance comme avant");
  }

  // ---------------- C2 : cli start|restart ----------------
  {
    for (const cmd of ["start", "restart"]) {
      const P = poste(SRC, ["cli.js", "lib.js", "compaction.js"]); const port = await freePort();
      fs.writeFileSync(p.join(P.idir, "proxy.js"), FAUX_PROXY);
      ecrireComptes(P, port, PLACEHOLDERS);
      const r = run(P, p.join(P.idir, "cli.js"), [cmd]);
      await sleep(500);
      assert.strictEqual(r.status, 1, "cqr " + cmd + " sans compte : code 1 (" + r.stdout + r.stderr + ")");
      assert.ok(/cqr add/.test(r.stderr), "cqr " + cmd + " dit quoi faire : " + r.stderr);
      assert.ok(!lance(P), "cqr " + cmd + " sans compte ne lance rien");
    }
    console.log("PASS — C2 cqr start|restart sans compte : code 1, « cqr add », rien lance");
  }

  // ---------------- C3 : install.js sans compte, puis premier compte ----------------
  {
    const ALL = ["proxy.js", "cli.js", "ensure-proxy.js", "lib.js", "compaction.js", "free-compact.js", "entreprise.js", "ancre.js", "sonde-sse.js", "memory-hook.js", "cqr-statusline.js", "cqr-workflow-guard.js"];
    const P = poste(SRC, []); const port = await freePort();
    fs.writeFileSync(P.settings, JSON.stringify({ env: { FOO: "bar" }, model: "opus" }, null, 2));
    // installation depuis le depot du test (src/ + package.json + commands/ + config/) ; pas de tokens.json -> emplacements fictifs
    const ri = run(P, p.join(SRC, "install.js"), ["--no-interactive", "--config-dir", P.cfg, "--port", String(port)]);
    assert.strictEqual(ri.status, 0, "install.js sans compte sort en 0 : " + ri.stderr);
    let s = JSON.parse(fs.readFileSync(P.settings, "utf8"));
    assert.ok(!("ANTHROPIC_BASE_URL" in s.env), "sans compte : pas d'ANTHROPIC_BASE_URL");
    assert.ok(!("API_TIMEOUT_MS" in s.env) && !("CLAUDE_STREAM_IDLE_TIMEOUT_MS" in s.env), "sans compte : pas de delais");
    assert.ok(!("ANTHROPIC_AUTH_TOKEN" in s.env), "sans compte : pas de jeton");
    assert.ok(!("CLAUDE_CODE_GATEWAY_HINT_HEADERS" in s.env), "sans compte : pas d'en-tetes de passerelle");
    assert.strictEqual(s.env.FOO, "bar", "reglages existants gardes");
    assert.ok(JSON.stringify(s.hooks).includes("ensure-proxy.js"), "hook ensure-proxy pose (installe)");
    assert.ok(s.statusLine && /cqr-statusline/.test(s.statusLine.command), "statusline posee (installe)");
    assert.ok(/éteint/.test(ri.stdout) && /cqr add/.test(ri.stdout), "le message dit « eteint » et « cqr add » : " + ri.stdout);
    for (const f of ALL) assert.ok(fs.existsSync(p.join(P.idir, f)), "fichier installe : " + f);
    // le hook installe ne lance rien (aucun compte)
    run(P, p.join(P.idir, "ensure-proxy.js"), []); await sleep(800);
    assert.ok(!(await health(port)), "aucun relais apres l'installation et le hook");

    // Un ANTHROPIC_BASE_URL deja present n'est pas touche, mais signale.
    {
      const Q = poste(SRC, []); const q = await freePort();
      fs.writeFileSync(Q.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } }));
      const r = run(Q, p.join(SRC, "install.js"), ["--no-interactive", "--config-dir", Q.cfg, "--port", String(q)]);
      assert.strictEqual(JSON.parse(fs.readFileSync(Q.settings, "utf8")).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787", "valeur existante non touchee");
      assert.ok(/déjà ANTHROPIC_BASE_URL/.test(r.stdout), "avertissement : " + r.stdout);
    }

    // Premier compte : cqr set -> routage + delais + jeton, relais en ecoute sur le port jetable.
    try {
      const r1 = run(P, p.join(P.idir, "cli.js"), ["set", "a", FAUX(1)]);
      assert.strictEqual(r1.status, 0, "cqr set (1er compte) : " + r1.stdout + r1.stderr);
      s = JSON.parse(fs.readFileSync(P.settings, "utf8"));
      assert.strictEqual(s.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:" + port, "1er compte : ANTHROPIC_BASE_URL = port jetable");
      assert.strictEqual(s.env.API_TIMEOUT_MS, "605400000", "1er compte : delais poses");
      assert.strictEqual(s.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1", "1er compte : en-tetes de passerelle poses");
      assert.strictEqual(s.env.ANTHROPIC_AUTH_TOKEN, FAUX(1), "1er compte : jeton copie");
      assert.strictEqual(s.env.FOO, "bar", "reglages existants gardes");
      assert.ok(await health(port), "1er compte : /__proxy_health 200 sur le port jetable");
      // 2e compte : rien de nouveau (settings.json et relais inchanges)
      const avant = sha(fs.readFileSync(P.settings)); const pid = fs.readFileSync(p.join(P.idir, "proxy.pid"), "utf8");
      const r2 = run(P, p.join(P.idir, "cli.js"), ["set", "b", FAUX(2)]);
      assert.strictEqual(r2.status, 0, "cqr set (2e compte)");
      assert.strictEqual(sha(fs.readFileSync(P.settings)), avant, "2e compte : settings.json inchange (sha256)");
      assert.strictEqual(fs.readFileSync(p.join(P.idir, "proxy.pid"), "utf8"), pid, "2e compte : relais non relance (meme PID)");
      assert.ok(!/démarré et branché/.test(r2.stdout), "2e compte : pas de branchement");
    } finally { arreter(P); }
    console.log("PASS — C3 install sans compte = installe non branche ; 1er compte = branche et demarre ; 2e compte = rien");

    // Idem par `cqr add --paste` (chemin add/login).
    {
      const Q = poste(SRC, []); const q = await freePort();
      fs.writeFileSync(Q.settings, JSON.stringify({ env: {} }));
      run(Q, p.join(SRC, "install.js"), ["--no-interactive", "--config-dir", Q.cfg, "--port", String(q)]);
      try {
        const r = run(Q, p.join(Q.idir, "cli.js"), ["add", "x", "--paste"], FAUX(3) + "\n");
        assert.strictEqual(r.status, 0, "cqr add --paste (1er compte) : " + r.stdout + r.stderr);
        const s2 = JSON.parse(fs.readFileSync(Q.settings, "utf8"));
        assert.strictEqual(s2.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:" + q, "add --paste : branche");
        assert.strictEqual(s2.env.ANTHROPIC_AUTH_TOKEN, FAUX(3), "add --paste : jeton copie");
        assert.ok(await health(q), "add --paste : relais en ecoute");
      } finally { arreter(Q); }
      console.log("PASS — C3 cqr add --paste du 1er compte : branche et demarre");
    }

    // Retrait du dernier compte : les cles disparaissent de settings.json, le relais s'arrete ; le compte suivant les remet.
    {
      const Q = poste(SRC, []); const q = await freePort();
      fs.writeFileSync(Q.settings, JSON.stringify({ env: { FOO: "bar" } }));
      run(Q, p.join(SRC, "install.js"), ["--no-interactive", "--config-dir", Q.cfg, "--port", String(q)]);
      const cli = p.join(Q.idir, "cli.js");
      const CLES = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_GATEWAY_HINT_HEADERS", "API_TIMEOUT_MS", "CLAUDE_STREAM_IDLE_TIMEOUT_MS", "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS", "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS", "CLAUDE_CODE_MAX_RETRIES"];
      const env = () => JSON.parse(fs.readFileSync(Q.settings, "utf8")).env;
      try {
        assert.strictEqual(run(Q, cli, ["set", "a", FAUX(1)]).status, 0, "set a");
        assert.strictEqual(run(Q, cli, ["set", "b", FAUX(2)]).status, 0, "set b");
        assert.ok(await health(q), "relais en ligne avec 2 comptes");
        const r1 = run(Q, cli, ["remove", "a"]);
        assert.strictEqual(r1.status, 0, "remove a : " + r1.stdout + r1.stderr);
        for (const k of CLES) assert.ok(k in env(), "reste 1 compte : " + k + " toujours la");
        assert.ok(await health(q), "reste 1 compte : relais toujours en ligne");
        const r2 = run(Q, cli, ["remove", "b"]);
        assert.strictEqual(r2.status, 0, "remove b (dernier) : " + r2.stdout + r2.stderr);
        assert.ok(/Plus aucun compte/.test(r2.stdout), "message clair : " + r2.stdout);
        for (const k of CLES) assert.ok(!(k in env()), "dernier compte retire : " + k + " retiree de settings.json");
        assert.strictEqual(env().FOO, "bar", "reglages existants gardes");
        assert.ok(!(await waitFor(() => health(q), 1500)) , "dernier compte retire : relais arrete");
        const r3 = run(Q, cli, ["set", "c", FAUX(3)]);
        assert.strictEqual(r3.status, 0, "set c : " + r3.stdout + r3.stderr);
        for (const k of CLES) assert.ok(k in env(), "compte suivant : " + k + " reapparait");
        assert.ok(await health(q), "compte suivant : relais redemarre");
      } finally { arreter(Q); }
      console.log("PASS — C3 retrait du dernier compte : cles retirees et relais arrete ; compte suivant : tout revient");
    }

    // settings.json casse + cqr set (1er compte) : code propre, message clair, jeton enregistre, rien d'ecrit dans settings.json.
    {
      const Q = poste(SRC, []); const q = await freePort();
      fs.writeFileSync(Q.settings, "{}");
      run(Q, p.join(SRC, "install.js"), ["--no-interactive", "--config-dir", Q.cfg, "--port", String(q)]);
      const CASSE = '{"env": {oups';
      fs.writeFileSync(Q.settings, CASSE);
      try {
        const r = run(Q, p.join(Q.idir, "cli.js"), ["set", "a", FAUX(4)]);
        assert.strictEqual(r.status, 1, "settings.json casse : code 1 propre : " + r.stdout + r.stderr);
        assert.ok(/illisible/.test(r.stderr) && /enregistré/.test(r.stderr), "message clair (fichier a reparer, jeton enregistre) : " + r.stderr);
        assert.ok(!/SyntaxError|\s+at /.test(r.stderr), "pas de trace d'exception : " + r.stderr);
        assert.ok(JSON.parse(fs.readFileSync(Q.tokens, "utf8")).tokens.some((t) => t.token === FAUX(4)), "jeton enregistre dans le fichier de comptes");
        assert.strictEqual(fs.readFileSync(Q.settings, "utf8"), CASSE, "settings.json casse laisse tel quel");
        assert.ok(!(await health(q)), "relais non demarre");
      } finally { arreter(Q); }
      console.log("PASS — C3 settings.json casse + cqr set : code 1, message clair, jeton enregistre, rien d'ecrit");
    }

    // Idem avec un compte deja present (chemin syncAuthToken) : add --paste du 2e compte, et sync-env.
    {
      const Q = poste(SRC, []); const q = await freePort();
      fs.writeFileSync(Q.settings, "{}");
      run(Q, p.join(SRC, "install.js"), ["--no-interactive", "--config-dir", Q.cfg, "--port", String(q)]);
      ecrireComptes(Q, q, [FAUX(5)]);
      const CASSE = '{"env": {oups';
      fs.writeFileSync(Q.settings, CASSE);
      const verif = (r, quoi) => {
        assert.strictEqual(r.status, 1, quoi + " : code 1 propre : " + r.stdout + r.stderr);
        assert.ok(/illisible/.test(r.stderr), quoi + " : message clair : " + r.stderr);
        assert.ok(!/SyntaxError|\s+at /.test(r.stderr), quoi + " : pas de trace : " + r.stderr);
        assert.strictEqual(fs.readFileSync(Q.settings, "utf8"), CASSE, quoi + " : settings.json casse laisse tel quel");
      };
      try {
        const r = run(Q, p.join(Q.idir, "cli.js"), ["add", "y", "--paste"], FAUX(6) + "\n");
        verif(r, "add --paste (2e compte)");
        assert.ok(JSON.parse(fs.readFileSync(Q.tokens, "utf8")).tokens.some((t) => t.token === FAUX(6)), "2e jeton enregistre dans le fichier de comptes");
        verif(run(Q, p.join(Q.idir, "cli.js"), ["sync-env"]), "sync-env");
        assert.ok(!(await health(q)), "relais non demarre");
      } finally { arreter(Q); }
      console.log("PASS — C3 settings.json casse + 2e compte (add --paste) ou sync-env : code 1, message clair, jeton enregistre");
    }
  }

  // ---------------- C4 : non-regression octet pour octet (avec 1 et 6 comptes) ----------------
  {
    const ref = mk("cqr-ref-"); const tar = p.join(ref, "ref.tar");
    const g = cp.spawnSync("git", ["-C", p.join(REPO, ".."), "archive", "--format=tar", REF + ":claude-quota-relay"], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    let refOk = g.status === 0 && g.stdout.length > 100000;
    if (refOk) fs.writeFileSync(tar, g.stdout);
    if (refOk) refOk = cp.spawnSync("tar", ["-xf", "ref.tar"], { cwd: ref, windowsHide: true }).status === 0 // chemin relatif : GNU tar prend « C: » pour un hote;
    if (!refOk && !process.env.CQR_ALLOW_SKIP) { console.error("ECHEC — C4 : reference " + REF + " introuvable (git archive) : " + String(g.stderr || "").trim() + " (CQR_ALLOW_SKIP=1 pour passer outre)"); process.exit(1); }
    if (!refOk) { console.log("SKIP — C4 : reference " + REF + " introuvable (git archive) : " + String(g.stderr || "").trim()); }
    else {
      const REFSRC = ref; // l'archive est prise depuis claude-quota-relay/ : src/, package.json, commands/, config/ a la racine
      const RESEAU = { env: { FOO: "bar", ANTHROPIC_TARGET_API_URL: "https://exemple.invalide", CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" } };
      // settings.json realiste mais anonymise : memes cles et structure que celui d'un poste equipe, aucune valeur secrete.
      const SETTINGS0 = Object.assign({}, RESEAU, {
        model: "opus", permissions: { allow: ["Bash(git status)"], deny: ["Read(**/secret*)"] }, includeCoAuthoredBy: false,
        hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo salut" }] }], Stop: [{ hooks: [{ type: "command", command: "echo fin" }] }] },
        statusLine: { type: "command", command: "echo MA-LIGNE", padding: 0 },
        enabledPlugins: { "exemple@exemple": true },
      });
      const norm = (s, P) => String(s).split(P.home).join("<HOME>").split(P.home.replace(/\\/g, "/")).join("<HOME>").replace(/\.bak-\d+/g, ".bak-N").replace(/[A-Za-z]:[\\/]+[^\s"']*cqr-eteint-[^\s"'\\/]+/g, "<HOME>");
      const IGNORE = new Set(["proxy.pid", "proxy.log", "proxy.out.log", "state.json", "statusline.json", "proxy.guard", "proxy.stopped",
        "package.json"]); // version et script test changent ; les copies .js installees aussi (code modifie depuis REF, DR-022) : tout le reste (settings, comptes, commandes) doit etre identique
      function arbre(dir, base, out, P) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const f = p.join(dir, e.name), rel = p.relative(base, f).replace(/\\/g, "/").replace(/\.bak-\d+/, ".bak-N");
          if (e.isDirectory()) arbre(f, base, out, P);
          else if (!IGNORE.has(e.name) && !e.name.endsWith(".js")) out[rel] = sha(norm(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n"), P)); // fins de ligne de la copie de travail (autocrlf) : sans effet sur le comportement
        }
        return out;
      }
      const portFixe = await freePort();
      async function jouer(srcRoot, n) {
        const P = poste(p.join(srcRoot, "src"), []);
        const sortie = [];
        const log = (nom, r) => sortie.push(nom + " | code " + r.status + "\n" + norm(r.stdout, P) + "\n--stderr--\n" + norm(r.stderr, P));
        fs.writeFileSync(P.settings, JSON.stringify(SETTINGS0, null, 2));
        const jetons = []; for (let i = 1; i <= n; i++) jetons.push(FAUX(i));
        ecrireComptes(P, portFixe, jetons);
        const inst = p.join(srcRoot, "src", "install.js");
        try {
          log("install", run(P, inst, ["--no-interactive", "--config-dir", P.cfg]));
          log("install (2e passage)", run(P, inst, ["--no-interactive", "--config-dir", P.cfg]));
          log("ensure-proxy", run(P, p.join(P.idir, "ensure-proxy.js"), [])); // lance le vrai relais (jetable)
          await waitFor(() => health(portFixe), 6000);
          const cli = p.join(P.idir, "cli.js");
          log("set nouveau", run(P, cli, ["set", "nouveau", FAUX(50)]));
          log("set existant", run(P, cli, ["set", "c1", FAUX(51)]));
          log("add --paste", run(P, cli, ["add", "colle", "--paste"], FAUX(52) + "\n"));
          log("login --paste", run(P, cli, ["login", "c1", "--paste"], FAUX(53) + "\n"));
          log("sync-env", run(P, cli, ["sync-env"]));
          log("start (deja en cours)", run(P, cli, ["start"]));
          log("restart", run(P, cli, ["restart"]));
          log("stop", run(P, cli, ["stop"]));
          log("start", run(P, cli, ["start"]));
          log("stop 2", run(P, cli, ["stop"]));
          await sleep(500);
        } finally { arreter(P); }
        return { sortie, arbre: arbre(P.cfg, P.cfg, {}, P) };
      }
      for (const n of [1, 6]) {
        const a = await jouer(REFSRC, n);          // etat d'avant (REF)
        await sleep(800);
        const b = await jouer(REPO, n);            // code a tester (CQR_SRC ne sert qu'a C2 ; ici le depot)
        await sleep(800);
        assert.strictEqual(b.sortie.length, a.sortie.length);
        for (let i = 0; i < a.sortie.length; i++) assert.strictEqual(b.sortie[i], a.sortie[i], n + " compte(s) : sortie identique a REF, etape " + a.sortie[i].split("\n")[0]);
        assert.deepStrictEqual(b.arbre, a.arbre, n + " compte(s) : arbre de fichiers identique a REF (sha256)");
        console.log("PASS — C4 " + n + " compte(s) : " + a.sortie.length + " sorties et " + Object.keys(a.arbre).length + " fichiers identiques a " + REF);
      }
    }
  }

  for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  console.log("PASS — eteint-sans-compte : C2, C3, C4");
  process.exit(0);
})().catch((e) => { console.error(e); for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (x) {} } process.exit(1); });
