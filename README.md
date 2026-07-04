# claude-quota-relay

**Un petit proxy local qui permet à Claude Code de basculer entre plusieurs comptes Claude — et, quand tous les comptes sont à court de quota, de *patienter* automatiquement jusqu'à la réinitialisation de la fenêtre 5 h au lieu d'échouer.** Vos longues tâches, vos sous-agents et vos workflows continuent tout seuls. Vous n'avez plus jamais à taper « continue ».

- 🔁 **Bascule automatique** entre 2, 3 comptes Claude ou plus (par requête).
- ⏳ **Attente puis reprise** quand tout est saturé — la requête est *retenue* jusqu'au reset d'une fenêtre de quota, puis se termine seule.
- 🧠 **Conscient du quota** — lit les vrais en-têtes de limite d'Anthropic (`5h` / `7j`) et préfère le compte le plus frais.
- 🔐 **Login automatisé** — récupère le token de chaque compte pour vous via `claude setup-token` (aucun copier-coller).
- ⚡ **Auto-compaction au changement de compte** (opt-in) — allège la requête envoyée au compte frais (**0 token**, jusqu'à -98 %) et tient une **mémoire de projet** générée par Haiku, sans perte de données.
- 📊 **Statusline quota** — le quota 5h/7j + reset de **chaque** compte, en direct ; s'ajoute proprement à une statusline existante sans la casser.
- 🛡️ **Garde-fou workflow** — prévient avant un gros workflow s'il n'y a plus assez de quota (les sous-agents de workflow ont un stall que le relais ne peut pas rattraper).
- 🖥️ **Multiplateforme** (macOS / Linux / Windows), **zéro dépendance** (Node pur), ~400 lignes lisibles.
- 🔒 Vos tokens restent **en local**. Rien n'est envoyé ailleurs que vers `api.anthropic.com`.

> Projet indépendant, non affilié à Anthropic. Utilisez uniquement des comptes qui vous appartiennent, dans le respect des conditions d'Anthropic.

---

## Pourquoi

Claude Code s'authentifie avec un seul `ANTHROPIC_AUTH_TOKEN`, lu **une fois au démarrage**. Si vous avez plusieurs abonnements, impossible d'en changer à chaud, et quand vous atteignez la limite des 5 h votre tâche meurt avec :

```
API Error: Request rejected (429) · This request would exceed your account's rate limit.
```

`apiKeyHelper` n'aide pas (les tokens d'abonnement `sk-ant-oat01-*` envoyés en `x-api-key` sont rejetés). La seule solution qui marche : un **proxy local** qui réécrit l'en-tête `Authorization: Bearer` à chaque requête. C'est ce projet.

## Comment ça marche

Claude Code → `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` (le proxy) → `api.anthropic.com`.

À chaque requête, le proxy :
1. Choisit le meilleur compte (utilisation 5 h la plus basse, avec une hystérésis pour éviter les allers-retours) et réécrit l'en-tête `Authorization` avec le token de ce compte.
2. Lit les en-têtes `anthropic-ratelimit-unified-*` de la réponse pour suivre l'usage réel 5 h / 7 j de chaque compte.
3. Sur un `429` / rejet, rejoue la requête sur un autre compte frais.
4. Si **tout** est saturé, il **retient la connexion ouverte** (en envoyant des commentaires SSE keepalive pour que Claude Code ne coupe pas) jusqu'au reset le plus proche, puis relaie — Claude Code croit simplement que le serveur était lent, et reprend.

Les sessions Claude Code ne voient rien de tout ça.

## Installation

Prérequis : **Node ≥ 18** et le **CLI Claude Code** déjà installé.

```bash
git clone https://github.com/DamienLTY/claude-quota-relay.git
cd claude-quota-relay
node src/install.js
```

