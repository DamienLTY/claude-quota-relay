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

Pour tout revoir d'un coup : `cqr help` liste toutes les commandes.

Le reste est optionnel :

```bash
cqr help                 # liste toutes les commandes
cqr list                 # liste les comptes (clés masquées)
cqr start | stop | restart   # gère le programme (stop = arrêt voulu : la barre d'état ne le relance pas)
cqr use <nom>            # force un compte précis
cqr auto                 # revient au choix automatique
```

> Les réglages (compaction, seuils, politique) sont pris en compte **tout de suite**, sans rien redémarrer. Les deux seuls qui ont besoin d'un redémarrage — le **port** et la **cadence de la statusline** — redémarrent le proxy **automatiquement** pour vous.

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

**Surcharge chez Anthropic (`529`).** Le compte est mis en pause et la requête part sur l'autre compte. Si la surcharge dure, les tentatives **s'espacent** (90 s, 3 min, puis 5 min au maximum) au lieu de marteler le serveur. Pendant ce temps la sonde de quota, qui est minuscule, peut très bien passer : elle ne lève pas la pause pour autant, sinon on relâcherait la vraie requête pour reprendre un refus.

**Panne chez Anthropic (« API Error: 500 »).** Un `500` n'est pas une limite de quota, c'est un serveur qui a un problème — et c'est souvent intermittent (une requête passe, la suivante échoue). Le programme **retente automatiquement** la même requête, en espaçant les essais (2 s, 4 s, 8 s… jusqu'à 1 min), pendant **15 minutes** par défaut. Pas besoin de savoir quand la panne est réparée : c'est l'essai qui aboutit qui le prouve. Si ça échoue encore au bout des 15 minutes, la vraie erreur vous est rendue (une requête que le serveur refuse *toujours* ne doit pas rester suspendue). Réglable par `serverErrorMaxMs` dans la config (`0` = ne rien retenter).

**Coupure d'internet en pleine réponse (câble débranché, bascule Wi-Fi, VPN qui se reconnecte).** La réponse d'Anthropic s'arrête au milieu. Selon ce qui est déjà arrivé chez vous :

- **rien n'est encore parti** → le programme **refait la requête tout seul** (2 s, 4 s, 8 s… jusqu'à 30 s) et vous ne voyez rien passer ;
- **une partie de la réponse est déjà arrivée** → elle ne peut pas être rejouée sans se dupliquer, alors la connexion est **coupée franchement**. Claude Code affiche une erreur réseau ordinaire, qu'il sait retenter.

Ce qu'il ne fait plus, c'est laisser passer une réponse à moitié écrite : Claude Code n'arrivait alors plus à la décompresser et affichait `API Error: ZlibError fetching http://127.0.0.1:8788/v1/messages` — une erreur qu'il ne retente pas, donc la requête était perdue.

**Veille, changement de réseau, VPN qui se reconnecte (Zscaler…).** Au réveil, le réseau n'est pas toujours prêt : pas de connexion du tout, certificat intercepté le temps que le VPN revienne, ou connexion restée ouverte mais muette. Dans tous ces cas, le programme **retient la requête et réessaie** — 90 s de silence d'Anthropic suffisent à tenir une connexion pour morte et à la refaire — en gardant Claude Code en ligne pendant ce temps. Il patiente **60 minutes** à partir de la première erreur, puis rend l'erreur pour que vous la voyiez. Réglable par `networkErrorMaxMs` dans la config. Sans cela, Claude Code épuisait ses tentatives en quelques minutes et le sous-agent mourait avec `Request timed out`.

### L'auto-compaction (active par défaut)

**Quand le programme change de compte, il allège la requête envoyée au nouveau compte** — sans rien perdre. Il demande à Anthropic d'effacer les vieux résultats d'outils de la conversation (en gardant les plus récents), une fonction officielle qui **ne coûte aucun token**. Résultat : le compte tout neuf se remplit beaucoup plus lentement. Mesuré jusqu'à **-98 %** de tokens.

Rien n'est perdu : Claude Code garde tout son historique en local, on allège seulement ce qui part sur le réseau.

C'est **actif par défaut**. Ça n'agit qu'au moment d'un changement de compte, donc votre usage normal n'est pas touché. Pour régler ou couper :

