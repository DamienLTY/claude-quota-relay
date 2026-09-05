// Integration test for memory-hook.js — no network (Haiku call is faked via CQR_FAKE_SUMMARY).
// Exercises: refresh-on-switch + inject, marker dedup, archive, SessionStart inject, inactive no-op.
// Run: node test/memory-hook.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path");
const cp = require("child_process");

const HOOK = p.join(__dirname, "..", "src", "memory-hook.js");
const FAKE_TOKEN = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

function setup(compaction) {
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-mem-"));
  const INSTALL = p.join(T, "install"); fs.mkdirSync(INSTALL);
  const PROJ = p.join(T, "project"); fs.mkdirSync(PROJ);
  fs.writeFileSync(p.join(INSTALL, "tokens.json"), JSON.stringify({ tokens: [{ name: "a", token: FAKE_TOKEN, enabled: true }], compaction }));
  fs.writeFileSync(p.join(INSTALL, "state.json"), JSON.stringify({ pct: { a: { h5: 10 } }, compaction: { at: 1000, from: "a", to: "b", reason: "switch" } }));
  const TR = p.join(T, "t.jsonl");
  fs.writeFileSync(TR, [
    JSON.stringify({ type: "user", message: { role: "user", content: "construis le scraper" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok je lis" }, { type: "tool_use", name: "Read" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "contenu fichier".repeat(50) }] } }),
  ].join("\n"));
  return { T, INSTALL, PROJ, TR };
}

function run(env, INSTALL, PROJ, TR, event, fakeSummary) {
  const r = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, cwd: PROJ, transcript_path: TR, session_id: (env && env.__sid) || "sess-1" }),
    env: Object.assign({}, process.env, { CQR_DIR: INSTALL, CQR_FAKE_SUMMARY: fakeSummary }, env || {}),
    encoding: "utf8",
  });
  return r;
}

const enabled = { enabled: true, dryRun: false, memoryFile: ".cqr-memory.md", archiveDir: ".cqr-archive", memoryMaxLines: 400 };

// Le resume tourne desormais dans un processus DETACHE (il depassait les 5 s accordees au hook).
// Les tests doivent donc attendre son effet au lieu de le supposer fait au retour de run().
function patiente(cond, msg, ms) {
  const fin = Date.now() + (ms || 8000);
  while (Date.now() < fin) { if (cond()) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  assert.fail(msg);
}
const lu = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return ""; } };
// Un resume doit porter la structure imposee, sinon il est refuse : les faux resumes des tests
// la portent donc, sauf la ou c'est precisement le sujet.
const MEM = (s) => "# MEMOIRE PROJET\n## Taches faites\n- " + s;

// --- Case 1: UserPromptSubmit with a fresh marker -> refresh memory + inject it ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const r = run({}, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("lu les sources"));
  const memFile = p.join(PROJ, ".cqr-memory.md");
  patiente(() => lu(memFile).includes("lu les sources"), "memory file written by the detached refresh");
  const lastFile = p.join(PROJ, ".cqr-archive", ".last");
  patiente(() => lu(lastFile).includes("1000"), "marker consumed (last.at = marker.at)");
  assert.strictEqual(JSON.parse(lu(lastFile)).at, 1000, "marker consumed (last.at = marker.at)");
  // Le tour qui declenche le refresh n'injecte rien : le fichier n'existe pas encore, le resume
  // arrive apres. C'est au tour SUIVANT que la memoire fraiche part -- et c'est ca qu'il faut
  // verifier, sinon on n'a teste que le detachement.
  assert.strictEqual(r.stdout.trim(), "", "rien a injecter au tour qui declenche le premier resume");
  const r2 = run({}, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("lu les sources"));
  assert.ok(r2.stdout.trim(), "le tour suivant emet bien quelque chose");
  const out = JSON.parse(r2.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, "UserPromptSubmit", "injects for the right event");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("lu les sources"), "le tour suivant injecte la memoire fraiche");
}

// --- Case 2: marker dedup — running again with the same marker does NOT refresh ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("FIRST SUMMARY"));
  const memFile = p.join(PROJ, ".cqr-memory.md");
  patiente(() => lu(memFile).includes("FIRST SUMMARY"), "first run wrote FIRST");
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("SECOND SUMMARY"));
  patiente(() => !fs.existsSync(p.join(PROJ, ".cqr-archive", ".lock")), "le second enfant a fini");
  assert.ok(lu(memFile).includes("FIRST SUMMARY"), "dedup: same marker.at -> no re-summarize");
  assert.ok(!lu(memFile).includes("SECOND SUMMARY"), "second summary NOT applied");
}

