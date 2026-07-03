# claude-quota-relay

**Un petit proxy local qui permet à Claude Code de basculer entre plusieurs comptes Claude — et, quand tous les comptes sont à court de quota, de *patienter* automatiquement jusqu'à la réinitialisation de la fenêtre 5 h au lieu d'échouer.** Vos longues tâches, vos sous-agents et vos workflows continuent tout seuls. Vous n'avez plus jamais à taper « continue ».

- 🔁 **Bascule automatique** entre 2, 3 comptes Claude ou plus (par requête).
- ⏳ **Attente puis reprise** quand tout est saturé — la requête est *retenue* jusqu'au reset d'une fenêtre de quota, puis se termine seule.
- 🧠 **Conscient du quota** — lit les vrais en-têtes de limite d'Anthropic (`5h` / `7j`) et préfère le compte le plus frais.
- 🔐 **Login automatisé** — récupère le token de chaque compte pour vous via `claude setup-token` (aucun copier-coller).
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

## Désinstallation

```bash
node src/uninstall.js          # retire les variables d'env + le hook (garde une sauvegarde de settings.json), conserve tokens.json
node src/uninstall.js --purge  # supprime en plus le dossier d'installation + tokens.json
```

Redémarrez Claude Code ensuite.

## Licence

MIT — voir [LICENSE](LICENSE).