```bash
cqr compact                    # voir l'état + tous les réglages
cqr compact off                # tout couper
cqr compact threshold opus 89  # % de quota qui déclenche la bascule pour Opus (défaut ci-dessous)
cqr compact clearatleast 5000  # n'effacer que si ça rapporte au moins 5000 tokens (défaut : off)
cqr compact memory-dedup off   # réinjecter la mémoire du projet à chaque tour (défaut : si changée)
```

`cqr compact off` coupe **tout** : l'effacement des vieux résultats d'outils **et** la mémoire factuelle du projet (plus de `.cqr-memory.md` rebâti ni envoyé à Claude), même si cette mémoire ne coûte plus aucun quota. `cqr compact on` remet tout.

Deux réglages qui demandent un mot d'explication :

- **`clearatleast`** — effacer de vieux résultats d'outils casse le cache de la conversation, ce qui se paie. Ce plancher dit « n'efface que si tu récupères au moins tant de tokens », sinon on ne touche à rien. Désactivé par défaut, comme chez Anthropic : un plancher trop haut empêche des compactions utiles.
- **`memory-dedup`** — la mémoire du projet n'est renvoyée que si elle a **changé** depuis le dernier envoi de la session, au lieu de repartir à chaque tour (environ 730 à 830 tokens à chaque fois, pour un fichier qui bouge quelques fois par semaine). Elle repart toujours au démarrage d'une session **et après chaque compactage**, puisque le compactage réécrit la conversation et peut l'en faire disparaître.

Ce que la mémoire du projet **est**, et ce qu'elle n'est pas : un **état factuel bâti sans modèle** (aucun appel à Claude, aucun quota), relu par Claude au début de chaque session et après chaque compactage. Il tient dans `.cqr-memory.md`, à la racine du dossier, et contient, dans cet ordre :

