# Changelog

## 0.2.0

- **Auto-compaction au changement de compte** (opt-in) : effacement natif Anthropic `clear_tool_uses` (0 token, jusqu'à -98 %) + **mémoire de projet** générée par Haiku (`.cqr-memory.md`, par projet), seuils par modèle, `/compact` manuel enrichi. Commandes : `cqr compact status|dry-run|on|off|mode|memory`.
- **Statusline quota** : quota 5h/7j + reset de chaque compte, en direct ; s'ajoute proprement à une statusline existante sans doublon, mise à jour automatique, restaurée à la désinstallation.
- **Garde-fou workflow** : hook `PreToolUse` sur l'outil `Workflow` qui prévient (ask/deny) quand il ne reste plus assez de quota — le stall par sous-agent des workflows n'est pas rattrapable par le relais. Commandes : `cqr preflight`, `cqr guard`.
- **Mise à jour idempotente** pour les installs existants : `git pull && node src/install.js` (préserve tokens/port/réglages, hooks et statusline non dupliqués).

## 0.1.0

- Proxy de failover multi-comptes : réécrit l'en-tête `Authorization` par requête, préfère le compte le plus frais, bascule sur 401/429.
- Attente puis reprise : retient la requête (keepalive SSE) jusqu'au reset d'une fenêtre 5h/7j au lieu d'échouer.
- Login automatisé (`cqr login`/`add` via `claude setup-token`), N comptes, timeouts 7 jours, installeur/désinstalleur multiplateforme.