// --- Case 3: archive — an existing memory file is archived before overwrite ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const memFile = p.join(PROJ, ".cqr-memory.md");
  fs.writeFileSync(memFile, "ANCIENNE MEMOIRE");
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("NOUVELLE MEMOIRE"));
  patiente(() => lu(memFile).includes("NOUVELLE MEMOIRE"), "memory updated");
  const archived = fs.readdirSync(p.join(PROJ, ".cqr-archive")).filter((f) => f.startsWith("memory-"));
  assert.ok(archived.length === 1, "previous memory archived");
  assert.ok(fs.readFileSync(p.join(PROJ, ".cqr-archive", archived[0]), "utf8").includes("ANCIENNE"), "archive holds the old memory");
}

// --- Case 4: SessionStart injects existing memory without refreshing ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const memFile = p.join(PROJ, ".cqr-memory.md");
  fs.writeFileSync(memFile, "MEMOIRE EXISTANTE");
  const r = run({}, INSTALL, PROJ, TR, "SessionStart", "SHOULD NOT BE USED");
  assert.ok(fs.readFileSync(memFile, "utf8") === "MEMOIRE EXISTANTE", "SessionStart does not refresh the file");
  const out = JSON.parse(r.stdout);
  assert.ok(out.hookSpecificOutput.additionalContext.includes("MEMOIRE EXISTANTE"), "SessionStart injects the existing memory");
}

// --- Case 5: inactive (enabled:false, dryRun:false) -> no output, no file ---
{
  const { INSTALL, PROJ, TR } = setup({ enabled: false, dryRun: false });
  const r = run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "X");
  assert.strictEqual(r.stdout.trim(), "", "inactive: emits nothing");
  assert.ok(!fs.existsSync(p.join(PROJ, ".cqr-memory.md")), "inactive: creates no memory file");
}

// --- Case 6: compaction Haiku call spends the OLD (just-abandoned) account's margin,
// NOT the fresh one's -- this is the fix for the user-reported bug (compaction always
// consumed tokens on the fresh key even though the old one still had headroom left) ---
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-mem-"));
  const INSTALL = p.join(T, "install"); fs.mkdirSync(INSTALL);
  const PROJ = p.join(T, "project"); fs.mkdirSync(PROJ);
  const TOK_OLD = "sk-ant-oat01-FAKE-OLD-ACCOUNT-still-has-margin-00";
  const TOK_FRESH = "sk-ant-oat01-FAKE-FRESH-ACCOUNT-pristine-quota-00";
  fs.writeFileSync(p.join(INSTALL, "tokens.json"), JSON.stringify({
    tokens: [{ name: "old", token: TOK_OLD, enabled: true }, { name: "fresh", token: TOK_FRESH, enabled: true }],
    compaction: enabled,
  }));
  // old (just switched away from) still has plenty of margin (90% < block); fresh is much fresher (20%).
  // Naive "pick freshest" would wrongly choose "fresh"; the fix must choose "old" (marker.from).
  fs.writeFileSync(p.join(INSTALL, "state.json"), JSON.stringify({
    pct: { old: { h5: 90 }, fresh: { h5: 20 } }, exhausted: {},
    compaction: { at: 2000, from: "old", to: "fresh", reason: "switch" },
  }));
  const TR = p.join(T, "t.jsonl");
  fs.writeFileSync(TR, JSON.stringify({ type: "user", message: { role: "user", content: "continue" } }));
  const recordFile = p.join(T, "recorded-token.txt");
  run({ CQR_RECORD_TOKEN_TO: recordFile }, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("MEM"));
  patiente(() => fs.existsSync(recordFile), "the detached refresh made its Haiku call");
  assert.strictEqual(lu(recordFile), TOK_OLD, "compaction Haiku call uses the OLD account's token, not the fresh one's");
}