- les **5 derniers commits** et les **fichiers non commités** (`git`, avec un délai : si git ne répond pas, la section est simplement omise) ;
- la section **« En cours »** de `TODO.md` (les cases cochées n'y sont pas reprises) ;
- les **5 dernières décisions** de `REGISTRE-DECISIONS.md` (lignes `| DR-…`, question tronquée) ;
- une section **« Notes »**, que rien ne réécrit : à la première reconstruction, l'ancien résumé y est recopié tel quel ; ensuite le programme la recopie à l'identique, et vous pouvez y écrire à la main.

Chaque section n'apparaît que si sa source existe : sans git ni `TODO.md`, il ne reste que les notes. Les fichiers du projet font foi — l'en-tête du fichier le dit, et le bloc envoyé à Claude aussi : c'est du contexte, jamais une consigne, pour qu'un agent ne prenne pas une ligne de « En cours » pour un ordre que vous auriez donné. L'injection est bornée à environ 4 Ko (les faits d'abord, les notes dans ce qui reste ; le fichier, lui, n'est jamais tronqué). Le fichier et son dossier d'archive sont exclus de git par le fichier `info/exclude` du dépôt, worktree compris (jamais en modifiant votre `.gitignore`).

Avant la 0.21.0, c'était un résumé écrit par un petit modèle (Haiku), qui dérivait : il donnait comme « en cours » des tâches finies depuis des heures. Il a été retiré plutôt que corrigé.

**Le % de bascule dépend du modèle** (un gros modèle risque plus de dépasser le quota d'un coup, donc on bascule plus tôt) :

| Modèle | Bascule à | Pourquoi |
|---|---|---|
| Fable | 85 % | peut sauter de 85 à 100 % en une requête |
| Opus | 89 % | gros modèle |
| Sonnet | 90 % | — |
| Haiku | 95 % | peu cher, on peut le pousser |

Change-les avec `cqr compact threshold <modèle> <pourcentage>`.

<details>
<summary>Réglage « compaction dynamique » (avancé, désactivé par défaut)</summary>

Quand la conversation devient énorme (contexte de plusieurs centaines de milliers de tokens), une seule requête consomme beaucoup d'un coup. La compaction dynamique **allège alors la requête sur le compte que vous utilisez déjà — sans changer de compte**. Vous restez sur la même clé, elle dure juste plus longtemps.

C'est **désactivé par défaut**. L'activer active aussi l'auto-compaction (sinon ça n'aurait aucun effet) :

```bash
cqr compact dynamic on     # active la compaction dynamique (+ l'auto-compaction)
cqr compact buffer 4       # marge de sécurité, en points
cqr compact dynamic off    # revient à : on n'allège qu'au changement de compte
```
</details>

### Le compactage gratuit (coupé par défaut)

Quand Claude Code compacte la conversation — tout seul vers 300 000 tokens, ou quand vous tapez `/compact` —, c'est normalement Claude qui écrit le résumé, et ça consomme du quota. Cette option fait écrire ce résumé par **Nemotron 3 Ultra** (NVIDIA, offre gratuite via OpenRouter) à la place. **Au moindre échec, Claude reprend** et écrit le résumé comme s'il ne s'était rien passé.

**C'est coupé par défaut, et ça se règle poste par poste** (le réglage vit dans le `tokens.json` de chaque PC). Ne l'activez pas sur un poste ou un projet confidentiel : c'est la seule fonction du programme qui envoie du texte de conversation à un tiers.

```bash
export OPENROUTER_API_KEY=...        # votre clé OpenRouter, dans l'environnement du relais (puis : cqr restart)
cqr compact gratuit on               # activer (effet immédiat)
cqr compact gratuit noms "nom,pseudo"  # noms supplémentaires à masquer (facultatif, 3 caractères au moins chacun)
cqr compact gratuit status           # état, modèle, noms, clé vue ou non dans ce terminal
cqr compact gratuit off              # couper
```

La clé n'est lue que dans la variable d'environnement `OPENROUTER_API_KEY` du relais : elle n'est écrite ni dans `tokens.json` ni dans les journaux, et `cqr` ne l'affiche jamais.

**Ce qui part chez NVIDIA** (via OpenRouter) : le texte de la conversation — vos messages, les commandes que Claude a lancées et leurs résultats. Ne partent pas : le prompt système, la liste des outils, le raisonnement interne de Claude. Avant l'envoi :

- les **jetons et mots de passe** reconnus sont remplacés par `[SECRET-MASQUE]`, **définitivement** : ils ne reviennent jamais dans le résumé. Sont reconnus : les clés Anthropic, GitHub, AWS, Google, OpenAI/OpenRouter, Slack, Stripe (`sk_live_`, `sk_test_`, `rk_live_`), npm, Hugging Face et GitLab ; les jetons JWT ; les en-têtes `Authorization: Bearer|Basic`, `Cookie` et `Set-Cookie` ; le mot de passe d'une adresse (`https://nom:motdepasse@hôte`) ; `sshpass -p` et `mysql -p` ; les clés privées, **du `BEGIN` au `END`** (quand le `END` manque : jusqu'au message suivant de la conversation, ou jusqu'à la fin du texte) ; les affectations `token=`, `api_key=`, `password=`, `secret=`, `private_key=`, `access_key=` et `PASS=`, quelle que soit la valeur, sauf un nombre derrière `token` (`max_tokens: 32768` reste lisible) ; les options `--password`, `--passwd`, `--pwd`, `--token` et `--secret`, `curl -u nom:motdepasse` et `login -p` ; et la valeur exacte de `OPENROUTER_API_KEY` et de chaque jeton de `tokens.json`. Ce filtre repose sur des formes connues : un secret d'une forme inconnue passerait. À l'inverse, dans le doute il masque trop plutôt que trop peu : environ 1,3 % des lignes d'un dépôt chargé en `token` ont été masquées à tort (mesuré), et ce qui est masqué ne revient pas dans le résumé ;
- votre **dossier personnel** (écrit `C:\Users\vous`, `C:/Users/vous`, `/c/Users/vous` ou `C--Users-vous`), votre **nom d'utilisateur**, le **nom de votre dossier personnel** et les **noms** ajoutés avec `cqr compact gratuit noms` sont remplacés par un repère (`[PERSO-a1b2c3-1]`…), un par chaîne d'origine, majuscules comprises. Un nom d'utilisateur ou de dossier de moins de 3 caractères n'est pas masqué seul (il couperait des mots ordinaires) ; le chemin complet l'est toujours. Les repères sont **remis en clair** dans le résumé que reçoit Claude Code : la session suivante retrouve ses vrais chemins. Le repère porte un nombre tiré au hasard à chaque envoi : un `[PERSO-1]` déjà présent dans votre texte n'est jamais remis en chemin, et si le résumé contient un repère que le relais n'a pas posé, Claude reprend la main.

**Conditions de l'offre gratuite** (lues le 5 octobre 2026) : l'accès d'essai de NVIDIA est réservé à un usage d'essai, hors production ; il est interdit d'y envoyer des données confidentielles ou sensibles ; NVIDIA peut réutiliser le contenu envoyé et généré pour améliorer ses produits. Ce que vous envoyez peut donc être gardé et réutilisé.

**Quels compactages** : les automatiques (`auto`) et les manuels (`manual`, la commande `/compact`). Les compactages « réactifs » (déclenchés en urgence quand le contexte déborde) restent toujours chez Claude, même si la config le demande. Le relais reconnaît un compactage à l'en-tête que Claude Code envoie (posé par l'installeur, session démarrée après l'installation) : sans cet en-tête, Claude écrit le résumé. L'invite native est cherchée dans le dernier message qui n'est pas de rôle `system` : Claude Code 2.1.289 termine sa requête de compactage par un message `system` vide.

**Quand Claude reprend la main**, sans rien perdre :

- avant tout envoi : réglage coupé, compactage coupé ou absent (`cqr compact off` coupe tout, ceci compris), clé absente, type non listé, conversation estimée à plus de 900 000 tokens, ou blocage de 10 minutes après une panne du service (erreur HTTP ou réseau, délai dépassé, réponse trop grosse, réponse illisible `json-invalide` ou sans choix `sans-choix` ; un résumé refusé, lui, ne bloque pas) ;
- après l'envoi : erreur du service ou du réseau, plus de 240 s d'attente, réponse de plus de 2 Mio (la connexion est coupée), ou résumé refusé (réponse non terminée, balise `<summary>` absente, résumé de moins de 1 500 caractères, repère inconnu). Aucun résumé n'est rendu à Claude Code tant qu'il n'est pas valide. Pendant les 60 premières secondes, rien n'est envoyé du tout au client : un repli rapide lui rend la vraie réponse de Claude, erreur comprise (un 400 reste un 400). Au-delà de 60 s, des battements gardent la connexion ouverte, et un repli tardif ne peut plus rendre qu'une erreur de flux (SSE) si Claude refuse ;
- si Claude Code abandonne sa requête, l'appel à OpenRouter est coupé.

`proxy.log` note chaque cas sur une ligne, jamais le contenu : `COMPACT-GRATUIT ok motif=auto duree=… caracteres=…`, `COMPACT-GRATUIT repli raison=…`, `COMPACT-GRATUIT abandon raison=client-parti`.

**Les variantes** (fichier `~/.etabli/compactage.json`, clé `variante`) : `hybride` (défaut ; la queue de la conversation, `queue_jetons`, 25 000 par défaut), `tete-queue` (comme `hybride`, plus les `tete_jetons` premiers jetons : défaut 8000, plafond 50000), `court` (toute la conversation, résumé borné par `court_max_jetons`) et `journal` (aucun appel au modèle). Fichier illisible, trop gros ou variante inconnue : `journal`. La réponse du modèle est plafonnée à `max_tokens` 8000 en `hybride` et `tete-queue` (DR-122).

**Mesure et délai, différents de ceux d'openrouter-relay** : la tête et la queue sont mesurées en caractères du rendu texte ici, et par `sizeOf` (texte plus appels d'outils) dans openrouter-relay, donc les coupes diffèrent légèrement d'un relais à l'autre. Délai d'attente : 240 s ici (DR-123), 200 s dans openrouter-relay (DR-120).

