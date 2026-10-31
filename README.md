# claude-quota-relay (`cqr`)

English · [Français](README.fr.md)

## What it is for

You have several Claude subscriptions, but Claude Code only uses one of them. When its quota runs out, everything stops:

```
API Error: Request rejected (429) · This request would exceed your account's rate limit.
```

`cqr` is a small program that runs on your computer, between Claude Code and Anthropic. It uses your accounts in turn. When one is full, it moves to the next. When all are full, it waits for a quota to free up, then carries on by itself, even in the middle of a long task. You see nothing: it just keeps going.

An image: it is a switchboard. Claude Code always dials the same number (your computer); the switchboard forwards the call to whichever account can answer.

Independent, free project, not affiliated with Anthropic. Only use accounts that belong to you, in line with Anthropic's terms.

## How it works

```
Claude Code  ->  cqr (127.0.0.1:8787, your computer)  ->  Anthropic
                  |  picks the least loaded account
                  |  switches account when one is refused
                  |  waits when every account is full
```

During installation, `cqr` edits Claude Code's `~/.claude/settings.json` so that Claude Code talks to `127.0.0.1:8787` (an address that means your own computer) instead of talking to Anthropic directly. For each request, `cqr` swaps in the key of the chosen account, then forwards the request.

## Security: what cqr does (and does not do)

You hand this program login keys for your accounts. It is normal to want to know what it does with them.

