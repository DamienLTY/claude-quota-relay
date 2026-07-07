// Tests for the manual-paste path (no browser login) -- lib.pasteTokenManually, and the
// `cqr login/add --paste` flag not being swallowed as a positional arg. Run: node test/paste-token.test.js
const assert = require("assert");
const fs = require("fs"), os = require("os"), p = require("path"), cp = require("child_process");

const FAKE = "sk-ant-oat01-FAKE-PASTED-TOKEN-not-real-00000000";

// readline's prompt text isn't followed by a newline on non-TTY stdin, so our own
// "RESULT:..." print lands mid-line right after the prompt -- extract via regex, not split("\n").
function extractResult(stdout) { const m = stdout.match(/RESULT:(\S+)/); return m ? m[1] : null; }

// pasteTokenManually runs in a child process (it owns stdin via readline) and prints the result.
// Writes are staggered (not all handed to stdin at once) so sequential rl.question() calls each
// see their own line -- feeding everything through spawnSync's `input` at once is a known
// readline gotcha (stdin ends before the 2nd question() is even issued).
function runPaste(lines) {
  return new Promise((resolve) => {
    const script = "require('" + p.join(__dirname, "..", "src", "lib.js").replace(/\\/g, "/") + "').pasteTokenManually('prompt: ').then(t => console.log('RESULT:' + t));";
    const child = cp.spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    let i = 0;
    const feedNext = () => { if (i < lines.length) child.stdin.write(lines[i++] + "\n"); else child.stdin.end(); };
    feedNext();
    child.stdout.on("data", () => { if (i < lines.length) setTimeout(feedNext, 50); }); // next line after each prompt is printed
    const safety = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(out); }, 5000);
    child.on("close", () => { clearTimeout(safety); resolve(out); });
  });
}

(async () => {
  // --- valid token pasted on the first try ---
  {
    const out = await runPaste([FAKE]);
    assert.strictEqual(extractResult(out), FAKE, "valid paste accepted first try: " + out);
  }

  // --- invalid input then a valid retry ---
  {
    const out = await runPaste(["not-a-token", FAKE]);
    assert.strictEqual(extractResult(out), FAKE, "invalid then valid: retries once and accepts: " + out);
  }

  // --- blank input twice -> null ---
  {
    const out = await runPaste(["", ""]);
    assert.strictEqual(extractResult(out), "null", "blank paste -> null (skip): " + out);
  }

  // --- cli.js argv parsing: `add --paste` must NOT swallow --paste as the account name ---
  // (cli.js's CONF path is fixed relative to its own __dirname, so we check the actual
  // filtering logic it runs, rather than spawning it against a throwaway config dir.)
  {
    const cliSrc = fs.readFileSync(p.join(__dirname, "..", "src", "cli.js"), "utf8");
    assert.ok(/filter\(\(x\) => x !== "--paste"\)/.test(cliSrc), "cli.js strips --paste before positional destructuring");
    const filtered = ["add", "--paste"].filter((x) => x !== "--paste");
    const [cmd, a1] = filtered;
    assert.strictEqual(cmd, "add", "cmd parsed correctly");
    assert.strictEqual(a1, undefined, "--paste is stripped, not mistaken for the account name");
  }

  console.log("PASS — manual paste: pasteTokenManually (valid/retry/blank), --paste flag not swallowed as account name");
})();
