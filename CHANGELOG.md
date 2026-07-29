# Changelog

## 0.12.0

- **Fin de la sonde de quota en continu (−90 % de requêtes).** Mesure du 29/07/2026 sur une journée : **3310 sondes pour 268 vraies requêtes**. Claude Code ne redessine pas sa barre d'état tout seul — elle est recalculée à chaque échange — donc vérifier les quotas toutes les 45 secondes n'affichait rien de plus. Désormais :
  - le compte qui sert la requête se renseigne par les en-têtes de sa réponse (comme avant) ;
  - les **autres** comptes sont vérifiés à l'occasion de cette requête (une fois par 30 s au plus, pour ne pas suivre une rafale de sous-agents) ;
  - pendant une attente de quota, une vérification part toutes les **2 minutes** (au lieu de 5) ;
  - au repos : **zéro trafic**.
- Migration automatique : une config restée sur l'ancienne valeur par défaut (`livePollMs: 45000`) est alignée sur le nouveau défaut, et l'installeur le signale. Une cadence que vous aviez choisie vous-même n'est pas touchée. Mode continu toujours disponible : `cqr live 120`.
- Vérifié : les sondes ne consomment pas de quota mesurable (5 h 17 sans aucune requête cliente, 423 sondes, quota 5h passé de 36 % à 13 %) — elles ne sont pas la cause des `529`, qui n'ont aucun en-tête de limite.

## 0.11.2

- **Statusline : trois états de crédits au lieu de deux.** `crédits ●` vert = servi sur les crédits en ce moment ; `crédits ◐` jaune = **crédits disponibles, pas encore utilisés** ; `crédits ○` rouge = plus rien d'utilisable (épuisés, désactivés, ou au-delà de votre plafond `cqr credits max`). Avant, un compte avec 57 € prêts à servir et un compte à sec affichaient le même rond rouge.
- Surcharge `529` : plafond de pause ramené de 10 min à **5 min** — au-delà, Claude Code a déjà abandonné la requête (relevé : `CLIENT close` à 4 min 53 s), attendre plus longtemps ne sert plus à rien.
- Journal sans accents sur la ligne des crédits (PowerShell lit le fichier en ANSI et affichait `forfait Ã©puisÃ©`).

## 0.11.1

- **Fin de la boucle sur surcharge Anthropic (529).** Relevé le 29/07/2026 : `529` → pause de 90 s → la **sonde de quota** (une requête de 8 tokens) passe → « déblocage anticipé » → on relâche la vraie requête → `529` … en boucle toutes les 45 s, sans jamais espacer. Deux corrections :
  - la sonde ne lève plus une pause posée par une **surcharge** — elle est trop petite pour prouver quoi que ce soit sur une vraie requête (elle continue de lever une pause de **quota**, comportement inchangé) ;
  - les `529` consécutifs **s'espacent** : 90 s, 3 min, 6 min… plafonné à 10 min, et le compteur repart de zéro après 10 min sans refus ou dès qu'une réponse est servie.

## 0.11.0

- **Une panne d'Anthropic ne fait plus perdre la requête.** Un `API Error: 500` (ou 502/503/504) n'a **aucun en-tête de quota** : ce n'est pas une limite, c'est le serveur qui a un problème — et c'est souvent **intermittent** (relevé le 29/07/2026 dans le journal : un `200` et un `500` à 10 s d'écart pendant l'incident). Avant, l'erreur était relayée telle quelle et la requête était perdue (deux compactions perdues ce jour-là). Maintenant le relais **rejoue la requête** sur le même compte avec un délai croissant (2 s, 4 s, 8 s… plafonné à 1 min), la connexion tenue ouverte par le keepalive habituel.
  - Aucune page de statut à interroger : **c'est la tentative qui aboutit qui prouve que c'est réparé** (status.claude.com retarde et reste au rouge alors que le service remarche).
  - Borne volontaire : `serverErrorMaxMs` (15 min par défaut, `0` = ne rien retenter). Passé ce délai, la vraie erreur est rendue au client — une requête que le serveur refuse *systématiquement* ne doit pas rester suspendue indéfiniment.
  - `529` (surcharge) garde son traitement d'origine : mise en pause courte du compte + bascule sur l'autre.

## 0.10.0

