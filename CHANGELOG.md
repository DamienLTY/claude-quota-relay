# Changelog

## 0.6.3

- **Fix — `cqr start`/`restart` manuel ignorait `ANTHROPIC_TARGET_API_URL`** : quand Claude Code démarre le proxy lui-même (hook `ensure-proxy.js`), il lui transmet automatiquement les variables de `settings.json`, dont `ANTHROPIC_TARGET_API_URL` sur les réseaux d'entreprise. Un `cqr start`/`restart` lancé à la main depuis un terminal (PowerShell, etc.) n'a PAS cette variable dans son propre environnement — le proxy retombait alors silencieusement sur `api.anthropic.com` direct, bloqué sur ces réseaux, et **tous les comptes remontaient un état identique et faux** (même réponse de blocage réseau pour chaque token). Un utilisateur a signalé exactement ce symptôme : quotas identiques à 100 % sur deux comptes réellement différents, alors que Claude Code lui-même fonctionnait normalement (car lancé via le hook, qui a la bonne variable). `cqr start`/`restart` relisent maintenant `ANTHROPIC_TARGET_API_URL` depuis `settings.json` et l'injectent explicitement si absent de l'environnement du terminal.
- Le démarrage du proxy logue maintenant l'hôte Anthropic réellement utilisé (`upstream=...`) dans `proxy.log`, pour vérifier facilement lequel est actif.
- Nouveau scénario de test (démarrage manuel depuis un terminal "nu", sans la variable, avec un vrai relais local). 18 suites de tests au total, toutes vertes.

## 0.6.2

- **Fix — le diagnostic de `cqr start`/`restart` ratait la cause la plus fréquente** : la v0.6.1 ne lisait que `proxy.out.log` (les plantages bruts) mais pas `proxy.log` (le propre journal du proxy, où passent les erreurs *gérées* comme "port déjà utilisé") — exactement le cas rencontré par un utilisateur (port 8787 squatté en permanence, probablement par `wrangler dev`). Le diagnostic lit maintenant les deux fichiers, détecte spécifiquement `EADDRINUSE` et propose la solution concrète.
- **Nouveau : `cqr policy port <n>`** — change le port du proxy sans réinstaller ni éditer les fichiers à la main (met à jour `tokens.json` et `settings.json` d'un coup, puis `cqr restart`).
- `start-verify.test.js` renforcé (le cas "port occupé" vérifie maintenant le détail EADDRINUSE + la suggestion) + nouveau scénario pour `cqr policy port`. 18 suites de tests au total, toutes vertes.

## 0.6.1

- **Fix — `cqr start`/`restart` mentait quand le proxy plantait** : la commande spawnait le process et affichait toujours « Proxy démarré. » sans jamais vérifier qu'il restait en vie — un utilisateur a signalé un cas où le proxy ne démarrait jamais, sans aucun indice pour comprendre pourquoi. `cqr start`/`restart` vérifient maintenant réellement (jusqu'à ~3s) que le proxy répond, et si ce n'est pas le cas, affichent les dernières lignes de `proxy.out.log` (la trace du plantage) + les causes fréquentes (fichier manquant, port déjà utilisé, antivirus d'entreprise qui tue les process détachés). Prouvé par 3 scénarios réels : démarrage sain, plantage simulé, port déjà occupé.
- 17 suites de tests au total, toutes vertes.

## 0.6.0

- **Interface entièrement en français** : l'installeur, le désinstalleur et le CLI (`cqr status`, `compact`, `guard`, `live`, etc.) étaient encore en anglais malgré un README français — corrigé, tous les messages affichés à l'utilisateur sont maintenant en français (les commentaires internes du code restent en anglais, convention du projet).
- **Support des réseaux d'entreprise (`ANTHROPIC_TARGET_API_URL`)** : sur les réseaux où `api.anthropic.com` est bloqué, l'utilisateur peut avoir configuré un relais personnel (ex. un Cloudflare Worker) via cette variable dans `settings.json`. Le proxy (et les appels Haiku de l'auto-compaction) la respectent maintenant automatiquement — vérifié : Claude Code lui-même ne lit PAS cette variable, c'est bien notre outil qui devait le faire. L'installeur détecte et confirme sa présence sans jamais y toucher. Prouvé par un test e2e réel (aucun seam de test, la vraie variable, un vrai relais local).
- Nouvelle suite de tests (`upstream-override.test.js`) + extension de `upgrade.test.js` (préservation de la variable). 15 suites au total, toutes vertes.

## 0.5.0

- **Login manuel, en plus de l'automatique** : à chaque compte, l'installeur demande maintenant « navigateur ou coller un token ? ». Nouveau `lib.pasteTokenManually`, réutilisé par l'installeur et par `cqr login/add --paste`. Le README documente aussi explicitement le chemin « éditer `tokens.json` à la main + `cqr sync-env` » pour ceux qui ne veulent aucun flux interactif.
- **Statusline vraiment "live"** : avant, les chiffres de quota ne bougeaient que quand une vraie requête passait par le compte actif — figés pour l'autre compte, et figés en cas d'attente pure. Le proxy sonde maintenant TOUS les comptes activés toutes les **45 s par défaut** (réglable, `cqr live <secondes>|off`), avec une requête quasi gratuite (0 token de sortie). Prouvé par un test e2e réel (aucune requête client envoyée, les deux comptes se rafraîchissent quand même, de façon répétée).
- **README réécrit en entier** : démarrage en 3 étapes en tête, sommaire, jargon expliqué en langage simple, sections regroupées (fonctionnalités avancées séparées du cœur toujours actif).
- Nouvelle suite de tests (`paste-token.test.js`) + extension de `proxy-e2e.test.js` (poll live). 13 suites au total, toutes vertes.

## 0.4.0

- **Fix — la compaction consommait le compte frais** : l'appel Haiku qui rafraîchit la mémoire utilisait toujours le compte le plus frais (`healthiestToken`), jamais l'ancien qu'on venait de quitter — exactement le bug rapporté par un utilisateur (« ça a bien patienté puis repris sur la clé fraîche, mais ça consomme des tokens dessus »). Ajout de `lib.preferredCompactionToken` : dépense la marge restante du compte **qu'on quitte** en priorité (il va de toute façon se réinitialiser dans quelques heures), ne bascule sur le frais que si l'ancien est réellement bloqué.
- **Fix — désalignement seuils** : `switchAtPercent` (global, pilotait le vrai switch) et les seuils de compaction par modèle (85-95 %) étaient deux réglages indépendants. Pour Haiku (seuil 95 % > switchAtPercent 94 %), la compaction ne se déclenchait **jamais**. `pickRoute` utilise maintenant le seuil effectif par modèle quand la compaction est active (comportement inchangé si elle est désactivée).
- **Seuil dynamique tenant compte du contexte** : calibré sur une mesure réelle (~148 000 tokens Haiku ≈ +1 point d'utilisation 5h) et le tarif relatif de chaque modèle (Haiku 1×, Sonnet 3×, Opus 5×, Fable 10×) pour calculer, à chaque requête, le seuil de sécurité le plus bas entre le réglage statique et ce qui est sûr compte tenu de la taille déjà connue de la conversation — ne peut que faire switcher plus tôt, jamais plus tard. `cqr compact buffer <points>`.
- 3 nouvelles suites de tests (`lib.test.js`, + extensions de `compaction.test.js`/`proxy-decide.test.js`/`memory-hook.test.js`), 11 suites au total, toutes vertes.

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
