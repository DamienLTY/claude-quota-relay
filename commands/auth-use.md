---
allowed-tools: Bash(node:*)
description: Passe sur un compte par son numéro (/auth-use 3 = 3e compte de cqr list) ; le relais rebascule seul une fois ce compte usé
argument-hint: <numéro du compte>
---
!`node "$HOME/.claude/claude-quota-relay/cli.js" bascule "#$ARGUMENTS" ; node "$HOME/.claude/claude-quota-relay/cli.js" status`

Confirme en une phrase quel compte est maintenant actif (ou l'erreur si le numéro n'existe pas), puis montre le statut.
