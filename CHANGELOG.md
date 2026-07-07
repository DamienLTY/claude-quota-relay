# Changelog

## 0.3.0

- **Fix — recompaction storm** : une fois tous les comptes au-dessus de `switchAtPercent`, le routage continue (volontairement) d'alterner sur le compte le plus frais — sans garde-fou, ça recompactait (et rappelait Haiku) à **chaque requête**. Ajout d'un cooldown (`compactionCooldownMs`, 10 min par défaut, `cqr compact cooldown <min>`) qui limite ça à une compaction par fenêtre, prouvé par simulation (30 compactions → 1).
- **`cqr` sans alias manuel** : l'installeur crée maintenant des scripts wrapper (`bin/cqr` posix + `bin/cqr.cmd` Windows) et les ajoute lui-même au PATH — API `.NET Environment` sur Windows (jamais `setx`, qui peut tronquer un PATH long), bloc idempotent dans `.bashrc`/`.zshrc` sur macOS/Linux. Réversible à la désinstallation (`--purge`).
- **Statusline redessinée** : barre 5h **cumulée** sur la flotte (chaque compte occupe 1/N, coloré par son propre usage), heure réelle du prochain reset (`↻ HHhMM`, pas un compte à rebours), une barre 7j par compte (①②③…), espacements et séparateurs `│` affinés.
- **Installeur réécrit** : sortie condensée par sections (Setup / Next steps), hooks agrégés en une ligne au lieu de cinq, couleurs discrètes (`NO_COLOR` respecté).

## 0.2.0

- **Auto-compaction au changement de compte** (opt-in) : effacement natif Anthropic `clear_tool_uses` (0 token, jusqu'à -98 %) + **mémoire de projet** générée par Haiku (`.cqr-memory.md`, par projet), seuils par modèle, `/compact` manuel enrichi. Commandes : `cqr compact status|dry-run|on|off|mode|memory`.
- **Statusline quota** : quota 5h/7j + reset de chaque compte, en direct ; s'ajoute proprement à une statusline existante sans doublon, mise à jour automatique, restaurée à la désinstallation.
- **Garde-fou workflow** : hook `PreToolUse` sur l'outil `Workflow` qui prévient (ask/deny) quand il ne reste plus assez de quota — le stall par sous-agent des workflows n'est pas rattrapable par le relais. Commandes : `cqr preflight`, `cqr guard`.
- **Mise à jour idempotente** pour les installs existants : `git pull && node src/install.js` (préserve tokens/port/réglages, hooks et statusline non dupliqués).

## 0.1.0

- Proxy de failover multi-comptes : réécrit l'en-tête `Authorization` par requête, préfère le compte le plus frais, bascule sur 401/429.
- Attente puis reprise : retient la requête (keepalive SSE) jusqu'au reset d'une fenêtre 5h/7j au lieu d'échouer.
- Login automatisé (`cqr login`/`add` via `claude setup-token`), N comptes, timeouts 7 jours, installeur/désinstalleur multiplateforme.