Réglages avancés, dans `compaction.free` de `tokens.json` : `model` (défaut `nvidia/nemotron-3-ultra-550b-a55b:free`), `kinds` (`["auto","manual"]`), `timeoutMs` (240000), `minSummaryChars` (1500), `names`.

### La statusline (barre d'état)

Toujours visible dans Claude Code, elle montre le quota de tous vos comptes :

```
↻ 19h30 ② │
│ ①  5h/ 37% ████░░░░░░ ██████░░░░ 7J/ 64% │
│ ②  5h/100% ██████████ █████████░ 7J/ 88% │
│ ③  5h/ 12% █░░░░░░░░░ ██████████ 7J/100% │
```

**Une ligne par compte** : son 5 h à gauche, son 7 j à droite, chacun avec sa barre. Vous lisez directement ce que *ce* compte a consommé, sans rien recalculer. Une seule ligne pour toute la flotte se repliait n'importe où dès cinq comptes, coupant un bloc en deux ; les barres ont la largeur de la jauge `ctx` de Claude Code, pour un alignement d'ensemble.

Le **numéro du compte** est coloré selon son état, pour le voir d'un coup d'œil sans lire les chiffres :

| Couleur | État |
|---|---|
| 🟢 vert | c'est le compte en service, et il lui reste du quota |
| 🟡 jaune | en réserve, du quota disponible (5 h et 7 j) |
| 🟠 orange | son 5 h est épuisé, mais sa semaine tient : il revient à son reset 5 h |
| 🔴 rouge | plus rien d'utilisable avant le reset hebdomadaire |