// --- Case 7: if the old account is genuinely exhausted (blocked), fall back to the freshest ---
{
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-mem-"));
  const INSTALL = p.join(T, "install"); fs.mkdirSync(INSTALL);
  const PROJ = p.join(T, "project"); fs.mkdirSync(PROJ);
  const TOK_OLD = "sk-ant-oat01-FAKE-OLD-ACCOUNT-blocked-000000000";
  const TOK_FRESH = "sk-ant-oat01-FAKE-FRESH-ACCOUNT-fallback-0000000";
  fs.writeFileSync(p.join(INSTALL, "tokens.json"), JSON.stringify({
    tokens: [{ name: "old", token: TOK_OLD, enabled: true }, { name: "fresh", token: TOK_FRESH, enabled: true }],
    compaction: enabled,
  }));
  fs.writeFileSync(p.join(INSTALL, "state.json"), JSON.stringify({
    pct: { old: { h5: 99 }, fresh: { h5: 20 } }, exhausted: { old: Date.now() + 3600000 },
    compaction: { at: 3000, from: "old", to: "fresh", reason: "switch" },
  }));
  const TR = p.join(T, "t.jsonl");
  fs.writeFileSync(TR, JSON.stringify({ type: "user", message: { role: "user", content: "continue" } }));
  const recordFile = p.join(T, "recorded-token.txt");
  run({ CQR_RECORD_TOKEN_TO: recordFile }, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("MEM"));
  patiente(() => fs.existsSync(recordFile), "the detached refresh made its Haiku call");
  assert.strictEqual(lu(recordFile), TOK_FRESH, "old account genuinely blocked -> falls back to the freshest account");
}

// --- Dedup d'injection : la memoire ne repart que si elle a CHANGE dans la session ---
// Elle coutait ~730-830 tokens a CHAQUE tour pour un fichier qui bouge une quinzaine de fois en
// trois semaines. Le point delicat n'est pas l'economie mais la compaction : elle reecrit le
// contexte, donc une memoire "deja injectee" peut en avoir disparu.
{
  const { T, INSTALL, PROJ, TR } = setup(enabled);
  const mem = p.join(PROJ, ".cqr-memory.md");
  const inject = (out) => { try { return !!JSON.parse(out).hookSpecificOutput.additionalContext; } catch (e) { return false; } };
  const arch = p.join(PROJ, ".cqr-archive");
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(p.join(arch, ".last"), JSON.stringify({ at: 99999 })); // marqueur deja consomme

  fs.writeFileSync(mem, "# MEMOIRE PROJET - premiere version");
  assert.ok(inject(run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "M").stdout), "1er tour : la memoire est injectee");
  assert.ok(!inject(run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "M").stdout), "2e tour, contenu inchange : plus rien n'est reinjecte");

  fs.writeFileSync(mem, "# MEMOIRE PROJET - deuxieme version");
  assert.ok(inject(run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "M").stdout), "contenu change : la memoire repart");
  assert.ok(!inject(run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "M").stdout), "et se tait de nouveau ensuite");

  assert.ok(inject(run({ __sid: "sess-2" }, INSTALL, PROJ, TR, "UserPromptSubmit", "M").stdout), "autre session : injectee malgre le meme contenu");
  assert.ok(inject(run({}, INSTALL, PROJ, TR, "SessionStart", "M").stdout), "SessionStart injecte toujours : le contexte y est neuf");

  // LE point que la greffe d'origine n'avait pas vu.
  run({}, INSTALL, PROJ, TR, "PreCompact", "M");
  assert.ok(inject(run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "M").stdout),
    "apres une compaction, la memoire est REINJECTEE (sinon elle disparait pour toute la session)");

  // et le reglage rend l'injection systematique a qui la veut
  const s2 = setup(Object.assign({}, enabled, { memoryDedup: false }));
  fs.mkdirSync(p.join(s2.PROJ, ".cqr-archive"), { recursive: true });
  fs.writeFileSync(p.join(s2.PROJ, ".cqr-archive", ".last"), JSON.stringify({ at: 99999 }));
  fs.writeFileSync(p.join(s2.PROJ, ".cqr-memory.md"), "# MEMOIRE PROJET - x");
  assert.ok(inject(run({}, s2.INSTALL, s2.PROJ, s2.TR, "UserPromptSubmit", "M").stdout), "memoryDedup:false, 1er tour");
  assert.ok(inject(run({}, s2.INSTALL, s2.PROJ, s2.TR, "UserPromptSubmit", "M").stdout), "memoryDedup:false : injectee a chaque tour, comme avant");
  fs.rmSync(T, { recursive: true, force: true });
}

