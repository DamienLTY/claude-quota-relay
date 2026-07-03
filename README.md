# claude-quota-relay

**A tiny local proxy that lets Claude Code rotate between several Claude subscription accounts — and, when everything is rate-limited, transparently _waits_ for the 5‑hour window to reset instead of failing.** Your long tasks, subagents and workflows keep going. You never have to type "continue" again.

- 🔁 **Failover** across 2+ Claude accounts (per-request, automatic).
- ⏳ **Wait-and-resume** when all accounts are throttled — the request is _held_ until a quota window resets, then completes on its own.
- 🧠 **Quota-aware** — reads Anthropic's real rate-limit headers (`5h` / `7d` utilization) and prefers the freshest account.
- 🖥️ **Cross-platform**, zero dependencies (pure Node), ~400 lines you can read.
- 🔒 Your tokens stay **local**. Nothing is sent anywhere except `api.anthropic.com`.

> Not affiliated with Anthropic. Use accounts you own, within Anthropic's terms.

---

## Why

Claude Code authenticates from a single `ANTHROPIC_AUTH_TOKEN` read **once at startup**. If you have two subscriptions, you can't hot-swap between them, and when you hit the 5‑hour limit your task just dies with:

```
API Error: Request rejected (429) · This request would exceed your account's rate limit.
```

`apiKeyHelper` doesn't help (subscription `sk-ant-oat01-*` tokens are rejected when sent as `x-api-key`). The only thing that works is a **local proxy** that rewrites the `Authorization: Bearer` header per request. That's this project.

## How it works

Claude Code → `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (the proxy) → `api.anthropic.com`.

For every request the proxy:
1. Picks the best account (lowest 5h utilization, with hysteresis to avoid flapping) and rewrites the `Authorization` header with that account's token.
2. Reads the response's `anthropic-ratelimit-unified-*` headers to track each account's real 5h/7d usage.
3. On a `429`/reject, replays the request on another fresh account.
4. If **everything** is throttled, it **holds the connection open** (sending SSE keepalive comments so Claude Code doesn't give up) until the nearest window resets, then forwards — Claude Code just thinks the server was slow and resumes.

Claude Code sessions see none of this.

## Install

Requirements: **Node ≥ 18** and **Claude Code CLI** already installed.

```bash
git clone https://github.com/<you>/claude-quota-relay.git
cd claude-quota-relay
node src/install.js
```

The installer will:
- copy the proxy into `~/.claude/claude-quota-relay/`,
- ask for your account tokens (see below),
- patch `~/.claude/settings.json` (with a backup) to route Claude Code through the proxy, set the timeouts that make "wait-and-resume" work, and add a `SessionStart` hook that auto-starts the proxy.

Then **restart Claude Code**. That's it.

### Getting your tokens

Run this **once per account** (log into a different Claude account between each run):

```bash
claude setup-token
```

It prints a long-lived `sk-ant-oat01-…` token. Give one per account to the installer (or add them later with `cqr set <name> <token>`).

## Usage

The installer prints an `alias cqr=…` line — add it to your shell profile so `cqr` works anywhere. Then:

```bash
cqr status                 # proxy state, per-account quota (5h/7d), resets, current wait
cqr list                   # list accounts (tokens masked)
cqr use <name|index>       # PIN an account (force it, ignore rules+wait)
cqr auto                   # back to automatic failover
cqr set <name> <token>     # add/replace an account's token
cqr policy                 # show routing policy
cqr policy waitsoft 85     # start waiting at 85% instead of consuming up to 100%
cqr start | stop | restart # manage the proxy process
```

## The timeouts (why the wait actually works)

Holding a request for minutes/hours only works because the installer sets these in `settings.json` → `env`. If you ever see `Request timed out · attempt N/10`, one of these is missing:

| Variable | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | routes Claude Code through the proxy |
| `API_TIMEOUT_MS` | 7 days | overall request timeout |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 days | **the important one** — the CLI's *semantic* stream-idle watchdog defaults to a hard **5‑minute** floor that SSE keepalive does **not** reset. Left at default, any held request dies at 5 min. |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 days | lets **subagents** wait too (defaults to 3 min) |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 min | byte-level dead-connection guard; the proxy's 20 s keepalive keeps it satisfied |

## Configuration

`~/.claude/claude-quota-relay/tokens.json`:

```jsonc
{
  "port": 8787,
  "switchAtPercent": 94,       // prefer an account below this 5h %
  "sevenDayBlockPercent": 99,  // never route to an account above this 7d %
  "waitAtSoftPercent": null,   // null = use the 90–100% margin before waiting; a number = wait from that %
  "maxWaitMs": 604800000,      // cap on how long a request may be held (7 days)
  "pollMs": 15000,             // re-evaluation cadence while waiting
  "tokens": [
    { "name": "account-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "account-2", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

## Security

- `tokens.json`, `state.json` and logs are **git-ignored** — never commit them.
- Tokens live only on your machine; the proxy listens on `127.0.0.1` only.
- Logs redact tokens.

## Limitations (honest)

- **Rare non-streaming requests** can't get keepalive; if they land mid-outage they may be cut and retried.
- If the **machine sleeps** during a long wait, the socket can drop; Claude Code retries on wake.
- The 7‑day guard for an account only arms **after** the proxy has seen one response from it.
- The proxy holds requests on **one** connection; extremely long waits (hours) work but are best smoothed with `cqr policy waitsoft 85`.

## Uninstall

```bash
node src/uninstall.js          # removes env vars + hook (keeps a settings.json backup), keeps tokens.json
node src/uninstall.js --purge  # also delete the install dir + tokens.json
```

Restart Claude Code afterwards.

## License

MIT — see [LICENSE](LICENSE).
