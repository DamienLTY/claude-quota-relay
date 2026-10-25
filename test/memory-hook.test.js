// Integration test for memory-hook.js (0.21.0, DR-050 / DR-060) -- no network, no model: the memory is a
// FACTUAL STATE built from git, TODO.md and REGISTRE-DECISIONS.md, plus a "Notes" section nothing rewrites.
// Real hook process, throwaway directories (with git, without git, worktree, broken .git).
// Run: node test/memory-hook.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path");
const cp = require("child_process");

const HOOK = p.join(__dirname, "..", "src", "memory-hook.js");
const enabled = { enabled: true, dryRun: false, memoryFile: ".cqr-memory.md", archiveDir: ".cqr-archive" };
const HEADER = "état factuel bâti sans modèle ; les fichiers du projet font foi";
const TITLE = "# État factuel bâti sans modèle ; les fichiers du projet font foi";

try { cp.execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true }); }
catch (e) { console.log("SKIP — memory-hook.js : git introuvable, le test ne peut pas construire de depot"); process.exit(0); }

const roots = [];
function setup(compaction) {
  const T = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-mem-")); roots.push(T);
  const INSTALL = p.join(T, "install"); fs.mkdirSync(INSTALL);
  const PROJ = p.join(T, "project"); fs.mkdirSync(PROJ);
  fs.writeFileSync(p.join(INSTALL, "tokens.json"), JSON.stringify({ tokens: [], compaction }));
  // L'ancien relais posait ce marqueur a chaque bascule de compte pour declencher un resume de fond.
  // Il est toujours ecrit (cqr compact l'affiche) : le hook ne doit plus rien en faire.
  fs.writeFileSync(p.join(INSTALL, "state.json"), JSON.stringify({ compaction: { at: 1000, from: "a", to: "b", reason: "switch" } }));
  return { T, INSTALL, PROJ };
}
function run(INSTALL, PROJ, event, sid, env) {
  return cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, cwd: PROJ, session_id: sid || "sess-1" }),
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: undefined }, { CQR_DIR: INSTALL }, env || {}),
    encoding: "utf8",
  });
}
function git(dir, ...args) {
  return cp.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false"].concat(args), { cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}
function commit(dir, msg) { fs.writeFileSync(p.join(dir, "f.txt"), msg); git(dir, "add", "f.txt"); git(dir, "commit", "-qm", msg); }
const lu = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return ""; } };
const injected = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (e) { return ""; } };
// corps d'une section « ## <titre> » du fichier memoire, jusqu'au prochain titre
const section = (mem, titre) => { const m = new RegExp("^## " + titre + "[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))", "m").exec(mem); return m ? m[1] : null; };
const LEGACY = "# MEMOIRE PROJET\n## Taches faites\n- ancien contenu ecrit par Haiku\n## Taches en cours\n- une tache perimee\n";
const TODO = "# TODO\n\n## En cours — fond\n- [ ] tache ouverte A\n- [x] tache finie B\n### sous-titre\n- [ ] tache ouverte C\n\n## Plus tard\n- hors section D\n";
const rows = (n, longue) => Array.from({ length: n }, (_, i) => "| DR-" + String(i + 1).padStart(3, "0") + " | technique | " + (i === n - 1 && longue ? "Question tres longue " + "x".repeat(300) : "Question " + (i + 1) + " ?") + " | « reponse » | 2026-10-04 | round 1 | vivante |").join("\n") + "\n";

