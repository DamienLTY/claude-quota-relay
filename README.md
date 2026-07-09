# claude-quota-relay

**Le problème :** vous avez plusieurs abonnements Claude, mais Claude Code n'en utilise qu'un seul. Quand son quota est épuisé, il s'arrête net :

```
API Error: Request rejected (429) · This request would exceed your account's rate limit.
```

**La solution :** ce projet installe un petit programme qui tourne sur votre ordinateur, entre Claude Code et Anthropic. Il jongle entre vos comptes tout seul. Quand l'un est plein, il passe au suivant. Quand ils sont tous pleins, il attend qu'un quota se libère et reprend automatiquement — même au milieu d'une longue tâche. Vous ne voyez rien, ça continue.

> Une image : c'est un standard téléphonique. Claude Code appelle un seul numéro (votre ordinateur) ; le standard redirige l'appel vers celui de vos comptes qui peut répondre.

Projet indépendant, gratuit, non affilié à Anthropic. N'utilisez que des comptes **qui vous appartiennent**, dans le respect des conditions d'Anthropic.

---

## Installer (3 commandes)

```bash
git clone https://github.com/DamienLTY/claude-quota-relay.git
cd claude-quota-relay
node src/install.js
```

L'installeur vous pose 2 questions (combien de comptes, et comment donner leur clé), configure tout seul, et vous dit de redémarrer. Puis :

1. **Redémarrez Claude Code.**
2. Ouvrez un **nouveau** terminal et tapez `cqr status`.

