# claude-quota-relay (`cqr`)

[English](README.md) · Français

## À quoi ça sert

Vous avez plusieurs abonnements Claude, mais Claude Code n'en utilise qu'un seul. Quand son quota est épuisé, tout s'arrête :

```
API Error: Request rejected (429) · This request would exceed your account's rate limit.
```

`cqr` est un petit programme qui tourne sur votre ordinateur, entre Claude Code et Anthropic. Il utilise vos comptes à tour de rôle. Quand l'un est plein, il passe au suivant. Quand tous sont pleins, il attend qu'un quota se libère, puis reprend tout seul, même au milieu d'une longue tâche. Vous ne voyez rien : ça continue.

Une image : c'est un standard téléphonique. Claude Code appelle toujours le même numéro (votre ordinateur) ; le standard transfère l'appel au compte qui peut répondre.

Projet indépendant, gratuit, non affilié à Anthropic. N'utilisez que des comptes qui vous appartiennent, dans le respect des conditions d'Anthropic.

## Comment ça marche

```
Claude Code  ->  cqr (127.0.0.1:8787, votre ordinateur)  ->  Anthropic
                  |  choisit le compte le moins chargé
                  |  change de compte si un compte est refusé
                  |  attend si tous les comptes sont pleins
```

Au moment de l'installation, `cqr` modifie le fichier `~/.claude/settings.json` de Claude Code pour que celui-ci parle à `127.0.0.1:8787` (une adresse qui désigne votre propre ordinateur) au lieu de parler directement à Anthropic. À chaque requête, `cqr` remplace la clé du compte par celle du compte choisi, puis transmet la requête.

## Sécurité : ce que fait (et ne fait pas) cqr

Vous donnez à ce programme des clés de connexion à vos comptes. Il est normal de vouloir savoir ce qu'il en fait.