L'heure après le `↻` est celle du **prochain reset 5 h utile**, suivie du ou des comptes qui repartent à ce moment-là (`↻ 19h30 ① ②` si plusieurs tombent à la même minute). Elle ne tient compte que des comptes qui ont encore du quota **hebdomadaire** : un compte dont la semaine est finie ne redevient pas utilisable à son reset 5 h — afficher son heure serait un faux espoir. Si plus **aucun** compte n'a de quota hebdomadaire, c'est le reset **hebdomadaire** le plus proche qui s'affiche, marqué et daté : `↻7j sam 02h00`.

**Quand se met-elle à jour ?** À chaque échange avec Claude Code — c'est lui qui la redessine, elle ne se rafraîchit pas toute seule entre deux messages. Le programme mesure donc les quotas là où ça compte : le compte qui sert la requête se renseigne par la réponse elle-même, les autres sont vérifiés à cette occasion (petite requête, 0 token de sortie), et pendant une attente de quota une vérification part toutes les 2 minutes. Au repos, **zéro trafic**.

Si vous voulez quand même une vérification en continu (par exemple pour lire la barre d'état pendant qu'une longue tâche tourne) : `cqr live 120` (secondes), `cqr live off` pour revenir au défaut. Si vous aviez déjà une barre d'état, la vôtre est gardée et la nôtre ajoutée à côté.

### Les crédits d'usage supplémentaire (« extra usage ») — désactivés par défaut

Si Anthropic vous a donné (ou vous a vendu) des **crédits d'usage supplémentaire**, votre compte continue de répondre **même une fois le forfait épuisé** : Anthropic sert la requête et la facture aux crédits. Techniquement, la réponse arrive en `200` avec l'en-tête `anthropic-ratelimit-unified-status: rejected` **et** `anthropic-ratelimit-unified-overage-status: allowed`.

Deux conséquences, traitées séparément :

1. **Le compte n'est plus mis en quarantaine à tort.** Une réponse servie sur les crédits est une réponse *réussie* : le relais la rend au client et n'attend aucun reset. C'est corrigé pour tout le monde, sans réglage.
2. **Les crédits peuvent servir de dernier recours** — mais uniquement si vous le demandez, parce qu'ils peuvent être **facturés** :

```bash
cqr credits              # ai-je des crédits ? combien m'en reste-t-il ?
cqr credits on           # autoriser leur usage quand plus AUCUN compte n'a de forfait
cqr credits budget 20 EUR  # montant de vos crédits -> affichage en argent restant
cqr credits max 50       # n'en consommer que la moitié, puis se remettre à attendre
cqr credits off          # revenir au comportement d'origine (attendre le reset)
```

**Dans la statusline : une pastille, rien de plus.** Une fois les crédits autorisés, la barre d'état se termine par une pastille qui décrit le **compte utilisé en ce moment** :

| Pastille | Ce que ça veut dire |
|---|---|
| `crédits ●` vert | ce compte est **servi sur les crédits** (forfait épuisé, ça continue quand même) |
| `crédits ◐` jaune | vous consommez votre **forfait** normal, et il reste des crédits **disponibles** en réserve |
| `crédits ○` rouge | **plus rien d'utilisable** sur ce compte : crédits épuisés, désactivés, ou au-delà de votre plafond `cqr credits max` |

La forme change en même temps que la couleur, donc ça reste lisible sans couleurs (`NO_COLOR`).

**Pourquoi pas le montant restant ?** Anthropic ne nous le donne pas : l'endpoint qui le contient (`/api/oauth/usage` → `monthly_limit` / `used_credits` / `currency`) **refuse nos clés** — celles de `claude setup-token` n'ont pas le droit de lire la facturation (`403 : scope user:profile`). Seul le **pourcentage consommé** nous parvient. Si vous connaissez votre montant, donnez-le une fois et `cqr credits` / `cqr status` afficheront l'argent restant (la statusline, elle, garde la pastille) :

```bash
cqr credits budget 20 EUR        # 20 € pour tous les comptes
cqr credits budget compte-2 50   # montant propre à un compte
```

Règles appliquées :