**Il vous faut juste :** [Node.js](https://nodejs.org) version 18 ou plus, et Claude Code déjà installé.

### Donner la clé de chaque compte

Pour chaque compte, l'installeur demande : **navigateur** ou **coller** ?

- **Navigateur** (le plus simple) : une fenêtre s'ouvre, vous vous connectez à ce compte Claude, la clé est récupérée toute seule.
- **Coller** : tapez `paste`, puis collez une clé que vous avez déjà (format `sk-ant-oat01-…`, obtenue via la commande `claude setup-token`). Pratique si le navigateur est bloqué sur votre machine.

> ⚠️ **Le piège le plus courant.** Vos comptes doivent être **vraiment différents** (deux abonnements, deux emails). Si vous générez deux clés en étant connecté au **même** compte Claude, ce sont deux clés du même compte → même quota → la bascule ne sert à rien. Comment vérifier : voir [« Mes deux comptes montrent le même quota »](#mes-deux-comptes-montrent-toujours-le-même-quota) plus bas.

---

## Au quotidien

Une seule commande à retenir :

```bash
cqr status
```

Elle montre, pour chaque compte : le quota utilisé (sur 5 h et sur 7 jours), l'heure du prochain reset, et si une attente est en cours. Exemple :

```
Proxy   : EN COURS (port 8787)
Actif   : compte-1
 > [0] compte-1   on  quota:5h=42% 7d=25%  reset5h~4h05
   [1] compte-2   on  quota:5h=9%  7d=1%   reset5h~4h05
```

Le reste est optionnel :

```bash
cqr list                 # liste les comptes (clés masquées)
cqr start | stop | restart   # gère le programme
cqr use <nom>            # force un compte précis
cqr auto                 # revient au choix automatique
```

**Gérer les comptes :**

```bash
cqr add [nom]            # ajoute un compte (navigateur, ou --paste pour coller)
cqr login <nom>          # reconnecte un compte
cqr set <nom> <clé>      # met une clé directement, sans question
cqr remove <nom>         # retire un compte
```

---

## Ce qui est actif tout seul (rien à faire)

### La bascule + l'attente

Le cœur du projet. À chaque requête, le programme choisit le compte le moins chargé, change de compte si celui-ci est refusé, et **patiente** si tous sont pleins (la requête reste ouverte, Claude Code croit juste que ça répond lentement, puis ça repart). Toujours actif.

Réglage principal — **à quel pourcentage changer de compte** :

```bash
cqr policy                     # voir les réglages
cqr policy waitsoft 85         # attendre dès 85 % au lieu d'aller jusqu'à 100 %
```

### L'auto-compaction (active par défaut)

**Quand le programme change de compte, il allège la requête envoyée au nouveau compte** — sans rien perdre. Il demande à Anthropic d'effacer les vieux résultats d'outils de la conversation (en gardant les plus récents), une fonction officielle qui **ne coûte aucun token**. Résultat : le compte tout neuf se remplit beaucoup plus lentement. Mesuré jusqu'à **-98 %** de tokens.

Rien n'est perdu : Claude Code garde tout son historique en local, on allège seulement ce qui part sur le réseau.

C'est **actif par défaut**. Ça n'agit qu'au moment d'un changement de compte, donc votre usage normal n'est pas touché. Pour régler ou couper :

```bash
cqr compact                    # voir l'état + tous les réglages
cqr compact off                # tout couper
cqr compact threshold opus 89  # % de quota qui déclenche la bascule pour Opus (défaut ci-dessous)
```

**Le % de bascule dépend du modèle** (un gros modèle risque plus de dépasser le quota d'un coup, donc on bascule plus tôt) :

| Modèle | Bascule à | Pourquoi |
|---|---|---|
| Fable | 85 % | peut sauter de 85 à 100 % en une requête |
| Opus | 89 % | gros modèle |
| Sonnet | 90 % | — |
| Haiku | 95 % | peu cher, on peut le pousser |

Change-les avec `cqr compact threshold <modèle> <pourcentage>`.

<details>
<summary>Réglage « seuil dynamique » (avancé, désactivé par défaut)</summary>

Le programme peut aussi **avancer** la bascule quand la conversation est déjà énorme (car une requête géante consomme beaucoup d'un coup). Sur un très gros contexte Opus (~800 000 tokens), ça faisait basculer dès ~68 % au lieu de 89 %. C'est mathématiquement prudent, mais **trop agressif** puisque l'auto-compaction réduit déjà la requête. Donc **désactivé par défaut**. Pour l'activer :

```bash
cqr compact dynamic on
cqr compact buffer 4     # marge de sécurité, en points
```
</details>

### La statusline (barre d'état)

Une ligne toujours visible dans Claude Code, montrant le quota de tous vos comptes :

```
5h █████████░ 84% ↻ 19h30 │ 7j ① ███░ 86% │ ② ████ 99%
```

Elle se met à jour **toute seule toutes les ~45 secondes**, même quand vous ne faites rien et attendez qu'un quota revienne — grâce à une petite vérification quasi gratuite (0 token de sortie). Réglage : `cqr live 30` (secondes) ou `cqr live off`. Si vous aviez déjà une barre d'état, la vôtre est gardée et la nôtre ajoutée à côté.

### Le garde-fou « workflow »

L'outil **Workflow** de Claude Code (qui lance plein de sous-agents d'un coup) abandonne un sous-agent bloqué au bout de ~18 minutes, et **le relais ne peut pas prolonger ce délai**. Donc, avant un gros workflow, un avertissement s'affiche si le quota est trop juste.

```bash
cqr preflight       # est-ce prudent de lancer un workflow maintenant ?
cqr guard ask       # (défaut) demande confirmation si risqué
cqr guard off       # désactive l'avertissement
```

---

## Problèmes courants

### Mes deux comptes montrent toujours le même quota

Vos deux clés viennent probablement du **même compte Claude** (voir le piège plus haut). Vérifiez, sans dépenser de quota — pour chaque clé :

```bash
curl -s -D - -o /dev/null -X POST https://api.anthropic.com/v1/messages/count_tokens \
  -H "authorization: Bearer VOTRE_CLÉ" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}' | grep -i organization-id
```

(Sur un réseau d'entreprise, remplacez `https://api.anthropic.com` par votre relais.)

- **`Organization-Id` différents** → deux vrais comptes, tout va bien.
- **`Organization-Id` identiques** → c'est le même compte. Régénérez une clé depuis un **autre** abonnement : connectez-vous à https://claude.ai, **déconnectez-vous complètement**, reconnectez-vous avec l'autre compte, puis relancez `claude setup-token`. Mettez la nouvelle clé avec `cqr set <nom> <clé>`.

### `cqr status` dit ARRÊTÉ même après `cqr start`

Le programme a planté au démarrage. `cqr start` vous montre alors la cause. Les plus fréquentes :

- **Le port est déjà pris** (message `EADDRINUSE`). Si vous utilisez Cloudflare Workers, `wrangler dev` prend le même port par défaut. → Changez-en un : `cqr policy port 8788`, puis `cqr restart`.
- **Un fichier manque ou est abîmé** → relancez `node src/install.js`.
- **Un antivirus d'entreprise** bloque les programmes en arrière-plan → lancez-le au premier plan pour voir l'erreur : `node ~/.claude/claude-quota-relay/proxy.js`.

Les journaux détaillés sont dans `~/.claude/claude-quota-relay/proxy.log`.

### Réseau d'entreprise (api.anthropic.com bloqué)

Si `api.anthropic.com` est bloqué chez vous et que vous passez par un relais perso (ex. un Cloudflare Worker), mettez son adresse dans `settings.json` sous la variable **`ANTHROPIC_TARGET_API_URL`**. Le programme la détecte et l'utilise **partout** automatiquement (bascule, vérifications de quota, statusline, compaction). Après l'avoir ajoutée : `cqr restart`.

### `Request timed out · attempt N/10`

Il manque un réglage de timeout dans `settings.json`. Relancez `node src/install.js`, qui les repose (voir le tableau plus bas).

---

## Référence

### Mettre à jour

```bash
cd claude-quota-relay
git pull
node src/install.js
```

Sans risque : vos clés, votre port et vos réglages sont conservés ; les hooks et la barre d'état ne sont jamais dupliqués ; `settings.json` est sauvegardé avant modification. Redémarrez Claude Code ensuite.

### Le fichier de config

Tout est dans `~/.claude/claude-quota-relay/tokens.json` :

```jsonc
{
  "port": 8787,
  "switchAtPercent": 94,       // % de 5h au-delà duquel on préfère un autre compte
  "sevenDayBlockPercent": 99,  // ne jamais utiliser un compte au-delà de ce % sur 7j
  "waitAtSoftPercent": null,   // null = consommer jusqu'à 100 % avant d'attendre
  "maxWaitMs": 604800000,      // attente maximale d'une requête (7 jours)
  "livePollMs": 45000,         // rafraîchissement de la statusline (0 = coupé)
  "tokens": [
    { "name": "compte-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "compte-2", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

Les blocs `compaction` et `workflowGuard` sont ajoutés automatiquement.

### Les timeouts (pourquoi l'attente marche)

Retenir une requête plusieurs heures ne marche que grâce à ces variables, posées par l'installeur dans `settings.json` :

| Variable | Valeur | Rôle |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | fait passer Claude Code par le programme |
| `API_TIMEOUT_MS` | 7 jours | délai maximum d'une requête |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 jours | **la plus importante** : sinon toute requête en attente meurt au bout de 5 min |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 jours | laisse les **sous-agents** attendre aussi |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 min | garde-fou bas niveau, déjà couvert par le signal du programme |

### Sécurité

- `tokens.json`, `state.json` et les journaux sont **ignorés par git** : jamais commités par erreur.
- Vos clés ne quittent jamais votre machine : le programme n'écoute que sur `127.0.0.1` (votre ordinateur seul).
- Les journaux masquent toujours les clés.

### Limites honnêtes

- Une requête **non-streaming** tombant pile en pleine saturation peut être coupée puis rejouée.
- Si l'ordinateur se **met en veille** pendant une attente, la connexion peut se couper ; Claude Code réessaie au réveil.
- La protection sur les 7 jours ne s'active qu'après une première réponse du compte.
- L'outil **Workflow** a son propre délai (~18 min par sous-agent) que le relais ne peut pas prolonger. Lancez un gros workflow quand au moins un compte a du quota (`cqr preflight`).

### Désinstaller

```bash
node src/uninstall.js          # retire nos réglages, garde tokens.json et la commande cqr
node src/uninstall.js --purge  # retire tout, y compris tokens.json et la commande cqr
```

Redémarrez Claude Code ensuite.

## Licence

MIT — voir [LICENSE](LICENSE).