- **Fix — un compte qui répond était mis en quarantaine.** Quand un compte a des **crédits d'usage supplémentaire** (« extra usage »), Anthropic **sert quand même la requête** une fois le forfait épuisé : la réponse est un `200` normal, mais avec `anthropic-ratelimit-unified-status: rejected` **et** `anthropic-ratelimit-unified-overage-status: allowed` (exactement ce que Claude Code lit pour afficher « usage credits »). Le relais, lui, ne regardait que le `rejected` : il mettait le compte en pause et attendait un reset **alors que le compte répondait parfaitement**. Corrigé côté requêtes *et* côté sonde de quota, sans réglage à activer.
- **Nouveau : `cqr credits`** — les crédits comme **dernier recours**, uniquement si vous l'autorisez (ils peuvent être facturés, donc **off par défaut**). `cqr credits on|off`, `cqr credits max <pct>` (n'en consommer qu'une partie), `cqr credits` (état par compte : disponibles / % consommé / date de recharge, ou la raison traduite quand ils sont indisponibles).
  - jamais utilisés tant qu'un compte a encore du forfait gratuit ;
  - ils **franchissent la limite hebdomadaire (7 j)** — c'est le seul moyen de continuer quand la semaine est épuisée au lieu d'attendre plusieurs jours ;
  - un vrai `429` reste un vrai refus (mise en pause du compte, comme avant) ;
  - `overage.use` absent/false ⇒ routage **strictement identique** à la 0.9.0.