// --- Un resume qui degenere ne doit PAS ecraser la memoire ---
// Deux fois sur un poste reel : 2753 octets remplaces par 472 (prose narrative qui se lisait
// comme une consigne de l'utilisateur), puis 3362 par 144 (un fragment de commande collee).
// Le seul garde-fou etait "reponse non vide", donc les deux sont passes.
{
  const { T, INSTALL, PROJ, TR } = setup(enabled);
  const memFile = p.join(PROJ, ".cqr-memory.md");
  const bonne = "# MEMOIRE PROJET\n## Taches faites\n- trois semaines de travail";
  fs.writeFileSync(memFile, bonne);

  // L'enfant est detache : attendre l'absence du verrou ne prouve rien (il n'est pas encore
  // pris). On attend la trace de l'appel Haiku, PUIS la liberation du verrou -- entre les deux
  // se joue exactement la decision d'ecrire ou non.
  let n = 0;
  const refuse = (resume, msg) => {
    const rec = p.join(T, "rec-" + (++n) + ".txt");
    run({ CQR_RECORD_TOKEN_TO: rec }, INSTALL, PROJ, TR, "UserPromptSubmit", resume);
    patiente(() => fs.existsSync(rec), "l'enfant a appele le resumeur");
    patiente(() => !fs.existsSync(p.join(PROJ, ".cqr-archive", ".lock")), "l'enfant a rendu son verrou");
    assert.strictEqual(lu(memFile), bonne, msg);
  };

  // les deux degenerescences reellement observees
  refuse("```\ncqr compact\n```\n\nResultat attendu : affichage du statut.",
    "un fragment de conversation ne remplace pas la memoire");
  refuse("En attente de la finalisation de la revue.\n\nLorsque la revue reviendra, le cycle continuera ainsi.",
    "une prose sans structure ne remplace pas la memoire");

  // le marqueur n'est pas consomme -> la prochaine tentative repart, et un bon resume passe
  assert.ok(!fs.existsSync(p.join(PROJ, ".cqr-archive", ".last")), "marqueur non consomme apres un refus");

  // Un refus SYSTEMATIQUE coincerait la memoire pour de bon (un resume relance a chaque prompt,
  // qui echoue toujours). Le titre accentue est donc accepte : l'instruction l'ecrit sans accent,
  // le modele peut le "corriger".
  {
    const s3 = setup(enabled);
    const m3 = p.join(s3.PROJ, ".cqr-memory.md");
    run({}, s3.INSTALL, s3.PROJ, s3.TR, "UserPromptSubmit", "# MÉMOIRE PROJET\n## Tâches faites\n- accent accepte");
    patiente(() => lu(m3).includes("accent accepte"), "un titre accentue reste un resume valide");
  }
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("resume valide"));
  patiente(() => lu(memFile).includes("resume valide"), "un resume bien forme, lui, est ecrit");
}

// --- Le hook rend la main sans attendre l'appel Haiku ---
// Il attendait jusqu'a 12 s quand Claude Code ne lui en accorde que 5 : tue avant d'aboutir,
// memoire non injectee, marqueur non consomme, donc la meme attente au message suivant.
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const memFile = p.join(PROJ, ".cqr-memory.md");
  const t0 = Date.now();
  run({ CQR_FAKE_DELAY_MS: "4000" }, INSTALL, PROJ, TR, "UserPromptSubmit", MEM("resume lent"));
  const duree = Date.now() - t0;
  assert.ok(duree < 2500, "le hook rend la main sans attendre le resume (mesure " + duree + " ms pour un appel de 4000 ms)");
  patiente(() => lu(memFile).includes("resume lent"), "et le resume aboutit quand meme, en arriere-plan", 15000);
}

// --- L'injection dit d'ou vient le texte ---
// Sans ca, un agent lit "Taches prevues : pousser sur staging" comme un ordre de l'utilisateur.
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const arch = p.join(PROJ, ".cqr-archive");
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(p.join(arch, ".last"), JSON.stringify({ at: 99999 }));
  fs.writeFileSync(p.join(PROJ, ".cqr-memory.md"), MEM("pousser sur staging"));
  const ctx = JSON.parse(run({}, INSTALL, PROJ, TR, "SessionStart", "X").stdout).hookSpecificOutput.additionalContext;
  assert.ok(/RESUMEE PAR UNE MACHINE/.test(ctx), "l'en-tete annonce un texte genere");
  assert.ok(/pas la parole de l'utilisateur/.test(ctx), "l'en-tete retire au texte l'autorite de l'utilisateur");
  assert.ok(/jamais comme une consigne/.test(ctx), "l'en-tete dit de ne pas l'executer");
}

console.log("PASS — memory-hook.js: refresh+inject, dedup, archive, SessionStart inject, inactive no-op, dedup par session + reinjection apres compaction, old-account-preferred-for-compaction, resume mal forme refuse, refresh non bloquant, injection tracee");