L'installeur va, pas à pas :
- copier le proxy dans `~/.claude/claude-quota-relay/` ;
- vous demander **combien de comptes** vous voulez faire tourner (2, 3, 5…) ;
- pour **chaque compte**, ouvrir le login navigateur (`claude setup-token`) et **récupérer le token automatiquement** — aucun copier-coller. Entre deux comptes, il vous rappelle de vous **déconnecter** du précédent ;
- modifier `~/.claude/settings.json` (avec une sauvegarde) pour router Claude Code via le proxy, poser les *timeouts* qui rendent l'« attente puis reprise » possible, et ajouter un hook `SessionStart` qui démarre le proxy tout seul.

Puis **redémarrez Claude Code**. C'est tout.

> Installation non interactive (CI, script) : `node src/install.js --no-interactive` crée un `tokens.json` avec des emplacements vides ; renseignez-les ensuite avec `cqr login <nom>`.

### Ajouter / rafraîchir un compte plus tard

```bash
cqr login <nom>     # (re)connecte un compte existant et capture son token
cqr add [nom]       # ajoute un NOUVEAU compte (login + token capturé)
```

Chaque token longue durée provient de `claude setup-token` (abonnement Claude requis) — l'outil le lance et le lit pour vous.

## Mettre à jour (vous aviez déjà installé une version ?)

La mise à jour est **sans risque** : l'installeur préserve vos tokens, votre port et vos réglages, et n'ajoute **jamais deux fois** ses hooks ni sa statusline.

```bash
cd claude-quota-relay
git pull
node src/install.js        # non interactif si tokens.json existe déjà
```

Puis **redémarrez Claude Code**. Ce que fait la mise à jour :
- recopie les fichiers du proxy (nouvelles fonctions incluses) ;
- complète `tokens.json` avec les nouveaux réglages par défaut (`compaction`, `workflowGuard`) **sans toucher** aux vôtres ni à vos tokens ;
- ajoute les nouveaux hooks (mémoire, garde-fou workflow) **une seule fois** ;
- ajoute/rafraîchit la **statusline** quota (en gardant la vôtre si vous en aviez une) ;
- **sauvegarde** `settings.json` avant toute modif.

Rien à réactiver : l'auto-compaction reste **opt-in** (`cqr compact on` quand vous voulez), le reste s'active tout seul. (Config perso ailleurs que `~/.claude` : ajoutez `--config-dir <chemin>`.)

## Utilisation

L'installeur affiche une ligne `alias cqr=…` : ajoutez-la à votre profil shell pour utiliser `cqr` partout. Ensuite :

```bash
cqr status                 # état du proxy, quota par compte (5h/7j), resets, attente en cours
cqr list                   # liste les comptes (tokens masqués)
cqr login <nom|index>      # (re)capture le token d'un compte via le login navigateur
cqr add [nom]              # ajoute un nouveau compte (login + capture)
cqr use <nom|index>        # ÉPINGLE un compte (forcé, ignore règles + attente)
cqr auto                   # revient au mode automatique (bascule + attente)
cqr set <nom> <token>      # renseigne/écrase un token manuellement
cqr sync-env               # recopie le 1er token dans settings.json (ANTHROPIC_AUTH_TOKEN)
cqr policy                 # affiche la politique de routage
cqr policy waitsoft 85     # attendre dès 85 % au lieu de consommer jusqu'à 100 %
cqr compact status         # état de l'auto-compaction (voir la section dédiée)
cqr compact dry-run|on|off # simule / active / désactive l'auto-compaction au changement de compte
cqr compact memory         # affiche la mémoire de projet du dossier courant
cqr preflight              # quota par compte + si c'est sûr de lancer un gros workflow (exit 0/1)
cqr guard status|on|off|ask|deny|<%>  # garde-fou anti-stall des workflows
cqr start | stop | restart # gère le process proxy
```

## Les timeouts (pourquoi l'attente marche vraiment)

Retenir une requête plusieurs minutes/heures ne fonctionne que parce que l'installeur pose ces variables dans `settings.json` → `env`. Si vous voyez un jour `Request timed out · attempt N/10`, c'est que l'une d'elles manque :