- **Statusline — l'heure de reset ne ment plus.** L'heure affichée après `↻` ne considère que les comptes ayant encore du quota **hebdomadaire** : un compte à 100 % sur 7 j ne redevient pas utilisable à son reset 5 h, l'afficher donnait un faux espoir. Si **aucun** compte n'a de quota hebdomadaire, c'est le reset **hebdomadaire le plus proche** qui s'affiche, marqué et daté (`↻7j sam 02h00`). Les crédits autorisés apparaissent en fin de ligne (voir la pastille ci-dessous).
- **Statusline : pastille crédits** (`crédits ●` vert = le compte utilisé est servi sur les crédits, `crédits ○` rouge = on consomme le forfait normal). Pleine/creuse en plus de la couleur → lisible sans couleurs. Ni pourcentage ni montant : le montant est **inaccessible** (l'endpoint `/api/oauth/usage` → `extra_usage.monthly_limit`/`used_credits`/`currency` **refuse les clés `claude setup-token`** — `403`, scope `user:profile` absent) et le pourcentage seul n'apprenait rien d'utile. `cqr credits budget <montant> [devise]` reste disponible pour afficher l'argent restant dans `cqr credits` / `cqr status`.
- `cqr status` affiche l'état des crédits, compte par compte. `proxy.log` trace `OVERAGE` (routage sur crédits / requête servie sur crédits).
- Nouveaux tests : en-têtes overage, palier de routage crédits (6 cas), e2e « 200 servi sur crédits », statusline (reset hebdo + crédits), `cqr credits`. 22 suites, toutes vertes.

## 0.9.0

- **Plafond de réserve pour fiabiliser la compaction (garde-fou non-désactivable).** La compaction native s'attache à la requête envoyée au compte cible ; si la politique autorisait à monter jusqu'à 100 % (`waitAtSoftPercent` désactivé = « utiliser la marge jusqu'au rejet »), cette requête se faisait **rejeter (429) et la compaction partait avec elle — perdue**. Désormais, **quand la compaction est active, on ne route/ride jamais un compte au-delà de 97 % de 5h** : au-delà, on bascule vers un compte plus frais, sinon on attend un reset. Il reste ainsi toujours de la marge pour que la requête compactée soit acceptée. On peut être *plus* prudent (`cqr policy waitsoft <N>` plus bas) mais pas dépasser ce plafond. Aucun effet si la compaction est désactivée (comportement inchangé).
- **Migration douce — on demande, on ne force pas.** À la mise à jour (`git pull` + `node src/install.js`), si le compactage entre comptes est **déjà désactivé** sur le PC, l'installeur **le signale et demande** s'il faut le réactiver (au lieu de le laisser silencieusement off à cause du bug ci-dessous). En mode non-interactif, il est laissé tel quel et le message final rappelle `cqr compact on`.
- **Fix — « ON par défaut » ne touchait jamais les mises à jour.** Le backfill de config (`Object.assign(défaut, config-existante)`) laissait l'ancien `enabled:false` **écraser** le nouveau défaut ON. Résultat : tout PC ayant déjà `enabled:false` (ou installé avant la v0.7) restait OFF à chaque `git pull`, alors que le message d'install annonçait « auto-compaction ACTIVE ». La migration ci-dessus corrige ce trou.
- **Compaction visible.** `cqr status` et `cqr compact` affichent maintenant la **dernière compaction** (« il y a X min, compte 1→2, modèle »), lue depuis `state.json` — fini le « je ne le vois pas ». (Les compactions *en place* ne sont pas tracées, seulement les changements de compte ; détail complet toujours dans `proxy.log`.)
- Nouveau `test/compaction-migrate.test.js` + cas de réserve (`proxy-decide`) et de visibilité (`cli-commands`). 22 suites, toutes vertes.

## 0.8.0

- **Compaction dynamique = sur le MÊME compte, sans basculer.** Avant, un très gros contexte faisait *basculer* de compte plus tôt (jusqu'à ~68 % sur Opus). Désormais, quand la compaction dynamique est active, le proxy **réduit la requête sur le compte que vous utilisez déjà** (0 token, `clear_tool_uses` natif) au lieu de changer de clé — le compte actif dure plus longtemps. La bascule, elle, se fait toujours au seuil statique par modèle (Opus 89 %). Pas d'appel Haiku ni de résumé mémoire pour cette compaction en place.
- **`cqr compact dynamic on` active aussi l'auto-compaction** (elle n'aurait aucun effet sinon).
- **`cqr help`** : liste toutes les commandes, groupées. Une commande inconnue affiche cette aide.
- **Plus de « puis redémarrez » à taper.** Les réglages (compaction, seuils, politique) sont relus à chaque requête → pris en compte immédiatement. Les deux qui ont besoin d'un redémarrage (le **port** et la **cadence de la statusline**) **redémarrent le proxy automatiquement**. Pour un changement de port, il reste juste à relancer Claude Code (il lit le port à son démarrage).
- Retrait de `effectiveSwitchThreshold` (le seuil dynamique n'avance plus la bascule ; sa logique vit maintenant dans la décision de compaction en place). Nouvelles suites de tests (`cli-commands.test.js` + cas compaction en place). 20 suites au total, toutes vertes.

## 0.7.0

- **Auto-compaction ACTIVE par défaut** (nouvelles installs) : mode natif `clear_tool_uses` (0 token), n'agit qu'au moment d'un changement de compte, donc l'usage normal est inchangé. Les installs existantes gardent leur réglage — pour l'activer : `cqr compact on`.
- **Fix — bascule trop tôt (68 % au lieu de 89 % sur Opus)** : le « seuil dynamique » (qui avance la bascule quand le contexte est déjà très gros) tombait à ~68 % sur un gros contexte Opus (~800k tokens). C'est mathématiquement prudent mais trop agressif une fois la compaction active (elle réduit déjà la requête). Le seuil dynamique devient **opt-in** (`cqr compact dynamic on`) ; par défaut, la bascule utilise le **seuil statique par modèle** (Opus 89 %, Sonnet 90 %, Fable 85 %, Haiku 95 %). Investigué + verrouillé par tests (le cas exact 829k→68 % est reproduit et documenté).
- **Nouvelles commandes de réglage** : `cqr compact threshold <modèle> <pct>` (% de bascule par modèle) et `cqr compact dynamic on|off`.
- **README réécrit** (encore) pour les non-développeurs : phrases courtes, analogie du standard téléphonique, une seule commande à retenir (`cqr status`), sections « ce qui est actif tout seul » / « problèmes courants » / « référence », et une note claire sur le piège « deux clés du même compte = même quota » avec la vérification `Organization-Id`.
- 19 suites de tests, toutes vertes.

## 0.6.4

- **Nouveau : `cqr remove <nom>`** (alias `rm`) — retire un compte de la config sans éditer `tokens.json` à la main. Utile pour nettoyer un doublon : deux tokens générés depuis le même compte Claude pointent vers la **même organisation** (donc le même quota — la bascule ne sert alors à rien). Astuce de diagnostic : l'endpoint gratuit `/v1/messages/count_tokens` renvoie l'en-tête `Anthropic-Organization-Id` ; si deux comptes ont le même, ce sont en réalité le même compte, il faut en régénérer un depuis un abonnement Claude réellement distinct.
- Nouvelle suite de tests (`accounts.test.js`). 19 suites au total, toutes vertes.

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