// --- 1. Depot complet + ancien resume : faits rebatis, ancien contenu recopie tel quel dans Notes ---
{
  const { INSTALL, PROJ } = setup(enabled);
  git(PROJ, "init", "-q");
  for (let i = 1; i <= 7; i++) commit(PROJ, "commit n" + i);
  fs.writeFileSync(p.join(PROJ, "TODO.md"), TODO);
  fs.writeFileSync(p.join(PROJ, "REGISTRE-DECISIONS.md"), "# Registre\n\n| Ref | Type | Question |\n|---|---|---|\n" + rows(7, true));
  const mem = p.join(PROJ, ".cqr-memory.md");
  fs.writeFileSync(mem, LEGACY);
  fs.writeFileSync(p.join(PROJ, "nouveau.txt"), "x"); // non suivi
  fs.writeFileSync(p.join(PROJ, "f.txt"), "modifie sans commit"); // suivi, modifie

  const r = run(INSTALL, PROJ, "SessionStart");
  const m = lu(mem);
  assert.ok(m.startsWith("# État factuel bâti sans modèle ; les fichiers du projet font foi\n"), "en-tete : " + m.slice(0, 120));
  assert.ok(m.toLowerCase().includes(HEADER), "l'en-tete dit que l'etat est bati sans modele et que les fichiers font foi");

  const commits = section(m, "Derniers commits");
  assert.ok(commits, "section commits presente");
  assert.strictEqual(commits.trim().split("\n").length, 5, "5 derniers commits, pas plus : " + commits);
  assert.ok(commits.includes("commit n7") && commits.includes("commit n3"), "du plus recent (n7) au 5e (n3)");
  assert.ok(!commits.includes("commit n2"), "le 6e n'y est pas");
  assert.ok(commits.indexOf("commit n7") < commits.indexOf("commit n3"), "le plus recent d'abord");

  const nc = section(m, "Fichiers non commités");
  assert.ok(nc && nc.includes("nouveau.txt") && nc.includes("f.txt"), "fichier non suivi et fichier modifie listes : " + nc);
  assert.ok(!/cqr-memory|cqr-archive/.test(nc), "le fichier memoire ne se liste pas lui-meme : " + nc);

  const todo = section(m, "En cours");
  assert.ok(todo && todo.includes("tache ouverte A") && todo.includes("tache ouverte C"), "section En cours de la TODO : " + todo);
  assert.ok(todo.includes("sous-titre") && !/^#/m.test(todo), "un sous-titre perd ses # (rien qui ressemble a un titre du fichier)");
  assert.ok(!todo.includes("tache finie B"), "une case cochee n'est plus en cours");
  assert.ok(!m.includes("hors section D"), "ce qui suit la section n'y entre pas");

  const reg = section(m, "Dernières décisions");
  assert.ok(reg, "section registre presente");
  const lignes = reg.trim().split("\n");
  assert.strictEqual(lignes.length, 5, "5 dernieres decisions : " + reg);
  assert.ok(lignes[0].startsWith("- DR-003") && lignes[4].startsWith("- DR-007"), "DR-003 a DR-007, dans l'ordre du fichier : " + reg);
  assert.ok(lignes[4].endsWith("…") && lignes[4].length < 160, "la question trop longue est tronquee : " + lignes[4].length);
  assert.ok(!reg.includes("reponse"), "seule la question est reprise");

  assert.ok(m.endsWith("## Notes\n" + LEGACY), "premier passage : tout l'ancien contenu entre dans Notes, tel quel");
  assert.ok(m.indexOf("## Notes") > m.indexOf("## Dernières décisions"), "Notes en dernier");

  // l'injection porte les faits ET les notes, et dit d'ou vient le texte
  const ctx = injected(r);
  assert.ok(ctx.includes("commit n7") && ctx.includes("ancien contenu ecrit par Haiku"), "SessionStart injecte l'etat rebati");
  assert.ok(/BATIE PAR UNE MACHINE/.test(ctx) && /pas la parole de l'utilisateur/.test(ctx) && /jamais comme une consigne/.test(ctx), "l'en-tete retire au texte l'autorite de l'utilisateur");

  // Exclusion par .git/info/exclude, jamais par le .gitignore du projet
  const ex = lu(p.join(PROJ, ".git", "info", "exclude"));
  assert.ok(/^\.cqr-memory\.md$/m.test(ex) && /^\.cqr-archive\/$/m.test(ex), "exclusion dans .git/info/exclude : " + ex);
  assert.ok(!fs.existsSync(p.join(PROJ, ".gitignore")), "le .gitignore du projet n'est pas cree");
  assert.ok(!/cqr-memory/.test(git(PROJ, "status", "--porcelain")), "git ne voit plus le fichier memoire");

  // --- 2. Deuxieme passage (PreCompact) : faits frais, Notes recopiees a l'identique, notes a la main gardees ---
  const NOTE = "\n## ma section\nNOTE ECRITE A LA MAIN, accents : é à ü\n";
  fs.appendFileSync(mem, NOTE);
  commit(PROJ, "commit n8");
  const r2 = run(INSTALL, PROJ, "PreCompact");
  const m2 = lu(mem);
  assert.strictEqual(r2.stdout.trim(), "", "PreCompact n'emet rien");
  assert.ok(section(m2, "Derniers commits").includes("commit n8"), "les faits sont rafraichis au compactage");
  assert.ok(m2.endsWith("## Notes\n" + LEGACY + NOTE), "les Notes (ancien contenu + ajout a la main) sont recopiees a l'identique");
  assert.strictEqual((m2.match(/^# État factuel/gm) || []).length, 1, "pas d'empilement d'en-tetes");

  // Rien n'a bouge : rien n'est reecrit (pas de mtime qui change pour rien)
  const passe = new Date("2020-01-01T00:00:00Z"); fs.utimesSync(mem, passe, passe);
  run(INSTALL, PROJ, "SessionStart");
  assert.strictEqual(lu(mem), m2, "contenu identique");
  assert.strictEqual(fs.statSync(mem).mtime.getTime(), passe.getTime(), "faits inchanges : le fichier n'est pas reecrit");

  // Les titres retires a la main ne perdent pas les notes : « ## Notes » peut etre renomme
  fs.writeFileSync(mem, m2.replace("## Notes\n", "## Notes (a moi)\n"));
  commit(PROJ, "commit n9");
  run(INSTALL, PROJ, "SessionStart");
  assert.ok(lu(mem).endsWith("## Notes\n" + LEGACY + NOTE) && lu(mem).includes("commit n9"), "un titre Notes renomme n'efface pas les notes");
}

// --- 3. UserPromptSubmit ne reecrit RIEN et ne lance rien, meme avec le marqueur de bascule (DR-060) ---
{
  const { INSTALL, PROJ } = setup(enabled);
  git(PROJ, "init", "-q"); commit(PROJ, "commit n1");
  const mem = p.join(PROJ, ".cqr-memory.md");
  run(INSTALL, PROJ, "SessionStart");
  const avant = lu(mem);
  commit(PROJ, "commit apres le demarrage");
  // CQR_FAKE_SUMMARY : si l'ancien resume de fond existait encore, il ecraserait le fichier avec ceci
  const r = run(INSTALL, PROJ, "UserPromptSubmit", "sess-2", { CQR_FAKE_SUMMARY: "# MEMOIRE PROJET\n## Taches faites\n- ECRASE PAR UN MODELE" });
  assert.ok(injected(r).includes("commit n1"), "injecte la memoire courante");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); // un enfant de fond aurait eu le temps d'ecrire
  assert.strictEqual(lu(mem), avant, "UserPromptSubmit ne reecrit pas le fichier (ni resume, ni refresh des faits)");
  assert.ok(!lu(mem).includes("ECRASE"), "aucun resume de modele");
  for (const f of [".last", ".lock"]) assert.ok(!fs.existsSync(p.join(PROJ, ".cqr-archive", f)), "plus de " + f + " : plus de travail de fond");
  // et le code ne sait plus appeler un modele
  const src = fs.readFileSync(HOOK, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // le code, sans ses commentaires
  assert.ok(!/haiku|anthropic\.com|\bspawn\b|CQR_FAKE_SUMMARY|require\(".\/lib.js"\)/i.test(src), "memory-hook.js n'a plus d'appel de modele ni de processus de fond");
}

// --- 4. Dossier sans git ---
{
  // 4a. avec une TODO : section TODO seule, aucune exclusion, aucun .gitignore cree
  const { INSTALL, PROJ } = setup(enabled);
  fs.writeFileSync(p.join(PROJ, "TODO.md"), TODO);
  const r = run(INSTALL, PROJ, "SessionStart");
  const m = lu(p.join(PROJ, ".cqr-memory.md"));
  assert.ok(section(m, "En cours").includes("tache ouverte A"), "sans git : la TODO suffit");
  assert.ok(section(m, "Derniers commits") === null && section(m, "Fichiers non commités") === null, "sans git : ni commits ni fichiers non commites");
  assert.ok(m.endsWith("## Notes\n"), "sans ancien contenu : Notes vide");
  assert.ok(injected(r).includes("tache ouverte A"), "et elle est injectee");
  assert.ok(!fs.existsSync(p.join(PROJ, ".git")) && !fs.existsSync(p.join(PROJ, ".gitignore")), "rien d'ecrit cote git");

  // 4b. ni git ni TODO ni registre, mais un ancien resume : notes seules
  const b = setup(enabled);
  fs.writeFileSync(p.join(b.PROJ, ".cqr-memory.md"), LEGACY);
  run(b.INSTALL, b.PROJ, "SessionStart");
  const mb = lu(p.join(b.PROJ, ".cqr-memory.md"));
  assert.strictEqual(mb, "# État factuel bâti sans modèle ; les fichiers du projet font foi\n\n## Notes\n" + LEGACY, "notes seules : en-tete + Notes, rien d'autre");

  // 4c. rien du tout : pas de fichier, rien d'injecte
  const c = setup(enabled);
  const rc = run(c.INSTALL, c.PROJ, "SessionStart");
  assert.ok(!fs.existsSync(p.join(c.PROJ, ".cqr-memory.md")), "aucune source, aucun ancien fichier : pas de fichier cree");
  assert.strictEqual(rc.stdout.trim(), "", "et rien n'est injecte");
  assert.strictEqual(rc.status, 0, "le hook sort toujours en 0");

  // 4d. sous-dossier d'un depot : le depot parent n'est pas le sien (le .git doit etre dans le dossier)
  const d = setup(enabled);
  git(d.T, "init", "-q"); commit(d.T, "commit du parent");
  fs.writeFileSync(p.join(d.PROJ, "TODO.md"), TODO);
  run(d.INSTALL, d.PROJ, "SessionStart");
  const md = lu(p.join(d.PROJ, ".cqr-memory.md"));
  assert.ok(!md.includes("commit du parent") && section(md, "Derniers commits") === null, "les commits d'un depot parent ne passent pas pour ceux du dossier");
  assert.ok(!/cqr-memory/.test(lu(p.join(d.T, ".git", "info", "exclude"))), "et le depot parent n'est pas modifie");
}

// --- 5. .git qui est un FICHIER (worktree) : l'exclusion est posee la ou git la lit, et les faits restent ---
{
  const { T, INSTALL, PROJ } = setup(enabled);
  git(PROJ, "init", "-q"); commit(PROJ, "commit principal");
  const WT = p.join(T, "wt");
  git(PROJ, "worktree", "add", "-q", WT, "-b", "branche-wt");
  assert.ok(fs.statSync(p.join(WT, ".git")).isFile(), "le worktree a bien un fichier .git");
  const excl = p.resolve(WT, git(WT, "rev-parse", "--git-path", "info/exclude").trim()); // le chemin que git lit, pas `.git/info/exclude`
  assert.ok(!/cqr-memory|cqr-archive/.test(lu(excl)), "avant le hook : rien d'exclu");
  fs.writeFileSync(p.join(WT, "TODO.md"), TODO);
  run(INSTALL, WT, "SessionStart");
  run(INSTALL, WT, "UserPromptSubmit", "sess-wt"); // la dedup cree .cqr-archive/ : il faut qu'il existe pour prouver son exclusion
  const m = lu(p.join(WT, ".cqr-memory.md"));
  assert.ok(section(m, "Derniers commits").includes("commit principal"), "les faits git du worktree sont la");
  assert.ok(!/cqr-memory/.test(section(m, "Fichiers non commités")), "le fichier memoire ne se liste pas dans ses propres faits");
  const ex = lu(excl);
  assert.ok(/^\.cqr-memory\.md$/m.test(ex) && /^\.cqr-archive\/$/m.test(ex), "exclusion ecrite dans le fichier que git lit pour ce worktree : " + ex);
  assert.ok(fs.existsSync(p.join(WT, ".cqr-archive", ".injected.json")), "l'archive existe bien (sinon l'epreuve suivante ne prouve rien)");
  assert.ok(!/cqr-memory|cqr-archive/.test(git(WT, "status", "--porcelain")), "git status du worktree ne voit ni le fichier memoire ni l'archive");
  assert.ok(!fs.existsSync(p.join(WT, ".gitignore")), "le .gitignore du projet n'est pas cree");
  assert.ok(fs.statSync(p.join(WT, ".git")).isFile(), ".git du worktree intact");
}

// --- 6. Exclusion : le .gitignore existant n'est pas touche, et rien ne s'ajoute deux fois ---
{
  const { INSTALL, PROJ } = setup(enabled);
  git(PROJ, "init", "-q"); commit(PROJ, "c1");
  const GI = "node_modules/\n# deja la, ajoute par l'ancienne version :\n.cqr-memory.md\n.cqr-archive/\n";
  fs.writeFileSync(p.join(PROJ, ".gitignore"), GI);
  run(INSTALL, PROJ, "SessionStart"); run(INSTALL, PROJ, "PreCompact"); run(INSTALL, PROJ, "SessionStart", "sess-9");
  assert.strictEqual(lu(p.join(PROJ, ".gitignore")), GI, "le .gitignore n'est ni modifie ni nettoye (ce que l'ancienne version y a ajoute reste)");
  const ex = lu(p.join(PROJ, ".git", "info", "exclude"));
  assert.strictEqual((ex.match(/^\.cqr-memory\.md$/gm) || []).length, 1, "une seule ligne pour le fichier memoire apres trois passages : " + ex);
  assert.strictEqual((ex.match(/^\.cqr-archive\/$/gm) || []).length, 1, "une seule ligne pour l'archive");
}

// --- 7. Plafonds : section par section, et injection bornee a ~4 Ko, le fichier jamais tronque ---
{
  const { INSTALL, PROJ } = setup(enabled);
  git(PROJ, "init", "-q");
  for (let i = 1; i <= 7; i++) commit(PROJ, "commit " + "y".repeat(300) + i);
  for (let i = 0; i < 40; i++) fs.writeFileSync(p.join(PROJ, "fichier-non-suivi-" + "z".repeat(150) + i + ".txt"), "x");
  fs.writeFileSync(p.join(PROJ, "TODO.md"), "## En cours\n" + Array.from({ length: 30 }, (_, i) => "- [ ] tache " + i + " " + "w".repeat(500)).join("\n") + "\n");
  fs.writeFileSync(p.join(PROJ, "REGISTRE-DECISIONS.md"), rows(30, true));
  const NOTES = "# gros ancien resume\n" + "ligne de notes assez longue pour peser dans l'injection\n".repeat(400); // ~22 Ko
  const mem = p.join(PROJ, ".cqr-memory.md");
  fs.writeFileSync(mem, NOTES);

  const r = run(INSTALL, PROJ, "SessionStart");
  const m = lu(mem);
  const faits = m.slice(0, m.indexOf("## Notes"));
  assert.ok(faits.length < 3900, "les faits, tous plafonds atteints, restent sous ~4 Ko : " + faits.length);
  assert.ok(/… et 32 autres/.test(section(m, "Fichiers non commités")), "fichiers non commites plafonnes (40 + TODO.md + REGISTRE, 10 montres), avec le reste compte : " + section(m, "Fichiers non commités").split("\n").slice(-2));
  assert.ok(/… et 22 lignes de plus dans TODO.md/.test(section(m, "En cours")), "TODO plafonnee, avec le reste compte");
  assert.ok(m.endsWith("## Notes\n" + NOTES), "le fichier garde TOUTES les notes, a l'identique (" + NOTES.length + " caracteres)");

  const ctx = injected(r);
  const corps = ctx.slice(ctx.indexOf("# État factuel"));
  assert.ok(corps.length <= 4096 + 200, "l'injection est bornee (~4 Ko) : " + corps.length);
  assert.ok(corps.includes("## Notes") && /caracteres non injectes \(notes\)/.test(corps), "les notes sont coupees avec un renvoi vers le fichier");
  assert.ok(corps.includes(mem), "le renvoi donne le chemin du fichier");
}

// --- 8. Une panne de git omet la section, sans casser le reste ---
{
  const { INSTALL, PROJ } = setup(enabled);
  fs.mkdirSync(p.join(PROJ, ".git")); // un .git vide : ce n'est pas un depot, git echoue
  fs.writeFileSync(p.join(PROJ, "TODO.md"), TODO);
  const r = run(INSTALL, PROJ, "SessionStart");
  const m = lu(p.join(PROJ, ".cqr-memory.md"));
  assert.strictEqual(r.status, 0, "le hook sort en 0 meme si git echoue");
  assert.ok(section(m, "Derniers commits") === null && section(m, "Fichiers non commités") === null, "git en echec : sections omises, pas de message d'erreur dans la memoire");
  assert.ok(section(m, "En cours").includes("tache ouverte A"), "les autres sections restent");
  assert.ok(!/fatal|not a git/i.test(m), "aucune erreur de git ne fuit dans le fichier");
}

// --- 9. Inactif (enabled:false) : rien, ni fichier ni sortie ---
{
  const { INSTALL, PROJ } = setup({ enabled: false, dryRun: false });
  git(PROJ, "init", "-q"); commit(PROJ, "c1");
  for (const ev of ["SessionStart", "PreCompact", "UserPromptSubmit"]) {
    const r = run(INSTALL, PROJ, ev);
    assert.strictEqual(r.stdout.trim(), "", "inactif : " + ev + " n'emet rien");
  }
  assert.ok(!fs.existsSync(p.join(PROJ, ".cqr-memory.md")), "inactif : aucun fichier memoire");
}

// --- 10. Dedup d'injection : la memoire ne repart que si elle a CHANGE dans la session ---
// Elle coutait ~730-830 tokens a CHAQUE tour. Le point delicat est la compaction : elle reecrit le
// contexte, donc une memoire "deja injectee" peut en avoir disparu. Le dossier .cqr-archive n'est PAS
// cree a la main ici : sans resume de fond, c'est la dedup elle-meme qui doit le creer.
{
  const { INSTALL, PROJ } = setup(enabled);
  const mem = p.join(PROJ, ".cqr-memory.md");
  const inject = (r) => !!injected(r);

  fs.writeFileSync(mem, TITLE + "\n\n## Notes\npremiere version\n"); // deja au format : SessionStart ne la reecrit pas (rien a y changer)
  assert.ok(inject(run(INSTALL, PROJ, "UserPromptSubmit")), "1er tour : la memoire est injectee");
  assert.ok(fs.existsSync(p.join(PROJ, ".cqr-archive", ".injected.json")), "la dedup cree son dossier toute seule");
  assert.ok(!inject(run(INSTALL, PROJ, "UserPromptSubmit")), "2e tour, contenu inchange : plus rien n'est reinjecte");

  fs.writeFileSync(mem, TITLE + "\n\n## Notes\ndeuxieme version\n");
  assert.ok(inject(run(INSTALL, PROJ, "UserPromptSubmit")), "contenu change : la memoire repart");
  assert.ok(!inject(run(INSTALL, PROJ, "UserPromptSubmit")), "et se tait de nouveau ensuite");

  assert.ok(inject(run(INSTALL, PROJ, "UserPromptSubmit", "sess-2")), "autre session : injectee malgre le meme contenu");
  assert.ok(inject(run(INSTALL, PROJ, "SessionStart")), "SessionStart injecte toujours : le contexte y est neuf");

  // LE point que la greffe d'origine n'avait pas vu.
  assert.ok(!inject(run(INSTALL, PROJ, "UserPromptSubmit")), "(avant compaction : toujours deduplique)");
  run(INSTALL, PROJ, "PreCompact");
  assert.ok(inject(run(INSTALL, PROJ, "UserPromptSubmit")), "apres une compaction, la memoire est REINJECTEE (sinon elle disparait pour toute la session)");

  // et le reglage rend l'injection systematique a qui la veut
  const s2 = setup(Object.assign({}, enabled, { memoryDedup: false }));
  fs.writeFileSync(p.join(s2.PROJ, ".cqr-memory.md"), TITLE + "\n\n## Notes\nx\n");
  assert.ok(inject(run(s2.INSTALL, s2.PROJ, "UserPromptSubmit")), "memoryDedup:false, 1er tour");
  assert.ok(inject(run(s2.INSTALL, s2.PROJ, "UserPromptSubmit")), "memoryDedup:false : injectee a chaque tour, comme avant");
}

// --- 11. SessionStart a deja injecte : le premier prompt de la MEME session ne reinjecte pas ---
// Sans cela, la memoire arrivait deux fois en tete de session (SessionStart, puis le premier prompt).
{
  const { INSTALL, PROJ } = setup(enabled);
  const mem = p.join(PROJ, ".cqr-memory.md");
  const inject = (r) => !!injected(r);
  fs.writeFileSync(mem, TITLE + "\n\n## Notes\nversion A\n"); // deja au format : SessionStart ne la reecrit pas
  assert.ok(inject(run(INSTALL, PROJ, "SessionStart", "sess-A")), "SessionStart injecte");
  assert.ok(!inject(run(INSTALL, PROJ, "UserPromptSubmit", "sess-A")), "1er prompt de la meme session : rien de reinjecte (deja dans le contexte)");
  assert.ok(inject(run(INSTALL, PROJ, "UserPromptSubmit", "sess-B")), "contre-epreuve : une autre session, sans SessionStart, recoit la memoire");
  fs.writeFileSync(mem, TITLE + "\n\n## Notes\nversion B\n");
  assert.ok(inject(run(INSTALL, PROJ, "UserPromptSubmit", "sess-A")), "contenu change depuis le SessionStart : le prompt reinjecte");
  assert.ok(inject(run(INSTALL, PROJ, "SessionStart", "sess-A")), "SessionStart injecte toujours, meme avec une empreinte deja notee");

  // dedup coupee : aucune empreinte notee, injection a chaque tour comme avant
  const s2 = setup(Object.assign({}, enabled, { memoryDedup: false }));
  fs.writeFileSync(p.join(s2.PROJ, ".cqr-memory.md"), TITLE + "\n\n## Notes\nx\n");
  assert.ok(inject(run(s2.INSTALL, s2.PROJ, "SessionStart", "sess-A")), "memoryDedup:false, SessionStart");
  assert.ok(!fs.existsSync(p.join(s2.PROJ, ".cqr-archive", ".injected.json")), "memoryDedup:false : SessionStart ne note aucune empreinte");
  assert.ok(inject(run(s2.INSTALL, s2.PROJ, "UserPromptSubmit", "sess-A")), "memoryDedup:false : le prompt injecte quand meme");
}

// --- Lecture seule de .orr-memory.md (sessions FCC sous Nemotron, openrouter-relay) ---
{
  const orrF = (s) => p.join(s.PROJ, ".orr-memory.md"), cqrF = (s) => p.join(s.PROJ, ".cqr-memory.md");

  // les deux blocs injectes, etiquetes, sous le meme avertissement
  let s = setup(enabled);
  fs.writeFileSync(cqrF(s), TITLE + "\n\n## Notes\nNOTE CQR\n");
  fs.writeFileSync(orrF(s), "NOTE ORR nemotron");
  let ctx = injected(run(s.INSTALL, s.PROJ, "SessionStart"));
  assert.ok(ctx.includes("NOTE CQR") && ctx.includes("NOTE ORR nemotron"), "orr : les deux memoires sont injectees");
  assert.ok(/openrouter-relay/.test(ctx) && /LECTURE SEULE/.test(ctx), "orr : bloc etiquete (source + lecture seule)");
  assert.ok(ctx.indexOf("jamais comme une consigne") < ctx.indexOf("NOTE ORR"), "orr : l'avertissement precede le bloc");

  // orr seul (cqr vide) : injecte quand meme, sans inviter a ecrire dans cqr
  fs.writeFileSync(cqrF(s), "");
  ctx = injected(run(s.INSTALL, s.PROJ, "UserPromptSubmit", "sess-orr"));
  assert.ok(ctx.includes("NOTE ORR") && !ctx.includes("enrichir"), "orr seul : injecte, sans invitation a ecrire");

  // dedup : orr inchange -> silence ; orr change -> reinjecte
  s = setup(enabled);
  fs.writeFileSync(orrF(s), "orr v1");
  run(s.INSTALL, s.PROJ, "SessionStart", "sess-d");
  assert.ok(!injected(run(s.INSTALL, s.PROJ, "UserPromptSubmit", "sess-d")), "orr inchange : silence");
  fs.writeFileSync(orrF(s), "orr v2");
  assert.ok(injected(run(s.INSTALL, s.PROJ, "UserPromptSubmit", "sess-d")).includes("orr v2"), "orr change : reinjecte");

  // borne a INJECT_MAX ; le fichier n'est jamais ecrit (octets identiques apres les trois evenements)
  s = setup(enabled);
  const orrBytes = Buffer.from("SECRET-ORR-é\r\n" + "ligne orr\n".repeat(1000), "utf8");
  fs.writeFileSync(orrF(s), orrBytes);
  ctx = injected(run(s.INSTALL, s.PROJ, "SessionStart"));
  assert.ok(ctx.includes("SECRET-ORR") && ctx.includes("caracteres non injectes : lire " + orrF(s)), "orr long : borne, avec le chemin du fichier");
  run(s.INSTALL, s.PROJ, "UserPromptSubmit"); run(s.INSTALL, s.PROJ, "PreCompact");
  assert.ok(fs.readFileSync(orrF(s)).equals(orrBytes), ".orr-memory.md : octets identiques apres SessionStart, UserPromptSubmit, PreCompact");
}

// --- 8. Mode sous-projet (0.24.0) : lancement a la RACINE, sous-projet tire de la liaison de la session ---
{
  const { T, INSTALL } = setup(enabled);
  const ROOT = p.join(T, "depot"); fs.mkdirSync(ROOT);
  git(ROOT, "init", "-q");
  const PROJETS = p.join(ROOT, "0. MEMORY", "projets");
  const A = p.join(PROJETS, "A"), B = p.join(PROJETS, "B");
  const SRC = p.join(ROOT, "src");
  for (const d of [A, B, SRC]) fs.mkdirSync(d, { recursive: true });
  const fm = (nom, extra) => "---\nprojet: " + nom + "\n" + (extra || "") + "---\n\n# " + nom + "\n";
  fs.writeFileSync(p.join(A, "PROJET.md"), fm("A", 'prefixe: A\nbut: "Faire le travail de A"\ndescriptif: "A court"\nperimetre:\n  - 1. PROJET/a/**\n  - src/a_*.py\n'));
  fs.writeFileSync(p.join(B, "PROJET.md"), fm("B", "perimetre:\n  - 1. PROJET/b/**\n"));
  fs.writeFileSync(p.join(A, "TODO.md"), "# TODO\n\n## En cours\n- [ ] ma tache A\n");
  fs.writeFileSync(p.join(B, "TODO.md"), "# TODO\n\n## En cours\n- [ ] tache secrete de B\n");
  fs.writeFileSync(p.join(A, "REGISTRE-DECISIONS.md"), "| DR-001 | t | Question DR | r |\n| A-001 | t | Question prefixee A | r |\n| B-001 | t | pas a moi | r |\n");
  fs.writeFileSync(p.join(ROOT, "TODO.md"), "# TODO\n\n## En cours\n- [ ] tache de la RACINE\n");
  fs.mkdirSync(p.join(ROOT, "1. PROJET", "a"), { recursive: true }); fs.mkdirSync(p.join(ROOT, "1. PROJET", "b"), { recursive: true });
  fs.writeFileSync(p.join(ROOT, "1. PROJET", "a", "a.txt"), "a1"); fs.writeFileSync(p.join(ROOT, "1. PROJET", "b", "b.txt"), "b1"); fs.writeFileSync(p.join(SRC, "x.py"), "x");
  git(ROOT, "add", "-A"); git(ROOT, "commit", "-qm", "commit initial qui touche A");
  fs.writeFileSync(p.join(ROOT, "1. PROJET", "b", "b.txt"), "b2"); git(ROOT, "commit", "-qam", "commit seulement B");
  fs.writeFileSync(p.join(ROOT, "1. PROJET", "a", "a.txt"), "a2"); git(ROOT, "commit", "-qam", "commit A deux");
  fs.writeFileSync(p.join(ROOT, "1. PROJET", "b", "b.txt"), "b3"); // modification non commitee de B
  fs.writeFileSync(p.join(ROOT, "1. PROJET", "a", "nouveau-a.txt"), "n");
  const lier = (sid, projet) => {
    const d = p.join(PROJETS, ".sessions"); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(p.join(d, sid + ".json"), JSON.stringify({ projet, mode: projet ? "sous-projet" : "racine", le: "2026-10-25T00:00:00Z", vu: "" }));
  };
  const memA = p.join(A, "memoire", ".cqr-memory.md"), memRacine = p.join(ROOT, ".cqr-memory.md");

  // (0) session NON liee : memoire racine, TODO racine, rien ecrit dans le sous-projet
  run(INSTALL, ROOT, "SessionStart", "sess-libre-1");
  const mr = lu(memRacine);
  assert.ok(mr.startsWith(TITLE + "\n"), "non liee : titre ordinaire");
  assert.ok(section(mr, "En cours").includes("tache de la RACINE"), "non liee : TODO de la racine");
  assert.ok(!fs.existsSync(memA), "non liee : rien ecrit dans le sous-projet");

  // (a) session liee : memoire sous 0. MEMORY/projets/A/memoire, commits filtres au perimetre
  lier("sess-sp-1", "A");
  run(INSTALL, ROOT, "SessionStart", "sess-sp-1");
  const m = lu(memA);
  assert.ok(m, "memoire ecrite sous projets/A/memoire/.cqr-memory.md");
  const commits = section(m, "Derniers commits");
  assert.ok(commits, "section commits presente");
  assert.ok(commits.includes("commit A deux") && commits.includes("commit initial"), "commits qui touchent A : " + commits);
  assert.ok(!commits.includes("seulement B"), "un commit qui ne touche que B n'apparait pas : " + commits);
  const nc = section(m, "Fichiers non commités");
  assert.ok(nc.includes("nouveau-a.txt") && !nc.includes("b.txt"), "non commites : ceux de A, pas ceux de B : " + nc);
  assert.strictEqual(lu(memRacine), mr, "la memoire racine n'a pas bouge");

  // TODO, registre, titre du sous-projet
  assert.ok(section(m, "En cours").includes("ma tache A") && !m.includes("RACINE") && !m.includes("secrete"), "TODO du sous-projet seulement");
  const reg = section(m, "Dernières décisions");
  assert.ok(reg.includes("A-001") && reg.includes("DR-001") && !reg.includes("B-001"), "registre : DR- et prefixe A- reconnus, pas B- : " + reg);
  assert.ok(m.startsWith("# État factuel bâti sans modèle — sous-projet A ; les fichiers du projet font foi\n\n**Ton but** : Faire le travail de A\n"), "titre + but : " + m.slice(0, 200));

  // plus de section Voisins
  assert.ok(!/Voisins/.test(m), "plus de section Voisins dans la memoire");

  // exclusion dans le info/exclude de la racine
  const st = git(ROOT, "status", "--porcelain");
  assert.ok(!st.includes(".cqr-memory.md") && !st.includes(".cqr-archive"), "git status de la racine ne liste pas la memoire de A : " + st);
  run(INSTALL, ROOT, "PreCompact", "sess-sp-1");
  assert.strictEqual(lu(p.join(ROOT, ".git", "info", "exclude")).split("**/.cqr-memory.md").length, 2, "exclusion ecrite une seule fois");
  assert.ok(!fs.existsSync(p.join(ROOT, ".gitignore")), "aucun .gitignore cree");
  assert.ok(fs.existsSync(p.join(A, "memoire", ".cqr-archive", ".injected.json")), "dedup/archive sous memoire/");

  // .orr-memory.md lu au meme endroit
  fs.writeFileSync(p.join(A, "memoire", ".orr-memory.md"), "note FCC du sous-projet A");
  fs.writeFileSync(p.join(ROOT, ".orr-memory.md"), "note FCC de la racine");
  const iA = injected(run(INSTALL, ROOT, "SessionStart", "sess-sp-1"));
  assert.ok(iA.includes("note FCC du sous-projet A") && !iA.includes("note FCC de la racine"), ".orr-memory.md du sous-projet, pas celui de la racine");
  assert.ok(!/Voisins/.test(iA), "plus de Voisins dans l'injection");

  // (b) liaison creee en cours de session : le UserPromptSubmit suivant rebatit et injecte la memoire du sous-projet
  run(INSTALL, ROOT, "SessionStart", "sess-tard-1");
  lier("sess-tard-1", "B");
  assert.ok(!fs.existsSync(p.join(B, "memoire", ".cqr-memory.md")), "avant le tour : memoire de B pas encore batie");
  const rB = injected(run(INSTALL, ROOT, "UserPromptSubmit", "sess-tard-1"));
  assert.ok(fs.existsSync(p.join(B, "memoire", ".cqr-memory.md")), "UserPromptSubmit : memoire de B rebatie apres la liaison");
  assert.ok(rB.includes("sous-projet B") && rB.includes("tache secrete de B") && !rB.includes("RACINE"), "injection du sous-projet B : " + rB.slice(0, 300));
  assert.strictEqual(injected(run(INSTALL, ROOT, "UserPromptSubmit", "sess-tard-1")), "", "tour suivant : dedup, rien de plus");
  lier("sess-tard-1", "A"); // la liaison change (B -> A)
  assert.ok(injected(run(INSTALL, ROOT, "UserPromptSubmit", "sess-tard-1")).includes("sous-projet A"), "liaison changee : memoire de A injectee");

  // (c) sous-projet disparu, id hostile, fichier illisible, session_id invalide : mode racine, exit 0
  lier("sess-perdu-1", "Z");
  run(INSTALL, ROOT, "SessionStart", "sess-perdu-1");
  assert.ok(!fs.existsSync(p.join(PROJETS, "Z")), "sous-projet disparu : rien recree");
  lier("sess-evil-01", "../../x");
  run(INSTALL, ROOT, "SessionStart", "sess-evil-01");
  assert.ok(!fs.existsSync(p.join(ROOT, "0. MEMORY", "x")) && !fs.existsSync(p.join(ROOT, "x")), "id hostile refuse");
  fs.writeFileSync(p.join(PROJETS, ".sessions", "sess-casse-1.json"), "{pas du json");
  assert.strictEqual(run(INSTALL, ROOT, "SessionStart", "sess-casse-1").status, 0, "liaison illisible : exit 0");
  assert.strictEqual(run(INSTALL, ROOT, "SessionStart", "../ab").status, 0, "session_id invalide : exit 0, mode racine");
  assert.ok(!/sous-projet/.test(lu(memRacine).split("\n")[0]), "modes racine : la memoire racine n'a pas de titre sous-projet");

  // (d) PROJET.md sans frontmatter : lie mais sans perimetre -> ni commits ni non commites ; la TODO du sous-projet reste lue
  const C = p.join(PROJETS, "C"); fs.mkdirSync(C);
  fs.writeFileSync(p.join(C, "PROJET.md"), "# C sans frontmatter\n"); fs.writeFileSync(p.join(C, "TODO.md"), TODO);
  lier("sess-c-0001", "C");
  run(INSTALL, ROOT, "SessionStart", "sess-c-0001");
  const mc = lu(p.join(C, "memoire", ".cqr-memory.md"));
  assert.ok(!section(mc, "Derniers commits") && !section(mc, "Fichiers non commités") && section(mc, "En cours"), "sans perimetre : pas de git, TODO lue");

  // (e) contre-epreuve : sans lecture de la liaison, (a) echoue
  const NEUTRE = p.join(T, "hook-neutre.js");
  const src = fs.readFileSync(HOOK, "utf8");
  assert.ok(src.includes("function subprojet(cwd, sid) {"), "point d'ancrage de la contre-epreuve");
  fs.writeFileSync(NEUTRE, src.replace("function subprojet(cwd, sid) {", "function subprojet(cwd, sid) { return null;"));
  fs.unlinkSync(memA);
  cp.spawnSync(process.execPath, [NEUTRE], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: ROOT, session_id: "sess-sp-1" }),
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: undefined }, { CQR_DIR: INSTALL }), encoding: "utf8",
  });
  assert.ok(!fs.existsSync(memA), "contre-epreuve : sans mode sous-projet, la memoire de A n'est pas ecrite");
  run(INSTALL, ROOT, "SessionStart", "sess-sp-1");
  assert.ok(section(lu(memA), "Derniers commits"), "mode restaure : la memoire de A revient");
  if (process.env.CQR_DUMP_EXEMPLE) console.log(lu(memA));
}

