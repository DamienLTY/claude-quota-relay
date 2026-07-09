// `cqr set` adds/overwrites a token; `cqr remove` drops one by name (a non-dev user shouldn't
// hand-edit tokens.json to clean up duplicate accounts). Run: node test/accounts.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const SRC = p.join(__dirname, "..", "src");
const FAKE = "sk-ant-oat01-FAKE-TEST-TOKEN-not-real-000000";

const DIR = fs.mkdtempSync(p.join(os.tmpdir(), "cqr-acct-"));
for (const f of ["cli.js", "lib.js", "compaction.js"]) fs.copyFileSync(p.join(SRC, f), p.join(DIR, f));
fs.writeFileSync(p.join(DIR, "tokens.json"), JSON.stringify({ port: 8787, tokens: [{ name: "1", token: FAKE, enabled: true }, { name: "2", token: FAKE, enabled: true }] }));

const run = (...args) => cp.spawnSync(process.execPath, [p.join(DIR, "cli.js"), ...args], { encoding: "utf8", windowsHide: true });
const conf = () => JSON.parse(fs.readFileSync(p.join(DIR, "tokens.json"), "utf8"));

// remove an existing account
let r = run("remove", "1");
assert.strictEqual(r.status, 0, "remove exits 0: " + r.stderr);
assert.deepStrictEqual(conf().tokens.map((t) => t.name), ["2"], "account '1' removed, '2' kept");

// removing a non-existent account fails clearly, changes nothing
r = run("remove", "nope");
assert.strictEqual(r.status, 1, "remove unknown exits 1");
assert.ok(/Aucun compte/.test(r.stderr), "explains not found: " + r.stderr);
assert.deepStrictEqual(conf().tokens.map((t) => t.name), ["2"], "config untouched on failed remove");

// alias rm works too
run("set", "3", FAKE);
assert.deepStrictEqual(conf().tokens.map((t) => t.name), ["2", "3"], "set adds a new account");
r = run("rm", "3");
assert.strictEqual(r.status, 0, "rm alias exits 0");
assert.deepStrictEqual(conf().tokens.map((t) => t.name), ["2"], "rm alias removed '3'");

fs.rmSync(DIR, { recursive: true, force: true });
console.log("PASS — cqr set/remove: add, remove by name, unknown fails cleanly, rm alias");
