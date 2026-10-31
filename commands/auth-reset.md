---
allowed-tools: Bash(node:*)
description: Oublie les blocages (epuise) et relance le proxy si besoin, puis montre le statut
---
!`node "$HOME/.claude/claude-quota-relay/cli.js" reset && node "$HOME/.claude/claude-quota-relay/cli.js" start && node "$HOME/.claude/claude-quota-relay/cli.js" status`

Confirme en une phrase que les blocages sont effaces, puis montre le statut.