- **jamais avant d'avoir épuisé le forfait gratuit** — tant qu'un compte a du quota, c'est lui qui sert ;
- **les crédits couvrent aussi la limite hebdomadaire (7 j)** : c'est le seul moyen de continuer quand la semaine est finie, au lieu d'attendre plusieurs jours ;
- un vrai refus du serveur (`429`) reste un refus : le compte passe en pause, comme avant ;
- si `cqr credits` affiche « indisponibles — l'usage supplémentaire est désactivé sur ce compte », c'est un réglage **de votre compte Anthropic**, à activer sur [claude.ai/settings/usage](https://claude.ai/settings/usage).

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

- **Le port est déjà pris** (message `EADDRINUSE`). Si vous utilisez Cloudflare Workers, `wrangler dev` prend le même port par défaut. → Changez-en un : `cqr policy port 8788` (le proxy redémarre tout seul ; pensez juste à relancer Claude Code, qui lit le port à son démarrage).
- **Un fichier manque ou est abîmé** → relancez `node src/install.js`.
- **Un antivirus d'entreprise** bloque les programmes en arrière-plan → lancez-le au premier plan pour voir l'erreur : `node ~/.claude/claude-quota-relay/proxy.js`.

Les journaux détaillés sont dans `~/.claude/claude-quota-relay/proxy.log` ; les lignes `VIE` y gardent la trace des démarrages, sorties, signaux et arrêts brutaux. Chaque ligne `RESP` porte `classe=` (le type de requête : `main`, `subagent`, `workflow`, `compaction`, `auxiliary`) et `session=` (les 8 premiers caractères de l'identifiant de session, jamais l'identifiant entier), et une ligne `CLAUDE-COMPACT motif=auto|manual|reactive` marque chaque compactage que Claude Code lance lui-même (à ne pas confondre avec `COMPACT`, la compaction du relais à la bascule de compte). Ces informations viennent de `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, posé par l'installeur quand elle est absente : seules les sessions Claude Code démarrées après l'installation l'envoient. Le relais ne transmet pas ces en-têtes d'indice à Anthropic.

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
  "serverErrorMaxMs": 900000,  // durée de retry sur panne Anthropic 5xx (15 min ; 0 = coupé)
  "livePollMs": 0,             // sonde continue (0 = coupée : quotas rafraîchis à chaque requête)
  "tokens": [
    { "name": "compte-1", "token": "sk-ant-oat01-…", "enabled": true },
    { "name": "compte-2", "token": "sk-ant-oat01-…", "enabled": true }
  ]
}
```

Les blocs `compaction`, `workflowGuard` et `overage` sont ajoutés automatiquement. Le bloc `overage` pilote les crédits d'usage supplémentaire (`{ "use": false, "maxPercent": 100 }` par défaut — voir plus haut) ; réglez-le avec `cqr credits` plutôt qu'à la main.

### Les timeouts (pourquoi l'attente marche)

Retenir une requête plusieurs heures ne marche que grâce à ces variables, posées par l'installeur dans `settings.json` :

| Variable | Valeur | Rôle |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | fait passer Claude Code par le programme |
| `API_TIMEOUT_MS` | 7 jours | délai maximum d'une requête |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 7 jours | **la plus importante** : sinon toute requête en attente meurt au bout de 5 min |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 7 jours | laisse les **sous-agents** attendre aussi |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` | 2 min | garde-fou bas niveau, déjà couvert par le signal du programme |
| `CLAUDE_CODE_MAX_RETRIES` | 15 | tentatives de Claude Code quand le programme ne répond plus (~6 min au lieu de ~3) : le temps de le relancer |

L'installeur règle aussi `statusLine.refreshInterval` à 10 s : la barre d'état vérifie alors toutes les 10 s que le programme tourne, et le relance s'il est mort (sauf après `cqr stop`).

### Sécurité

- `tokens.json`, `state.json` et les journaux sont **ignorés par git** : jamais commités par erreur.
- Vos clés ne quittent jamais votre machine : le programme n'écoute que sur `127.0.0.1` (votre ordinateur seul).
- Les journaux masquent toujours les clés.
- Seul le compactage gratuit, coupé par défaut, envoie du texte de conversation à un tiers : voir sa section plus haut.

### Limites honnêtes

- Une requête **non-streaming** tombant pile en pleine saturation peut être coupée puis rejouée.
- Si l'ordinateur se **met en veille** pendant une attente, Claude Code coupe lui-même sa requête au réveil et la refait : le programme la retient de nouveau. Au-delà de 60 min sans pouvoir joindre Anthropic, l'erreur remonte.
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