- **Vos clés restent sur votre ordinateur**, dans un seul fichier : `tokens.json`, dans `~/.claude/claude-quota-relay/`. Ce fichier est ignoré par git (il ne peut pas être publié par erreur). Les journaux masquent toujours les clés, et `cqr` ne les affiche jamais en entier.
- **Il n'écoute que sur `127.0.0.1`**, c'est-à-dire votre ordinateur seul. Personne d'autre sur votre réseau ne peut s'y connecter.
- **Il ne parle qu'à trois destinataires** : Anthropic (`api.anthropic.com`), le relais d'entreprise que vous indiquez vous-même (variable `ANTHROPIC_TARGET_API_URL`, voir [Réseau d'entreprise](#réseau-dentreprise)), et `openrouter.ai` uniquement si vous activez le compactage gratuit (coupé par défaut, voir [plus bas](#compactage-gratuit-option-coupée-par-défaut)).
- **Aucune télémétrie**, aucune statistique envoyée à l'auteur, aucun compte à créer chez lui.
- **Le code est court et lisible** : environ 4 700 lignes de JavaScript, sans dépendance à installer. Vous pouvez le vérifier vous-même :

```bash
# Quels fichiers ouvrent une connexion vers l'extérieur ? (seulement proxy.js et free-compact.js)
grep -n 'require("https")' src/*.js

# Quelles adresses extérieures sont écrites dans le code ?
grep -n "api.anthropic.com\|openrouter.ai" src/*.js
```

Réserve honnête : une clé qui se trouve dans un fichier est lisible par tout programme qui tourne sous votre compte utilisateur. C'est vrai de toutes les clés stockées sur un ordinateur ; protégez votre session comme d'habitude.

## Installer

**Il vous faut :** [Node.js](https://nodejs.org) version 18 ou plus, `git`, et Claude Code déjà installé.

1. Téléchargez le projet et lancez l'installeur :

   ```bash
   git clone https://github.com/DamienLTY/claude-quota-relay.git
   cd claude-quota-relay
   node src/install.js
   ```

   L'installeur copie les fichiers dans `~/.claude/claude-quota-relay/`, ajoute la commande `cqr` à votre PATH (la liste des dossiers où le terminal cherche les commandes), règle `settings.json`, ajoute la barre d'état, et vous demande vos comptes. Il sauvegarde `settings.json` avant de le modifier.

2. **Donnez la clé de chaque compte.** Pour chacun, l'installeur demande : *navigateur* ou *coller* ?
   - **Navigateur** (le plus simple) : une fenêtre s'ouvre, vous vous connectez à ce compte Claude, la clé est récupérée toute seule.
   - **Coller** : tapez `paste`, puis collez une clé que vous avez déjà (elle commence par `sk-ant-oat01-` ; vous l'obtenez avec la commande `claude setup-token`). Pratique si le navigateur est bloqué.

   Vous pouvez aussi ajouter un compte plus tard : `cqr add`.

3. **Redémarrez Claude Code.**
4. Ouvrez un **nouveau** terminal (pour que `cqr` soit reconnu).

> **Le piège le plus courant.** Vos comptes doivent être vraiment différents (deux abonnements, deux adresses e-mail). Si vous créez deux clés en étant connecté au même compte Claude, ce sont deux clés du même compte : même quota, la bascule ne sert à rien. Voir [dépannage](#mes-deux-comptes-montrent-toujours-le-même-quota).

### Vérifier que ça marche

```bash
cqr status
```

Vous devez voir `Proxy : EN COURS` et une ligne par compte :

```
Proxy   : EN COURS (port 8787)
Actif   : compte-1
 > [0] compte-1   on  quota:5h=42% 7d=25%  reset5h~4h05
   [1] compte-2   on  quota:5h=9%  7d=1%   reset5h~4h05
```

Ce sont, pour chaque compte, le quota utilisé sur 5 heures et sur 7 jours, et l'heure de la prochaine remise à zéro. Si vous voyez `ARRÊTÉ`, allez à [dépannage](#cqr-status-dit-arrêté-même-après-cqr-start). Puis lancez simplement Claude Code : la barre d'état (voir plus bas) affiche vos comptes.

Sans aucun compte, `cqr` est installé mais éteint : il démarre à l'ajout du premier compte.

## Au quotidien

Une seule commande à retenir : `cqr status`. `cqr help` liste toutes les autres.

```bash
cqr list                     # liste les comptes (clés masquées)
cqr add [nom]                # ajoute un compte (navigateur, ou --paste pour coller)
cqr login <nom>              # reconnecte un compte
cqr set <nom> <clé>          # met une clé directement, sans question
cqr remove <nom>             # retire un compte
cqr start | stop | restart   # gère le programme (stop = arrêt voulu, la barre d'état ne le relance pas)
cqr use <nom>                # force un compte précis ; s'il est refusé (429), cqr passe sur un compte qui a du quota
cqr bascule <nom>            # passe sur ce compte sans l'épingler (aussi dans Claude Code : /auth-use)
cqr auto                     # revient au choix automatique
```

Les réglages sont pris en compte tout de suite, sans redémarrage. Seuls le port et la cadence de la barre d'état redémarrent le programme, et `cqr` le fait pour vous.

Le réglage principal : à quel pourcentage de quota changer de compte.

```bash
cqr policy                   # voir les réglages
cqr policy waitsoft 85       # attendre dès 85 % au lieu d'aller jusqu'à 100 %
```

## Ce qui marche tout seul

**La bascule et l'attente.** À chaque requête, `cqr` choisit le compte le moins chargé. Si un compte est refusé, il passe au suivant. Si tous sont pleins, il garde la requête ouverte : Claude Code croit seulement que la réponse est lente, puis ça repart au reset.

**Les pannes passagères.** Si Anthropic est surchargé (erreur 529) ou en panne (erreur 500), `cqr` réessaie à intervalles croissants pendant 15 minutes avant de vous rendre l'erreur. Si votre connexion tombe (veille, Wi-Fi, VPN qui se reconnecte), il retient la requête et réessaie jusqu'à 60 minutes. Une réponse coupée en plein milieu est coupée franchement pour que Claude Code la refasse.

**L'auto-compaction (active par défaut).** Quand `cqr` change de compte, il allège la requête envoyée au nouveau compte : il demande à Anthropic d'effacer les vieux résultats d'outils de la conversation (fonction officielle, qui ne coûte aucun token). Le compte neuf se remplit beaucoup plus lentement. Rien n'est perdu : Claude Code garde tout son historique en local, seul ce qui part sur le réseau est allégé. Seuil de bascule par modèle : Fable 85 %, Opus 89 %, Sonnet 90 %, Haiku 95 %.

```bash
cqr compact                    # voir l'état et les réglages
cqr compact off                # tout couper
cqr compact threshold opus 89  # changer le seuil d'un modèle
```

`cqr` bâtit aussi un petit fichier `.cqr-memory.md` à la racine de votre projet (derniers commits, fichiers modifiés, section « En cours » de `TODO.md`), que Claude relit en début de session et après un compactage. Aucun modèle n'est appelé pour le fabriquer. `cqr compact off` le coupe aussi.

### La barre d'état

Toujours visible dans Claude Code, elle montre le quota de tous vos comptes, une ligne par compte (5 heures à gauche, 7 jours à droite) :

```
↻ 19h30 ② │
│ ①  5h/ 37% ████░░░░░░ ██████░░░░ 7J/ 64% │
│ ②  5h/100% ██████████ █████████░ 7J/ 88% │
```

Le numéro du compte change de couleur : vert (compte en service), jaune (en réserve), orange (5 h épuisé, revient à son reset), rouge (plus rien avant le reset hebdomadaire). L'heure après `↻` est le prochain reset utile. Si vous aviez déjà une barre d'état, la vôtre est gardée et la nôtre s'ajoute à côté.

Elle se met à jour à chaque échange avec Claude Code, pas en continu : au repos, `cqr` ne fait aucune requête. Pour une vérification continue : `cqr live 120` (toutes les 120 s) ; `cqr live off` pour revenir au défaut.

### Les crédits d'usage supplémentaire (désactivés par défaut)

Si Anthropic vous a donné ou vendu des crédits d'« extra usage », votre compte peut continuer à répondre une fois le forfait épuisé, **aux frais de ces crédits**. Comme ils peuvent être facturés, `cqr` ne les utilise que si vous le demandez :

```bash
cqr credits              # ai-je des crédits ? combien m'en reste-t-il ?
cqr credits on           # les autoriser quand plus AUCUN compte n'a de forfait
cqr credits budget 20 EUR  # donner le montant de vos crédits, pour voir l'argent restant
cqr credits max 50       # n'en consommer que la moitié, puis se remettre à attendre
cqr credits off          # revenir à l'attente du reset
```

Une fois autorisés, la barre d'état se termine par une pastille : `crédits ●` vert (servi sur les crédits), `◐` jaune (forfait normal, crédits en réserve), `○` rouge (plus rien d'utilisable). Les crédits ne servent jamais tant qu'un forfait gratuit est disponible. Si `cqr credits` dit « indisponibles », l'usage supplémentaire est désactivé sur votre compte : activez-le sur [claude.ai/settings/usage](https://claude.ai/settings/usage).

### Le garde-fou « workflow »

L'outil Workflow de Claude Code (qui lance beaucoup de sous-agents à la fois) abandonne un sous-agent bloqué au bout d'environ 18 minutes, et `cqr` ne peut pas prolonger ce délai. Avant un gros workflow, un avertissement s'affiche donc si le quota est trop juste.

```bash
cqr preflight       # est-ce prudent de lancer un workflow maintenant ?
cqr guard ask       # (défaut) demande confirmation si risqué
cqr guard off       # désactive l'avertissement
```

## Compactage gratuit (option, coupée par défaut)

Quand Claude Code compacte une conversation longue (automatiquement, ou avec `/compact`), c'est normalement Claude qui écrit le résumé, ce qui consomme du quota. Cette option fait écrire ce résumé par un modèle gratuit, **Nemotron** de NVIDIA, via le service OpenRouter. Au moindre échec, Claude reprend la main et écrit le résumé normalement.

> **À savoir avant de l'activer.**
> - **Il faut une clé OpenRouter.** Elle est gratuite : créez-la sur <https://openrouter.ai/keys>.
> - **C'est la seule fonction de `cqr` qui envoie du texte de vos conversations à un tiers** : vos messages, les commandes lancées par Claude et leurs résultats partent chez NVIDIA, via OpenRouter. Le prompt système, la liste des outils et le raisonnement interne de Claude ne partent pas.
> - **Conditions de l'offre gratuite** (lues le 5 octobre 2026) : usage d'essai, hors production ; données confidentielles ou sensibles interdites ; NVIDIA peut réutiliser ce qui est envoyé et généré pour améliorer ses produits. Ce que vous envoyez peut donc être gardé et réutilisé.
> - **N'activez pas cette option sur un poste ou un projet confidentiel.**

Avant l'envoi, `cqr` masque ce qu'il reconnaît : les jetons et mots de passe (clés Anthropic, GitHub, AWS, OpenAI/OpenRouter, en-têtes `Authorization`, clés privées, `password=`, etc.) sont remplacés par `[SECRET-MASQUE]`, définitivement ; votre dossier personnel, votre nom d'utilisateur et les noms que vous ajoutez sont remplacés par un repère, puis remis en clair dans le résumé reçu. Ce filtre repose sur des formes connues : **un secret d'une forme inconnue passerait**. Dans le doute il masque plutôt trop que trop peu.

**Pas à pas :**

```bash
cqr compact gratuit cle <votre clé OpenRouter>   # enregistre la clé
cqr compact gratuit on                           # active l'option (effet immédiat)
cqr compact gratuit status                       # vérifie l'état (la clé n'est jamais affichée en clair)
```

- La clé est rangée dans le même fichier local `tokens.json` que vos comptes. Pour l'effacer : `cqr compact gratuit cle off`.
- Si la variable d'environnement `OPENROUTER_API_KEY` existe, **elle est prioritaire** sur la clé enregistrée.
- Attention : la commande `cqr compact gratuit cle <clé>` reste dans l'historique de votre terminal. Pour l'éviter, utilisez plutôt la variable `OPENROUTER_API_KEY`, ou effacez cette ligne de l'historique.
- Pour couper l'option : `cqr compact gratuit off`. Pour masquer des noms en plus (prénom, pseudo, société) : `cqr compact gratuit noms "nom,pseudo"` (3 caractères au moins chacun).

Seuls les compactages automatiques et manuels (`/compact`) passent par ce circuit ; les compactages d'urgence restent chez Claude. `proxy.log` note chaque cas sur une ligne (`COMPACT-GRATUIT ok…` ou `repli…`), jamais le contenu. Les réglages avancés (modèle, délai) sont dans le bloc `compaction.free` de `tokens.json`.

## Dépannage

### Mes deux comptes montrent toujours le même quota

Vos deux clés viennent probablement du même compte Claude. Vérifiez, sans dépenser de quota, pour chaque clé :

```bash
curl -s -D - -o /dev/null -X POST https://api.anthropic.com/v1/messages/count_tokens \
  -H "authorization: Bearer VOTRE_CLÉ" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}' | grep -i organization-id
```

(Sur un réseau d'entreprise, remplacez `https://api.anthropic.com` par votre relais.)

- `Organization-Id` **différents** : deux vrais comptes, tout va bien.
- `Organization-Id` **identiques** : c'est le même compte. Connectez-vous à <https://claude.ai>, déconnectez-vous complètement, reconnectez-vous avec l'autre compte, puis relancez `claude setup-token`. Mettez la nouvelle clé avec `cqr set <nom> <clé>`.

### `cqr status` dit ARRÊTÉ même après `cqr start`

Le programme a planté au démarrage ; `cqr start` en affiche la cause. Les plus fréquentes :

- **Le port est déjà pris** (message `EADDRINUSE`) : un autre programme (par exemple `wrangler dev`) utilise le port 8787. Changez-le : `cqr policy port 8788`, puis relancez Claude Code, qui lit le port à son démarrage.
- **Un fichier manque ou est abîmé** : relancez `node src/install.js`.
- **Un antivirus d'entreprise** bloque les programmes en arrière-plan : lancez-le au premier plan pour voir l'erreur, `node ~/.claude/claude-quota-relay/proxy.js`.

Le journal détaillé est `~/.claude/claude-quota-relay/proxy.log`.

### Réseau d'entreprise

Si `api.anthropic.com` est bloqué chez vous et que vous passez par un relais à vous (un Cloudflare Worker, par exemple), mettez son adresse dans `settings.json`, sous la variable `ANTHROPIC_TARGET_API_URL`. `cqr` l'utilise partout automatiquement. Ensuite : `cqr restart`.

### `Request timed out · attempt N/10`

Un réglage de délai manque dans `settings.json`. Relancez `node src/install.js` : il les remet.

## Référence

### Mettre à jour

```bash
cd claude-quota-relay
git pull
node src/install.js
```

Sans risque : vos clés, votre port et vos réglages sont conservés, les hooks et la barre d'état ne sont jamais dupliqués, `settings.json` est sauvegardé avant modification. Redémarrez Claude Code ensuite.

### Le fichier de config

Tout est dans `~/.claude/claude-quota-relay/tokens.json` (le dossier `.claude` peut être ailleurs si vous avez défini la variable `CLAUDE_CONFIG_DIR`) :

```jsonc
{
  "port": 8787,
  "switchAtPercent": 94,       // % de 5h au-delà duquel on préfère un autre compte
  "sevenDayBlockPercent": 99,  // ne jamais utiliser un compte au-delà de ce % sur 7 jours
  "waitAtSoftPercent": null,   // null = consommer jusqu'à 100 % avant d'attendre
  "maxWaitMs": 604800000,      // attente maximale d'une requête (7 jours)
  "serverErrorMaxMs": 900000,  // durée des réessais sur panne Anthropic (15 min ; 0 = coupé)
  "livePollMs": 0,             // vérification continue (0 = coupée)
  "tokens": [
    { "name": "compte-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "compte-2", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

Les blocs `compaction`, `workflowGuard` et `overage` (crédits) sont ajoutés automatiquement ; réglez-les avec les commandes `cqr` plutôt qu'à la main.

### Les délais (pourquoi l'attente marche)

Retenir une requête plusieurs heures ne marche que grâce à ces variables, posées par l'installeur dans `settings.json` :

| Variable | Valeur | Rôle |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | fait passer Claude Code par `cqr` |
| `API_TIMEOUT_MS` | 7 jours | délai maximum d'une requête |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 jours | la plus importante : sans elle, toute requête en attente meurt au bout de 5 min |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 jours | laisse les sous-agents attendre aussi |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 min | garde-fou bas niveau |
| `CLAUDE_CODE_MAX_RETRIES` | 15 | tentatives de Claude Code si `cqr` ne répond plus (environ 6 min) |

L'installeur règle aussi la barre d'état pour vérifier toutes les 10 s que `cqr` tourne, et le relancer s'il est mort (sauf après `cqr stop`).

### Limites

- Une requête sans streaming tombant pile en pleine saturation peut être coupée puis rejouée.
- Si l'ordinateur se met en veille pendant une attente, Claude Code coupe sa requête au réveil et la refait ; `cqr` la retient de nouveau. Au-delà de 60 minutes sans joindre Anthropic, l'erreur remonte.
- La protection sur 7 jours ne s'active qu'après une première réponse du compte.
- L'outil Workflow a son propre délai (environ 18 min par sous-agent) que `cqr` ne peut pas prolonger : lancez un gros workflow quand un compte au moins a du quota (`cqr preflight`).

### Désinstaller

```bash
node src/uninstall.js          # retire les réglages de cqr, garde tokens.json et la commande cqr
node src/uninstall.js --purge  # retire tout, y compris tokens.json et la commande cqr
```

La désinstallation arrête `cqr`, retire de `settings.json` ses variables et ses hooks, rend sa barre d'état d'origine si vous en aviez une, et supprime les commandes `/auth*`. Une sauvegarde de `settings.json` est conservée. Redémarrez Claude Code ensuite : il repasse en connexion directe.

## Licence

MIT, voir [LICENSE](LICENSE).