| Variable | Valeur | Rôle |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | route Claude Code via le proxy |
| `API_TIMEOUT_MS` | 7 jours | timeout global de la requête |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 jours | **la plus importante** — le watchdog *sémantique* du CLI a un plancher **codé à 5 minutes** que le keepalive SSE **ne réarme PAS**. Sans cette variable, toute requête retenue meurt à 5 min. |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 jours | permet aux **sous-agents** d'attendre aussi (défaut 3 min) |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 min | garde-fou « connexion morte » au niveau octets ; le keepalive du proxy (20 s) le satisfait |

## Auto-compaction (réduire les tokens sur le compte suivant)

Quand le proxy bascule vers un autre compte parce que le premier arrive au bout de sa fenêtre 5 h, la nouvelle requête envoyée au **compte frais** peut être **allégée automatiquement** — sans le moindre token de résumé, et sans perte de données. Deux mécanismes complémentaires, **désactivés par défaut** (opt-in) :

1. **Réduction des tokens (proxy, 0 token).** Le proxy injecte l'effacement natif d'Anthropic (`clear_tool_uses`, *context editing*) dans la requête sortante : les **vieux résultats d'outils** sont effacés côté serveur, en gardant les **10 derniers** intacts. Mesuré : jusqu'à **-98 %** de tokens d'entrée. Rien n'est perdu — Claude Code conserve son historique local complet ; on n'allège que ce qui est *transmis*.
2. **Mémoire de projet (Haiku).** Un hook maintient un fichier `.cqr-memory.md` **par projet** (tâches faites / en cours / prévues + notes), mis à jour par **Haiku** (le modèle le moins cher) au moment de la bascule, ré-injecté dans le contexte du compte frais, et **enrichissable** par l'agent lui-même. Il s'auto-condense quand il dépasse `memoryMaxLines`. Un `/compact` **manuel** l'enrichit aussi (hook `PreCompact`), **sans** forcer de changement de compte.

**Déclencheurs** : juste avant une bascule quand le compte quitté atteint son seuil (par modèle, voir config), et juste avant la reprise après une attente de quota.

**Activation prudente** (elle modifie de vraies requêtes) :

```bash
cqr compact dry-run   # le proxy LOGUE seulement ce qu'il compacterait (proxy.log), sans rien changer ; la mémoire se construit quand même
cqr compact on        # active pour de bon, puis :  cqr restart
cqr compact off       # revient en arrière à tout moment
cqr compact mode strip  # repli : le proxy tronque lui-même les vieux résultats (forme de réponse inchangée), si jamais le mode natif pose souci
```

Réglages (dans `tokens.json` → `compaction`) : `thresholds` par modèle (`fable` 85 / `opus` 89 / `sonnet` 90 / `haiku` 95 / `default` 88 %), `keepToolUses` (10), `triggerTokens` (2000), `memoryFile`, `memoryMaxLines` (400), `mode` (`native`|`strip`). Le fichier mémoire et le dossier `.cqr-archive/` restent **dans votre projet** et sont ignorés par git.

## Statusline (quota en direct)

L'installeur ajoute une **ligne d'état** compacte et colorée :

```
5h █████████░ 84% ↻ 19h30  7j ① ███░86%  ② ████99%
```

- **5h** : une **seule** barre cumulée pour toute la flotte — chaque compte occupe 1/N de la barre (2 comptes → 50/50, 3 → 33 %…) et la remplit avec son propre usage 5h ; la barre entière = le 5h consommé au total. Suivent la moyenne et l'**heure réelle** du prochain compte à se réinitialiser (`↻HHhMM` — l'heure d'arrivée, pas un compte à rebours, car une statusline ne se rafraîchit pas toute seule).
- **7j** : une petite barre **par compte** (①②③…) avec son %.
- Couleurs : vert < 60 %, jaune 60-85 %, rouge > 85 % d'usage (désactivables via `NO_COLOR`).

