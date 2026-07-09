# claude-quota-relay

**Vous avez plusieurs abonnements Claude et vous voulez que Claude Code passe de l'un à l'autre tout seul quand l'un est à court de quota — au lieu de planter en plein milieu d'une tâche.** C'est exactement ce que fait ce projet : un petit programme qui tourne discrètement sur votre ordinateur, entre Claude Code et Anthropic, et qui gère les changements de compte à votre place.

**Sans ce projet**, quand votre quota de 5 heures est épuisé, Claude Code affiche une erreur et s'arrête :
```
API Error: Request rejected (429) · This request would exceed your account's rate limit.
```
Il faut alors attendre, ou changer de compte à la main.

**Avec ce projet**, ça ne se voit jamais : le relais bascule automatiquement sur un autre compte, ou patiente si tous sont pleins, et Claude Code reprend tout seul dès que possible — même en plein milieu d'une longue tâche ou d'un sous-agent.

> Projet indépendant, gratuit, non affilié à Anthropic. Utilisez uniquement des comptes qui vous appartiennent, dans le respect des conditions d'utilisation d'Anthropic.

---

## Démarrage en 3 étapes

```bash
git clone https://github.com/DamienLTY/claude-quota-relay.git
cd claude-quota-relay
node src/install.js
```

L'installeur vous pose quelques questions (combien de comptes, comment récupérer leurs tokens), configure tout, puis vous dit de redémarrer Claude Code. C'est tout — pas d'alias à créer, pas de fichier à éditer à la main (sauf si vous préférez, voir plus bas).

