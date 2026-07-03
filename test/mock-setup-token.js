// Test double for `claude setup-token`: prints a realistic block ending with a (FAKE) token.
const tok = process.env.MOCK_TOKEN || "sk-ant-oat01-FAKE-FOR-AUTOMATED-TESTS-ONLY-not-a-real-token-000";
process.stdout.write("\nClaude Code — long-lived token setup\nOpening browser for login...\n");
setTimeout(() => {
  process.stdout.write("Claude Code login successful.\n\nSuccess! Your long-lived token:\n\n  " + tok + "\n\n");
  process.exit(0);
}, 100);