Si vous **aviez déjà** une statusline, on la **garde** et on ajoute la nôtre après un `│` (la vôtre continue de tourner, on lui repasse la même entrée). **Jamais de doublon** à la réinstallation ; comme `settings.json` pointe vers notre script, une mise à jour du paquet met la ligne à jour toute seule ; la désinstallation **restaure** la vôtre.

## Garde-fou workflow (anti-stall)

L'outil **Workflow** de Claude Code tue ses sous-agents après ~18 min d'inactivité — non contournable (voir « Limites »). Un hook `PreToolUse` prévient donc **avant** de lancer un workflow : si même le compte le plus frais est déjà ≥ `percent` % (5h, défaut 50), il demande confirmation (`ask`) ou bloque (`deny`), avec le quota et un conseil (travailler inline / attendre un reset).

```bash
cqr preflight        # affiche le quota et dit si c'est sûr de fan-out (exit 0 = ok, 1 = risqué)
cqr guard ask        # mode par défaut : demande confirmation quand c'est risqué
cqr guard deny       # bloque carrément (Claude bascule alors en inline)
cqr guard 30         # ne prévient que si le meilleur compte est ≥ 30 %
cqr guard off        # désactive le garde-fou
```

## Configuration

`~/.claude/claude-quota-relay/tokens.json` (autant de comptes que voulu) :

```jsonc
{
  "port": 8787,
  "switchAtPercent": 94,       // préférer un compte sous ce % (5h)
  "sevenDayBlockPercent": 99,  // ne jamais router vers un compte au-delà (7j)
  "waitAtSoftPercent": null,   // null = consommer la marge 90–100 % avant d'attendre ; un nombre = attendre dès ce %
  "maxWaitMs": 604800000,      // plafond de rétention d'une requête (7 jours)
  "pollMs": 15000,             // fréquence de ré-évaluation pendant l'attente
  "tokens": [
    { "name": "account-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "account-2", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "account-3", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

## Sécurité

- `tokens.json`, `state.json` et les logs sont **ignorés par git** — ne les committez jamais.
- Les tokens ne quittent pas votre machine ; le proxy n'écoute que sur `127.0.0.1`.
- Les logs masquent les tokens.

## Limites honnêtes

- Les rares requêtes **non-streaming** ne peuvent pas recevoir de keepalive ; si elles tombent en pleine saturation, elles peuvent être coupées puis rejouées.
- Si le **PC se met en veille** pendant une longue attente, le socket peut tomber ; Claude Code réessaie au réveil.
- Le garde-fou 7 j d'un compte ne s'arme qu'**après** la première réponse vue de ce compte.
- Le proxy retient la requête sur **une** connexion ; les attentes très longues (heures) marchent mais se lissent mieux avec `cqr policy waitsoft 85`.
- L'**outil Workflow** de Claude Code (fan-out de sous-agents parallèles) impose son propre garde-fou d'inactivité *par sous-agent* (~3 min × quelques tentatives) que le relais **ne peut pas** allonger — ni par variable d'env, ni par keepalive (Claude Code ignore volontairement les trames `ping`/commentaires comme « non-progrès »). Concrètement : si **tous** vos comptes sont à sec pendant qu'un gros workflow tourne, ses sous-agents peuvent abandonner au bout de ~18 min. Le relais couvre en revanche parfaitement la **boucle principale** et les sous-agents classiques (Task) grâce aux timeouts 7 jours. Conseil : lancez un workflow lourd quand **au moins un compte** a encore du quota.

## Désinstallation

```bash
node src/uninstall.js          # retire les variables d'env + le hook (garde une sauvegarde de settings.json), conserve tokens.json
node src/uninstall.js --purge  # supprime en plus le dossier d'installation + tokens.json
```

Redémarrez Claude Code ensuite.

## Licence

MIT — voir [LICENSE](LICENSE).
