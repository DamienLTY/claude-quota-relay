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

// --- Case 1: UserPromptSubmit with a fresh marker -> refresh memory + inject it ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const r = run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "# MEMOIRE PROJET\n## Taches faites\n- lu les sources");
  const memFile = p.join(PROJ, ".cqr-memory.md");
  assert.ok(fs.existsSync(memFile), "memory file created on refresh");
  assert.ok(fs.readFileSync(memFile, "utf8").includes("lu les sources"), "memory has the (faked) summary");
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, "UserPromptSubmit", "injects for the right event");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("lu les sources"), "injected context contains the memory");
  const last = JSON.parse(fs.readFileSync(p.join(PROJ, ".cqr-archive", ".last"), "utf8"));
  assert.strictEqual(last.at, 1000, "marker consumed (last.at = marker.at)");
}

// --- Case 2: marker dedup — running again with the same marker does NOT refresh ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "FIRST SUMMARY");
  const memFile = p.join(PROJ, ".cqr-memory.md");
  assert.ok(fs.readFileSync(memFile, "utf8").includes("FIRST SUMMARY"), "first run wrote FIRST");
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "SECOND SUMMARY");
  assert.ok(fs.readFileSync(memFile, "utf8").includes("FIRST SUMMARY"), "dedup: same marker.at -> no re-summarize");
  assert.ok(!fs.readFileSync(memFile, "utf8").includes("SECOND SUMMARY"), "second summary NOT applied");
}

// --- Case 3: archive — an existing memory file is archived before overwrite ---
{
  const { INSTALL, PROJ, TR } = setup(enabled);
  const memFile = p.join(PROJ, ".cqr-memory.md");
  fs.writeFileSync(memFile, "ANCIENNE MEMOIRE");
  run({}, INSTALL, PROJ, TR, "UserPromptSubmit", "NOUVELLE MEMOIRE");
  assert.ok(fs.readFileSync(memFile, "utf8").includes("NOUVELLE MEMOIRE"), "memory updated");
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
  run({ CQR_RECORD_TOKEN_TO: recordFile }, INSTALL, PROJ, TR, "UserPromptSubmit", "MEM");
  const usedToken = fs.readFileSync(recordFile, "utf8");
  assert.strictEqual(usedToken, TOK_OLD, "compaction Haiku call uses the OLD account's token, not the fresh one's");
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
  run({ CQR_RECORD_TOKEN_TO: recordFile }, INSTALL, PROJ, TR, "UserPromptSubmit", "MEM");
  const usedToken = fs.readFileSync(recordFile, "utf8");
  assert.strictEqual(usedToken, TOK_FRESH, "old account genuinely blocked -> falls back to the freshest account");
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

console.log("PASS — memory-hook.js: refresh+inject, dedup, archive, SessionStart inject, inactive no-op, dedup par session + reinjection apres compaction, old-account-preferred-for-compaction");
