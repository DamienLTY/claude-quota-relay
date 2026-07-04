#!/usr/bin/env node
"use strict";
/* claude-quota-relay — workflow quota guard (PreToolUse hook on the `Workflow` tool).
 *
 * The Workflow tool fans out many parallel sub-agents, each with an internal ~3min "no
 * progress" stall watchdog that the relay CANNOT extend (not env-configurable, and the
 * keepalive is ignored). So if every account runs dry mid-workflow, its sub-agents abandon
 * after ~18min. This hook makes the user's Claude AWARE before launching: if even the
 * freshest account is already above `percent` (5h), it returns permissionDecision "ask"
 * (default) or "deny" with a reason suggesting inline work or waiting for a reset.
 *
 * Fails open: unknown quota or guard disabled -> allow silently (exit 0).
 */
const fs = require("fs");
const p = require("path");
const lib = require("./lib.js");

const DIR = process.env.CQR_DIR || __dirname;
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch (e) { return d; } }

let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch (e) {}
let hook = {}; try { hook = JSON.parse(stdin); } catch (e) {}
const tool = hook.tool_name || hook.toolName || "";

const conf = readJson(p.join(DIR, "tokens.json"), {});
const g = conf.workflowGuard || {};
// only the Workflow tool, only when enabled
if (!g.enabled || g.mode === "off" || !/workflow/i.test(tool)) process.exit(0);

const state = readJson(p.join(DIR, "state.json"), {});
const best = lib.bestHeadroom(conf, state);
const percent = g.percent == null ? 50 : g.percent;

// enough headroom on at least one account (or unknown) -> allow silently
if (best == null || best < percent) process.exit(0);

const accts = lib.accounts(conf, state).filter((a) => a.enabled);
const summary = accts.map((a) => "API-" + (a.idx + 1) + " 5h " + (a.h5 == null ? "?" : a.h5) + "%").join(", ");
const reason = "claude-quota-relay : le compte le plus frais est deja a " + best + "% (5h). Un gros workflow risque de staller ~18 min si les comptes saturent (limite non contournable de l'outil Workflow). Comptes : " + summary + ". Conseil : fais le travail inline (sous-agents un par un, en verifiant le quota entre chaque) ou attends un reset.";
const decision = g.mode === "deny" ? "deny" : "ask";

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
process.exit(0);
