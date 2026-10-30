---
allowed-tools: Bash(node:*)
description: Force un compte par son numéro (/auth-use 3 = 3e compte de cqr list), jusqu'à /auth-auto
argument-hint: <numéro du compte>
---
!`node "$HOME/.claude/claude-quota-relay/cli.js" use "#$ARGUMENTS" ; node "$HOME/.claude/claude-quota-relay/cli.js" status`

Confirme en une phrase quel compte est maintenant épinglé (ou l'erreur si le numéro n'existe pas), puis montre le statut.
