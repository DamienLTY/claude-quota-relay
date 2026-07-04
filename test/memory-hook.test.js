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
    input: JSON.stringify({ hook_event_name: event, cwd: PROJ, transcript_path: TR }),
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

console.log("PASS — memory-hook.js: refresh+inject, dedup, archive, SessionStart inject, inactive no-op");