**Prérequis** : [Node.js](https://nodejs.org) version 18 ou plus, et le CLI Claude Code déjà installé.

---

## Sommaire

- [Ce que fait ce projet, en détail](#ce-que-fait-ce-projet-en-détail)
- [Installation](#installation)
- [Mettre à jour](#mettre-à-jour-vous-aviez-déjà-installé-une-version-)
- [Utilisation au quotidien](#utilisation-au-quotidien)
- [Fonctionnalités avancées (optionnelles)](#fonctionnalités-avancées-optionnelles) — auto-compaction, statusline en direct, garde-fou workflow
- [Les timeouts](#les-timeouts-pourquoi-lattente-marche-vraiment)
- [Réseau d'entreprise (api.anthropic.com bloqué)](#réseau-dentreprise-apianthropiccom-bloqué)
- [Dépannage](#dépannage)
- [Configuration complète](#configuration-complète)
- [Sécurité](#sécurité)
- [Limites honnêtes](#limites-honnêtes)
- [Désinstallation](#désinstallation)

---

## Ce que fait ce projet, en détail

Claude Code ne connaît qu'**un seul** token d'authentification, lu une seule fois au démarrage. Impossible d'en changer en cours de route par vous-même, et impossible de lui en donner plusieurs à la fois. Si vous avez 2, 3 abonnements Claude, vous ne pouvez normalement en utiliser qu'un à la fois.

La solution : Claude Code peut être configuré pour envoyer toutes ses requêtes vers une adresse locale (`http://127.0.0.1:8787`) au lieu d'aller directement chez Anthropic. C'est cette adresse locale qu'occupe notre **proxy** — un programme qui reçoit chaque requête, choisit le meilleur compte disponible, et la retransmet à Anthropic avec le bon token. Claude Code ne voit pas la différence.

Concrètement, à chaque requête, le proxy :

1. **Choisit le compte le plus frais** (celui dont le quota 5 h est le plus bas), sans changer de compte pour un rien tant que celui utilisé reste correct.
2. **Lit la vraie utilisation** renvoyée par Anthropic dans la réponse (des informations que Claude Code lui-même ne regarde pas), pour savoir précisément où en est chaque compte.
3. **Change de compte automatiquement** si celui utilisé se fait refuser (erreur 429).
4. **Attend, si vraiment tous les comptes sont pleins** — la requête reste ouverte (Claude Code croit juste que le serveur met du temps à répondre) jusqu'à ce qu'un quota se libère, puis repart toute seule. Plus besoin de retaper « continue ».

## Installation

```bash
git clone https://github.com/DamienLTY/claude-quota-relay.git
cd claude-quota-relay
node src/install.js
```

L'installeur fait tout, dans l'ordre :

1. Il copie les fichiers du programme dans `~/.claude/claude-quota-relay/`.
2. Il vous demande **combien de comptes Claude** vous voulez utiliser en rotation (2, 3, 5…).
3. Pour **chaque compte**, il vous demande comment récupérer son token — deux choix (voir juste en dessous).
4. Il modifie `~/.claude/settings.json` (en gardant une sauvegarde) pour que Claude Code passe par le proxy, avec les bons réglages pour que l'attente fonctionne vraiment.
5. Il rend la commande **`cqr`** utilisable partout, tout de suite, sans que vous ayez à créer un alias vous-même.

À la fin : **redémarrez Claude Code, et ouvrez un nouveau terminal** (un terminal déjà ouvert ne voit pas tout de suite la nouvelle commande `cqr`).

### Récupérer le token de chaque compte : automatique ou manuel

Pour chaque compte, l'installeur vous demande : **connexion automatique par navigateur**, ou **coller un token vous-même** ?

- **Automatique (recommandé)** : l'installeur lance `claude setup-token`, votre navigateur s'ouvre, vous vous connectez normalement, et le token est récupéré tout seul — vous n'avez rien à copier.
- **Manuel** : si vous préférez ne pas passer par le navigateur (ou si vous êtes sur une machine sans navigateur), tapez `paste` — on vous demande alors de coller directement un token que vous avez déjà (obtenu par exemple en lançant vous-même `claude setup-token` dans un autre terminal).

Vous pouvez aussi **ne pas utiliser l'installeur interactif du tout** :

```bash
node src/install.js --no-interactive
```

Ça crée un `tokens.json` avec des emplacements vides, que vous remplissez ensuite comme vous voulez :

```bash
cqr login <nom>            # récupère le token via le navigateur
cqr add [nom] --paste      # ajoute un compte en collant un token vous-même, sans navigateur
cqr set <nom> <token>      # renseigne un token directement en une commande (pratique dans un script)
```

Ou encore plus simple : **éditez `tokens.json` vous-même** avec un éditeur de texte (son chemin exact est affiché par l'installeur, en général `~/.claude/claude-quota-relay/tokens.json`), en remplaçant les emplacements vides par vos tokens (format : `sk-ant-oat01-…`, obtenu via `claude setup-token`). Une fois fait, lancez `cqr sync-env` puis redémarrez Claude Code.

## Mettre à jour (vous aviez déjà installé une version ?)

La mise à jour est **sans risque** : l'installeur préserve vos tokens, votre port et vos réglages, et n'ajoute **jamais deux fois** ses hooks ni sa statusline.

```bash
cd claude-quota-relay
git pull
node src/install.js        # redevient non-interactif tout seul si tokens.json existe déjà
```

Puis **redémarrez Claude Code**. Ce que fait la mise à jour, précisément :
- recopie les fichiers du proxy (nouvelles fonctionnalités incluses) ;
- complète `tokens.json` avec les nouveaux réglages par défaut, **sans toucher** à vos tokens ni à vos réglages existants ;
- ajoute les nouveaux hooks (mémoire, garde-fou workflow) **une seule fois**, jamais en double ;
- ajoute ou rafraîchit la **statusline** de quota (en gardant la vôtre si vous en aviez déjà une) ;
- **sauvegarde** `settings.json` avant toute modification.

Rien à réactiver de force : les fonctionnalités optionnelles (auto-compaction) restent **désactivées par défaut**, vous les activez quand vous voulez. (Si votre config Claude Code n'est pas dans `~/.claude`, ajoutez `--config-dir <chemin>` à la commande.)

## Utilisation au quotidien

Une fois installé, `cqr` fonctionne depuis n'importe quel dossier, sans rien à activer.

**Les commandes de base :**

```bash
cqr status                 # état du proxy : quota par compte (5h/7j), heure des resets, attente en cours
cqr list                   # liste les comptes (tokens masqués, jamais affichés en clair)
cqr use <nom|index>        # force un compte précis (ignore les règles automatiques, jusqu'à cqr auto)
cqr auto                   # revient au mode automatique
cqr start | stop | restart # démarre / arrête / redémarre le proxy
```

**Gérer les comptes :**

```bash
cqr login <nom>            # (re)connecte un compte via le navigateur
cqr login <nom> --paste    # (re)connecte un compte en collant un token vous-même
cqr add [nom]              # ajoute un nouveau compte (mêmes choix : navigateur ou --paste)
cqr set <nom> <token>      # renseigne un token directement, sans prompt (utile en script)
cqr sync-env               # recopie le 1er token dans settings.json
```

**Régler le comportement :**

```bash
cqr policy                 # affiche les seuils actuels (à quel % on préfère changer de compte, etc.)
cqr policy waitsoft 85     # attendre dès 85 % de quota au lieu de le consommer jusqu'à 100 %
```

## Fonctionnalités avancées (optionnelles)

Ces trois fonctionnalités sont indépendantes du cœur du projet (bascule + attente, toujours actives). Elles s'activent séparément.

### Statusline — voir le quota de tous vos comptes en direct

L'installeur ajoute une ligne d'état compacte et colorée, visible en permanence dans Claude Code :

```
5h █████████░ 84% ↻ 19h30 │ 7j ① ███░ 86% │ ② ████ 99%
```

- **5h** : une seule barre qui représente toute votre flotte de comptes — avec 2 comptes, chacun occupe la moitié de la barre et la remplit selon SON propre usage (avec 3 comptes, un tiers chacun, etc.). La barre entière donne donc une vue d'ensemble. Juste après : la moyenne, puis l'**heure réelle** (pas un compte à rebours) à laquelle le prochain compte va se réinitialiser — parce qu'une statusline ne se rafraîchit pas magiquement toute seule à la seconde près.
- **7j** : une petite barre **par compte** (①②③…) avec son pourcentage sur la fenêtre de 7 jours.
- Les couleurs (vert / jaune / rouge) indiquent le niveau d'usage ; désactivables avec la variable d'environnement `NO_COLOR`.

**Mise à jour en direct, même sans rien faire.** Même quand tous vos comptes sont déjà à sec et que vous avez juste Claude Code ouvert en attendant qu'un quota se libère, les chiffres continuent de bouger : le proxy interroge Anthropic en arrière-plan toutes les **45 secondes environ** (réglable) pour rafraîchir **les deux comptes**, avec une requête quasi gratuite (0 token de sortie, ~8 tokens d'entrée) — donc ça ne consomme jamais de votre quota réel. Réglages :

```bash
cqr live status   # affiche l'intervalle actuel
cqr live 30       # rafraîchit toutes les 30 secondes au lieu de 45
cqr live off       # désactive le rafraîchissement en arrière-plan
```

Si vous **aviez déjà** une statusline personnalisée, elle est **conservée** telle quelle, et la nôtre est ajoutée juste après un séparateur `│` — jamais en double, même après une réinstallation. La désinstallation restaure votre statusline d'origine.

### Auto-compaction — réduire les tokens consommés au changement de compte

Quand le proxy bascule vers un autre compte, la requête envoyée à ce nouveau compte peut être **allégée automatiquement**, sans perte d'information, avant même d'y toucher. Deux mécanismes, tous deux **désactivés par défaut** :

1. **Réduction des tokens (0 token de résumé).** Le proxy demande à Anthropic d'effacer, côté serveur, les vieux résultats d'outils de la conversation (en gardant les 10 derniers), une fonctionnalité native appelée *context editing*. Mesuré en conditions réelles : jusqu'à **-98 %** de tokens envoyés. Rien n'est perdu : Claude Code garde tout son historique local, on allège seulement ce qui est transmis au réseau.
2. **Mémoire de projet.** Un fichier `.cqr-memory.md`, un par projet, résume les tâches faites / en cours / prévues. Il est mis à jour par **Haiku** (le modèle le moins cher) au moment du changement de compte, puis réinjecté au début de la conversation sur le nouveau compte — et vous (ou l'agent) pouvez continuer à l'enrichir.

**Le compactage dépense la marge du compte qu'on quitte, pas celle du compte frais** : puisque l'ancien compte va de toute façon se réinitialiser dans quelques heures, autant utiliser ce qu'il lui reste plutôt que d'entamer le quota tout neuf du nouveau compte. Le proxy ne bascule sur le compte frais pour cette opération que si l'ancien est vraiment bloqué.

**Activation prudente**, puisque ça touche à de vraies requêtes :

```bash
cqr compact dry-run   # ne change RIEN, mais note dans les journaux ce qu'il aurait fait — pour observer avant d'activer
cqr compact on        # active pour de vrai, puis : cqr restart
cqr compact off        # désactive à tout moment
```

Réglages avancés (`cqr compact status` pour tout voir) : à quel pourcentage de quota déclencher le changement selon le modèle utilisé, combien de temps minimum entre deux compactages (`cqr compact cooldown <minutes>`), une marge de sécurité supplémentaire quand la conversation est déjà très grosse (`cqr compact buffer <points>`), et un mode de secours (`cqr compact mode strip`) si jamais la méthode native pose souci avec votre version de Claude Code.

### Garde-fou workflow — éviter qu'un gros workflow ne se bloque

L'outil **Workflow** de Claude Code (qui lance plusieurs sous-agents en parallèle) a sa propre limite interne : si un sous-agent ne progresse plus pendant environ 18 minutes, il abandonne — et ce délai ne peut **pas** être prolongé par le relais, même en attendant un quota. Pour éviter la mauvaise surprise, un avertissement se déclenche **avant** de lancer un gros workflow si le quota restant est trop juste :

```bash
cqr preflight         # affiche le quota de chaque compte et dit si c'est prudent de lancer un workflow
cqr guard ask         # (par défaut) demande confirmation quand c'est risqué
cqr guard deny        # bloque carrément dans ce cas
cqr guard 30          # n'avertit que si même le meilleur compte est déjà à 30 % ou plus
cqr guard off         # désactive l'avertissement
```

## Les timeouts (pourquoi l'attente marche vraiment)

Retenir une requête pendant plusieurs minutes ou plusieurs heures ne fonctionne que parce que l'installeur règle ces variables dans `settings.json`. Si vous voyez un jour l'erreur `Request timed out · attempt N/10`, c'est que l'une d'elles manque :

| Variable | Valeur posée | Rôle |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | fait passer Claude Code par le proxy |
| `API_TIMEOUT_MS` | 7 jours | délai maximum global d'une requête |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 jours | **la plus importante** : Claude Code a un délai de sécurité codé en dur à 5 minutes qui n'est PAS réarmé par le signal d'attente du proxy. Sans ce réglage, toute requête retenue meurt au bout de 5 minutes. |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 jours | permet aux **sous-agents** d'attendre aussi (par défaut, 3 minutes seulement) |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 minutes | garde-fou technique bas niveau ; déjà satisfait par le signal que le proxy envoie toutes les 20 secondes |

## Réseau d'entreprise (api.anthropic.com bloqué)

Sur certains réseaux professionnels, l'adresse `api.anthropic.com` est bloquée par la sécurité de l'entreprise, et il faut passer par un relais personnel (par exemple un Cloudflare Worker) pour atteindre Anthropic. Si votre `settings.json` contient déjà une variable **`ANTHROPIC_TARGET_API_URL`** pointant vers ce relais, **le proxy la détecte et l'utilise automatiquement** — pour tout : la bascule entre comptes, les sondes de quota, la statusline en direct, et les appels de l'auto-compaction. Rien à configurer de votre côté : si la variable est là, tout ce que fait ce projet passe par elle plutôt que par `api.anthropic.com` directement.

L'installeur vous confirme la détection au moment de l'installation (« réseau d'entreprise détecté »). Si vous ajoutez cette variable **après** avoir déjà installé et démarré le proxy, un redémarrage est nécessaire : `cqr restart`.

## Configuration complète

Tous les réglages vivent dans un seul fichier : `~/.claude/claude-quota-relay/tokens.json`.

```jsonc
{
  "port": 8787,
  "switchAtPercent": 94,       // préférer un autre compte dès que celui-ci dépasse ce % (5h)
  "sevenDayBlockPercent": 99,  // ne jamais router vers un compte au-delà de ce % (7j)
  "waitAtSoftPercent": null,   // null = consommer la marge 90-100% avant d'attendre ; un chiffre = attendre dès ce %
  "maxWaitMs": 604800000,      // durée maximale de rétention d'une requête (7 jours)
  "pollMs": 15000,             // fréquence de ré-évaluation pendant une attente active
  "livePollMs": 45000,         // fréquence de rafraîchissement en arrière-plan pour la statusline (0 = désactivé)
  "tokens": [
    { "name": "account-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "account-2", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "account-3", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

Les blocs `compaction` et `workflowGuard` (auto-compaction et garde-fou, voir plus haut) sont ajoutés automatiquement par l'installeur, avec leurs propres réglages détaillés dans les sections correspondantes.

## Sécurité

- `tokens.json`, `state.json` et les journaux (`*.log`) sont **ignorés par git** — ils ne seront jamais commités par erreur.
- Vos tokens ne quittent jamais votre machine : le proxy n'écoute que sur `127.0.0.1` (uniquement accessible depuis votre propre ordinateur).
- Les journaux du proxy masquent toujours les tokens (jamais affichés en clair).

## Limites honnêtes

- Les rares requêtes qui ne sont **pas** en streaming ne peuvent pas recevoir le signal d'attente ; si elles tombent pile en pleine saturation, elles peuvent être coupées puis rejouées automatiquement.
- Si votre ordinateur **se met en veille** pendant une longue attente, la connexion peut se couper ; Claude Code réessaie tout seul au réveil.
- La protection sur la fenêtre de 7 jours d'un compte ne s'active qu'**après** avoir vu au moins une réponse de ce compte.
- Le proxy retient chaque requête sur une seule connexion ; ça fonctionne même pour des attentes de plusieurs heures, mais c'est plus fluide avec `cqr policy waitsoft 85`.
- L'outil **Workflow** de Claude Code a son propre délai d'abandon par sous-agent (~18 minutes) que le relais ne peut techniquement pas prolonger, même en jouant sur les timeouts ou le signal d'attente. Conseil : lancez un gros workflow quand **au moins un compte** a encore du quota (voir `cqr preflight`).

## Dépannage

### `cqr status` affiche toujours ARRÊTÉ, même après `cqr start`

`cqr start`/`cqr restart` vérifient désormais réellement que le proxy répond (jusqu'à ~3 secondes) — s'il plante, la commande vous l'affichera clairement avec les dernières lignes du journal d'erreur, au lieu de dire faussement « Proxy démarré ». Si vous voyez cette erreur, les causes les plus fréquentes sont :

- **Un fichier du proxy manque ou est corrompu** → relancez l'installeur pour tout recopier proprement : `node src/install.js` (depuis le dossier du repo cloné).
- **Le port est déjà utilisé** par autre chose sur votre machine → changez de port dans `tokens.json` (`"port": 8788` par exemple), puis `cqr restart`.
- **Un antivirus ou un logiciel de sécurité d'entreprise** bloque les processus lancés en arrière-plan (fréquent sur les PC professionnels). Pour voir l'erreur exacte en direct, lancez le proxy au premier plan :
  ```bash
  node ~/.claude/claude-quota-relay/proxy.js
  ```
  L'erreur s'affichera immédiatement dans le terminal. Vous pouvez aussi consulter directement les journaux :
  ```bash
  cat ~/.claude/claude-quota-relay/proxy.out.log   # trace brute d'un plantage éventuel
  cat ~/.claude/claude-quota-relay/proxy.log        # journal normal du proxy
  ```

## Désinstallation

```bash
node src/uninstall.js          # retire nos réglages et hooks (garde une sauvegarde de settings.json), restaure votre statusline d'origine, conserve tokens.json et la commande cqr
node src/uninstall.js --purge  # supprime en plus le dossier d'installation, tokens.json, et retire cqr du PATH
```

Redémarrez Claude Code ensuite.

## Licence

MIT — voir [LICENSE](LICENSE).