// --- CLAUDE_PROJECT_DIR : dossier de lancement ; le cwd du payload suit le `cd` du shell ---
{
  const { INSTALL, PROJ } = setup(enabled);
  const sous = p.join(PROJ, "sous"); fs.mkdirSync(sous);
  fs.writeFileSync(p.join(PROJ, "TODO.md"), TODO); fs.writeFileSync(p.join(sous, "TODO.md"), TODO);
  run(INSTALL, sous, "SessionStart", "sess-env", { CLAUDE_PROJECT_DIR: PROJ });
  assert.ok(fs.existsSync(p.join(PROJ, ".cqr-memory.md")) && !fs.existsSync(p.join(sous, ".cqr-memory.md")), "CLAUDE_PROJECT_DIR : memoire dans le dossier de session, pas dans le cwd du payload");
  run(INSTALL, sous, "SessionStart", "sess-env2", {});
  assert.ok(fs.existsSync(p.join(sous, ".cqr-memory.md")), "sans CLAUDE_PROJECT_DIR : repli sur le cwd du payload");
}

for (const T of roots) { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) {} }
console.log("PASS — memory-hook.js (0.21.0, sans modele) : faits git/TODO/registre rebatis a SessionStart et PreCompact, Notes recopiees a l'identique (premier passage = ancien contenu), UserPromptSubmit ne reecrit rien, dossier sans git / sous-dossier / worktree / .git casse, exclusion par info/exclude (chemin resolu par git : worktree compris) sans toucher .gitignore, plafonds, dedup + reinjection apres compaction, SessionStart note l'injection, .orr-memory.md injecte en lecture seule, mode sous-projet 0.24.0 (liaison de session, memoire sous 0. MEMORY/projets/<id>/memoire, commits/non commites filtres au perimetre, TODO et registre du sous-projet, rebatissage au UserPromptSubmit apres liaison, plus de Voisins, contre-epreuve)");