- **Your keys stay on your computer**, in a single file: `tokens.json`, in `~/.claude/claude-quota-relay/`. The file is ignored by git (it cannot be published by mistake). Logs always mask keys, and `cqr` never prints them in full.
- **It only listens on `127.0.0.1`**, meaning your computer alone. Nobody else on your network can connect to it.
- **It only talks to three destinations**: Anthropic (`api.anthropic.com`), the company relay you specify yourself (the `ANTHROPIC_TARGET_API_URL` variable, see [Company network](#company-network)), and `openrouter.ai` only if you turn on free compaction (off by default, see [below](#free-compaction-optional-off-by-default)).
- **No telemetry**, no statistics sent to the author, no account to create with the author.
- **The code is short and readable**: about 4,700 lines of JavaScript, with no dependency to install. You can check for yourself:

```bash
# Which files open a connection to the outside? (only proxy.js and free-compact.js)
grep -n 'require("https")' src/*.js

# Which outside addresses are written in the code?
grep -n "api.anthropic.com\|openrouter.ai" src/*.js
```

Honest caveat: a key stored in a file can be read by any program running under your user account. This is true of every key stored on a computer; protect your session as usual.

## Install

**You need:** [Node.js](https://nodejs.org) version 18 or later, `git`, and Claude Code already installed.

1. Download the project and run the installer:

   ```bash
   git clone https://github.com/DamienLTY/claude-quota-relay.git
   cd claude-quota-relay
   node src/install.js
   ```

   The installer copies the files into `~/.claude/claude-quota-relay/`, adds the `cqr` command to your PATH (the list of folders where the terminal looks for commands), sets up `settings.json`, adds the status bar, and asks for your accounts. It backs up `settings.json` before changing it.

2. **Give the key of each account.** For each one, the installer asks: *browser* or *paste*?
   - **Browser** (easiest): a window opens, you sign in to that Claude account, and the key is fetched automatically.
   - **Paste**: type `paste`, then paste a key you already have (it starts with `sk-ant-oat01-`; you get one with the `claude setup-token` command). Handy if your browser is locked down.

   You can also add an account later: `cqr add`.

3. **Restart Claude Code.**
4. Open a **new** terminal (so that `cqr` is recognized).

> **The most common trap.** Your accounts must be really different (two subscriptions, two e-mail addresses). If you create two keys while signed in to the same Claude account, they are two keys of the same account: same quota, so switching is useless. See [troubleshooting](#my-two-accounts-always-show-the-same-quota).

### Check that it works

```bash
cqr status
```

You should see `Proxy : EN COURS` (running) and one line per account:

```
Proxy   : EN COURS (port 8787)
Actif   : compte-1
 > [0] compte-1   on  quota:5h=42% 7d=25%  reset5h~4h05
   [1] compte-2   on  quota:5h=9%  7d=1%   reset5h~4h05
```

For each account, these are the quota used over 5 hours and over 7 days, and the time of the next reset. If you see `ARRÊTÉ` (stopped), go to [troubleshooting](#cqr-status-says-stopped-even-after-cqr-start). Then simply start Claude Code: the status bar (see below) shows your accounts.

With no account at all, `cqr` is installed but switched off: it starts when you add the first account.

## Day to day

One command to remember: `cqr status`. `cqr help` lists all the others.

```bash
cqr list                     # list accounts (keys masked)
cqr add [name]               # add an account (browser, or --paste to paste)
cqr login <name>             # reconnect an account
cqr set <name> <key>         # set a key directly, no questions
cqr remove <name>            # remove an account
cqr start | stop | restart   # manage the program (stop = deliberate stop, the status bar will not restart it)
cqr use <name>               # force one account; if it is refused (429), cqr moves to an account that has quota
cqr bascule <name>           # switch to this account without pinning it (also in Claude Code: /auth-use)
cqr auto                     # back to automatic choice
```

Settings take effect immediately, with no restart. Only the port and the status bar refresh rate restart the program, and `cqr` does it for you.

The main setting: at what quota percentage to change account.

```bash
cqr policy                   # show the settings
cqr policy waitsoft 85       # start waiting at 85% instead of going all the way to 100%
```

## What works on its own

**Switching and waiting.** For each request, `cqr` picks the least loaded account. If an account is refused, it moves to the next. If all are full, it keeps the request open: Claude Code only thinks the answer is slow, then it resumes at the reset.

**Temporary outages.** If Anthropic is overloaded (error 529) or down (error 500), `cqr` retries at growing intervals for 15 minutes before handing you the error. If your connection drops (sleep, Wi-Fi, a VPN reconnecting), it holds the request and retries for up to 60 minutes. A response cut off halfway is cut cleanly so that Claude Code redoes it.

**Auto-compaction (on by default).** When `cqr` changes account, it lightens the request sent to the new account: it asks Anthropic to clear the old tool results from the conversation (an official feature that costs no tokens). The fresh account fills up much more slowly. Nothing is lost: Claude Code keeps its whole history locally, only what goes over the network is lightened. Switch point per model: Fable 85%, Opus 89%, Sonnet 90%, Haiku 95%.

```bash
cqr compact                    # show the state and settings
cqr compact off                # turn everything off
cqr compact threshold opus 89  # change a model's threshold
```

`cqr` also builds a small `.cqr-memory.md` file at the root of your project (latest commits, modified files, the "In progress" section of `TODO.md`), which Claude rereads at the start of a session and after a compaction. No model is called to build it. `cqr compact off` turns it off too.

### The status bar

Always visible in Claude Code, it shows the quota of all your accounts, one line per account (5 hours on the left, 7 days on the right):

```
↻ 19h30 ② │
│ ①  5h/ 37% ████░░░░░░ ██████░░░░ 7J/ 64% │
│ ②  5h/100% ██████████ █████████░ 7J/ 88% │
```

The account number changes colour: green (in use), yellow (in reserve), orange (5h exhausted, comes back at its reset), red (nothing left before the weekly reset). The time after `↻` is the next useful reset. If you already had a status bar, yours is kept and ours is added next to it.

It updates on each exchange with Claude Code, not continuously: at rest, `cqr` makes no request. For continuous checking: `cqr live 120` (every 120 s); `cqr live off` to go back to the default.

### Extra usage credits (off by default)

If Anthropic gave or sold you "extra usage" credits, your account can keep answering once the plan is used up, **at the expense of those credits**. Since they can be billed, `cqr` only uses them if you ask:

```bash
cqr credits              # do I have credits? how many are left?
cqr credits on           # allow them when NO account has plan quota left
cqr credits budget 20 EUR  # give the amount of your credits, to see the money left
cqr credits max 50       # use only half, then go back to waiting
cqr credits off          # back to waiting for the reset
```

Once allowed, the status bar ends with a badge: green `crédits ●` (served on credits), yellow `◐` (normal plan, credits in reserve), red `○` (nothing usable left). Credits are never used while a free plan quota is available. If `cqr credits` says "indisponibles" (unavailable), extra usage is disabled on your account: turn it on at [claude.ai/settings/usage](https://claude.ai/settings/usage).

### The "workflow" safeguard

Claude Code's Workflow tool (which launches many sub-agents at once) gives up on a stuck sub-agent after about 18 minutes, and `cqr` cannot extend that delay. So before a big workflow, a warning appears if the quota is too tight.

```bash
cqr preflight       # is it safe to start a workflow now?
cqr guard ask       # (default) ask for confirmation when risky
cqr guard off       # turn the warning off
```

## Free compaction (optional, off by default)

When Claude Code compacts a long conversation (automatically, or with `/compact`), Claude normally writes the summary, which uses quota. This option has the summary written by a free model, NVIDIA's **Nemotron**, through the OpenRouter service. On the slightest failure, Claude takes over and writes the summary normally.

> **Know this before turning it on.**
> - **You need an OpenRouter key.** It is free: create it at <https://openrouter.ai/keys>.
> - **This is the only `cqr` feature that sends your conversation text to a third party**: your messages, the commands Claude ran and their results go to NVIDIA, through OpenRouter. The system prompt, the tool list and Claude's internal reasoning are not sent.
> - **Terms of the free offer** (read on 5 October 2026): trial use, not for production; confidential or sensitive data is forbidden; NVIDIA may reuse what is sent and generated to improve its products. What you send may therefore be kept and reused.
> - **Do not turn this on for a confidential machine or project.**

Before sending, `cqr` masks what it recognizes: tokens and passwords (Anthropic, GitHub, AWS, OpenAI/OpenRouter keys, `Authorization` headers, private keys, `password=`, etc.) are replaced by `[SECRET-MASQUE]`, permanently; your home folder, your user name and the names you add are replaced by a placeholder, then restored in the summary you receive. This filter relies on known patterns: **a secret of an unknown shape would get through**. When in doubt it masks too much rather than too little.

**Step by step:**

```bash
cqr compact gratuit cle <your OpenRouter key>   # save the key
cqr compact gratuit on                          # turn the option on (immediate)
cqr compact gratuit status                      # check the state (the key is never shown in clear)
```

- The key is stored in the same local `tokens.json` file as your accounts. To erase it: `cqr compact gratuit cle off`.
- If the `OPENROUTER_API_KEY` environment variable exists, **it takes priority** over the saved key.
- Careful: the command `cqr compact gratuit cle <key>` stays in your terminal history. To avoid that, use the `OPENROUTER_API_KEY` variable instead, or delete that line from the history.
- To turn the option off: `cqr compact gratuit off`. To mask extra names (first name, nickname, company): `cqr compact gratuit noms "name,nickname"` (at least 3 characters each).

Only automatic and manual (`/compact`) compactions go through this path; emergency compactions stay with Claude. `proxy.log` records each case on one line (`COMPACT-GRATUIT ok…` or `repli…`), never the content. Advanced settings (model, timeout) are in the `compaction.free` block of `tokens.json`.

## Troubleshooting

### My two accounts always show the same quota

Your two keys probably come from the same Claude account. Check, without spending quota, for each key:

```bash
curl -s -D - -o /dev/null -X POST https://api.anthropic.com/v1/messages/count_tokens \
  -H "authorization: Bearer YOUR_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}' | grep -i organization-id
```

(On a company network, replace `https://api.anthropic.com` with your relay.)

- **Different** `Organization-Id` values: two real accounts, all good.
- **Identical** `Organization-Id` values: it is the same account. Sign in at <https://claude.ai>, sign out completely, sign back in with the other account, then run `claude setup-token` again. Set the new key with `cqr set <name> <key>`.

### `cqr status` says STOPPED even after `cqr start`

The program crashed at startup; `cqr start` shows the cause. The most common ones:

- **The port is already taken** (`EADDRINUSE` message): another program (for example `wrangler dev`) uses port 8787. Change it: `cqr policy port 8788`, then restart Claude Code, which reads the port at startup.
- **A file is missing or damaged**: run `node src/install.js` again.
- **A corporate antivirus** blocks background programs: run it in the foreground to see the error, `node ~/.claude/claude-quota-relay/proxy.js`.

The detailed log is `~/.claude/claude-quota-relay/proxy.log`.

### Company network

If `api.anthropic.com` is blocked where you are and you go through a relay of your own (a Cloudflare Worker, for example), put its address in `settings.json`, under the `ANTHROPIC_TARGET_API_URL` variable. `cqr` uses it everywhere automatically. Then: `cqr restart`.

### `Request timed out · attempt N/10`

A timeout setting is missing from `settings.json`. Run `node src/install.js` again: it puts them back.

## Reference

### Update

```bash
cd claude-quota-relay
git pull
node src/install.js
```

Safe: your keys, port and settings are kept, hooks and the status bar are never duplicated, `settings.json` is backed up before any change. Restart Claude Code afterwards.

### The config file

Everything is in `~/.claude/claude-quota-relay/tokens.json` (the `.claude` folder may be elsewhere if you set the `CLAUDE_CONFIG_DIR` variable):

```jsonc
{
  "port": 8787,
  "switchAtPercent": 94,       // 5h % beyond which another account is preferred
  "sevenDayBlockPercent": 99,  // never use an account beyond this % over 7 days
  "waitAtSoftPercent": null,   // null = use up to 100% before waiting
  "maxWaitMs": 604800000,      // maximum wait for a request (7 days)
  "serverErrorMaxMs": 900000,  // retry duration on an Anthropic outage (15 min; 0 = off)
  "livePollMs": 0,             // continuous checking (0 = off)
  "tokens": [
    { "name": "compte-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "compte-2", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

The `compaction`, `workflowGuard` and `overage` (credits) blocks are added automatically; set them with `cqr` commands rather than by hand.

### The timeouts (why waiting works)

Holding a request for several hours only works thanks to these variables, set by the installer in `settings.json`:

| Variable | Value | Role |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | sends Claude Code through `cqr` |
| `API_TIMEOUT_MS` | 7 days | maximum duration of a request |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 days | the most important: without it, any waiting request dies after 5 min |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 days | lets sub-agents wait too |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 min | low-level safeguard |
| `CLAUDE_CODE_MAX_RETRIES` | 15 | Claude Code attempts if `cqr` stops answering (about 6 min) |

The installer also sets the status bar to check every 10 s that `cqr` is running, and to restart it if it died (except after `cqr stop`).

### Limits

- A non-streaming request landing right at full saturation may be cut and replayed.
- If the computer goes to sleep during a wait, Claude Code cuts its request on wake-up and redoes it; `cqr` holds it again. Beyond 60 minutes without reaching Anthropic, the error is passed on.
- The 7-day protection only kicks in after the account's first response.
- The Workflow tool has its own delay (about 18 min per sub-agent) that `cqr` cannot extend: start a big workflow when at least one account has quota (`cqr preflight`).

### Uninstall

```bash
node src/uninstall.js          # removes cqr's settings, keeps tokens.json and the cqr command
node src/uninstall.js --purge  # removes everything, including tokens.json and the cqr command
```

Uninstalling stops `cqr`, removes its variables and hooks from `settings.json`, restores your original status bar if you had one, and deletes the `/auth*` commands. A backup of `settings.json` is kept. Restart Claude Code afterwards: it goes back to a direct connection.

## License

MIT, see [LICENSE](LICENSE).
