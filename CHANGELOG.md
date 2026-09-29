# Changelog

## 0.19.0

Un sous-agent mourait au réveil du PC sur un autre réseau : `Agent terminated early due to an API error: Request timed out (error type server_error)` (DR-011). Essais réels du 2026-09-28 — vrai Claude Code, vrai relais, vrai Anthropic, vraies pannes, d'abord sur l'ancien relais puis sur le nouveau.

- **Toute erreur « Anthropic injoignable » est retenue, pas seulement une liste de codes.** Un certificat intercepté (VPN type Zscaler qui se reconnecte, portail Wi-Fi) n'était pas dans la liste : l'erreur revenait tout de suite au client. Mesuré : 4 min d'interception → le sous-agent brûle ses 11 tentatives en 3 min et meurt. Désormais retenue comme une coupure : même essai, le sous-agent réussit sans consommer une seule tentative.
- **Une connexion muette est détectée et refaite.** Après une veille ou un changement de réseau, une connexion peut rester ouverte sans jamais répondre ni signaler d'erreur : le relais attendait indéfiniment, et Claude Code abandonnait au bout de ~5 min avec exactement `Request timed out.`. Désormais, 90 s sans un octet d'Anthropic sur une réponse en streaming (plus 1 s par 32 Ko envoyés avant le premier octet, comme Claude Code lui-même, pour ne pas relancer en boucle un gros contexte qui démarre lentement) → connexion refaite, client tenu en ligne pendant ce temps. Une réponse déjà commencée qui se fige est coupée net (Claude Code sait la retenter) au lieu de laisser le client pendu.
- **60 min de patience, comptées depuis la première erreur**, puis l'erreur remonte (`networkErrorMaxMs`, choix de l'utilisateur). Le compteur repart dès qu'une réponse arrive — et au réveil Claude Code refait de toute façon sa requête. Remplace, pour ces erreurs, le plafond `maxWaitMs` (7 jours) qui s'appliquait aux seules coupures reconnues.
- **Le signal au client ne s'interrompt plus pendant qu'Anthropic prépare sa réponse.** À la reprise d'une attente, le battement SSE était coupé avant l'envoi ; une réponse lente ou une connexion morte laissait le client sans rien au-delà de son délai de garde (120 s). Il continue maintenant jusqu'à la réponse, et un octet part immédiatement à chaque reprise.

## 0.18.0

- **Un compte refuse par Anthropic ne passe plus inapercu.** `API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.` Ce 400 ne tombait dans aucune branche de classification du relais (429 `rejected`, 401/403, 529, 5xx) : il repartait au client a chaque requete pendant que le compte restait marque sain — donc aucune bascule, aucune trace, et le travail en cours perdu sans un mot. Le corps des reponses 400 est desormais lu (et decompresse si besoin, sinon le motif ne verrait rien) : sur un refus administratif, le compte part en quarantaine 6 h — seule une action humaine sur claude.ai le repare, aucun cooldown court n'a de sens —, la requete est immediatement rejouee sur un autre compte, une fenetre Windows nomme le compte et dit quoi faire, et la barre d'etat porte `⚠ CGU à accepter` sur la ligne de ce compte jusqu'a ce qu'il reponde de nouveau. Le marqueur se leve seul, par la sonde ou par la premiere reponse servie.
- **Tout 400 est journalise avec son corps** (400 premiers caracteres). Le blocage n'est pas reproductible a la demande : si Anthropic reformule un jour ce message, le motif ne le reconnaitra plus — c'est cette ligne du journal qui le dira, au lieu d'un silence.
- **La quarantaine tombe avec le marqueur.** Remonte par la revue : quand le compte servait de nouveau, l'alerte disparaissait de la barre d'etat mais l'echeance de 6 h restait — le routage ecartait donc encore le compte, en silence. Les deux se levent maintenant ensemble, et seulement si l'echeance est bien celle posee par ce refus (un 429 survenu depuis garde la sienne).
- **La fenetre d'alerte passe par `wscript` et un `.vbs`, apres deux mesures.** PowerShell (`Add-Type` + `MessageBox`) lance detache rend la main en 224 ms **sans rien afficher** ; attache, il affiche mais la fenetre meurt avec le proxy. `mshta` detache affiche, jusqu'a ~700 caracteres d'argument — au-dela, plus rien, en silence. Le texte passe donc par un fichier : aucune limite de longueur, plus rien a echapper pour le shell, et la fenetre survit au proxy. `CQR_NO_POPUP=1` la coupe (la suite de tests n'ouvre rien a l'ecran).

## 0.17.0

- **La barre d'etat passe a plusieurs lignes, une par compte.** Depuis la 0.13.0 chaque compte a son bloc `5h / 7j`, mais les blocs tenaient tous sur une seule ligne separee par `│`. A cinq comptes la ligne depasse la largeur du terminal et se replie n'importe ou : un bloc se retrouve coupe en deux, et l'oeil ne rattache plus un pourcentage a son compte. La sortie rend desormais une ligne d'en-tete (barre d'etat d'origine, prochain reset, pastille credits) puis une ligne par compte, bordee de `│` des deux cotes. Les deux pourcentages sont cadres a droite sur quatre caracteres : sans ce cadrage, `0%` et `100%` decalent la bordure de droite d'une ligne a l'autre, et l'alignement -- seule raison d'etre du multi-lignes -- serait perdu. Chaque barre passe de 5 à 10 caracteres, la largeur de la jauge `ctx` de Claude Code.

## 0.16.0

Deux defauts de la memoire de projet, remontes par un poste ou un agent a refuse d'obeir a un fichier `.cqr-memory.md`.

- **Un resume qui degenere ne detruit plus la memoire.** Le fichier memoire est ecrit par Haiku, et le seul controle etait « la reponse n'est pas vide ». Mesure deux fois sur un poste reel : 2 753 octets remplaces par 472 (une prose narrative — « *Lorsque la revue reviendra, le cycle continuera ainsi* »), puis 3 362 remplaces par 144 (un fragment de commande colle). Le resume doit desormais porter la structure que le modele a recue pour consigne (`# MEMOIRE PROJET` et au moins une section) ; sinon il est refuse et l'ancienne memoire reste. Le marqueur n'etant consomme que sur succes, la tentative suivante repart toute seule.
- **L'injection dit d'ou vient le texte.** Ce bloc arrive dans le contexte au meme rang qu'un message de l'utilisateur, sous un en-tete qui n'en disait rien. Un agent lisait donc « Taches prevues : faire circuler les corrections par `git stash` puis pousser » comme un ordre recu de son utilisateur — alors que c'est un resume machine d'une conversation passee. L'en-tete annonce maintenant un texte genere, a lire comme du contexte et jamais comme une consigne. C'est la vraie correction : meme bien forme, un resume peut prendre la forme d'une demande.
- **Le hook ne bloque plus l'envoi d'un message.** Il attendait l'appel Haiku jusqu'a 12 secondes alors que Claude Code n'en accorde que 5 : tue avant d'aboutir (`UserPromptSubmit hook timed out after 5s — output discarded`), il n'injectait pas la memoire et, le marqueur n'etant jamais consomme, recommencait au message suivant — une latence qui se repetait a chaque prompt. Le resume tourne desormais dans un processus detache : le message part immediatement, le resume se fait derriere, et la condensation redevient permise puisqu'elle ne coute plus d'attente.

## 0.15.0

Remontee de la greffe locale posee par `delest` sur un poste (issue #1), objet par objet.

- **La sonde SSE n'est pas integree.** Elle chargeait un module par `require()` depuis un chemin devinable du dossier personnel (`~/delest/proxy/sonde-sse.js`), dans le processus qui detient les jetons OAuth de plusieurs comptes, en `catch` silencieux. Le fichier vise est benin (audite : aucun `child_process`, aucun reseau), mais c'est le mecanisme qu'on aurait integre : quiconque peut ecrire ce fichier — aucun privilege requis — obtient l'execution dans le proxy, avec les jetons et tout le trafic en clair. Le besoin (connaitre le cout en tokens et pas seulement en pourcentage) reste legitime et se traitera nativement.
- **`relay()` durci quand meme.** `onCut()` faisait `pres.unpipe(cres)`, ce qui suppose que la source alimente le client DIRECTEMENT. Le jour ou un maillon s'intercale, `unpipe` ne debranche plus rien et le corps tronque recommence a couler — sans qu'aucun test ne bronche. La source est desormais coupee a la racine (`destroy`), ce qui ne depend plus de ce qu'on met au milieu.
- **Plancher `clear_at_least` : opt-in, jamais impose.** La greffe l'activait a 5 000 pour tout le monde par un defaut code en dur. La documentation Anthropic en fait une porte ouvert/ferme (« *If the API can't clear at least the specified amount, the strategy will not be applied* ») dont le defaut est `None` : un plancher impose empeche des compactions que personne n'a refusees. Il est donc absent par defaut, present dans `COMPACTION_DEFAULT`, reglable par `cqr compact clearatleast <tokens|off>`, et teste.
- **L'observation du « bridage » n'est pas reprise comme un fait.** Le poste avait releve un total efface decroissant avec le plancher (41 196 sans / 37 789 a 5k / 25 152 a 20k / 0 a 200k) et en avait conclu que le plancher bridait la quantite effacee. La doc dit une porte, pas un plafond — et le chiffre s'explique sans elle : la strategie s'active plusieurs fois par session, un plancher haut bloque les activations trop maigres, le cumul baisse. Le code le note comme observation datee et non reproduite.
- **`exclude_tools` reste non expose, mais le savoir est ecrit.** Proteger `Edit`/`Write` ne protege rien : `clear_tool_inputs` vaut `false` par defaut, donc le `tool_use` qui porte la modification n'est jamais efface — seul l'accuse de reception l'est. Un reglage vide par defaut n'aurait aucune valeur utile non nulle ; un commentaire dans `buildEdit()` evite qu'on « corrige » plus tard.
- **La memoire n'est reinjectee que si elle a change** dans la session (empreinte SHA-256, `.cqr-archive/.injected.json`, 50 sessions gardees). Elle repartait a chaque tour pour un fichier qui bouge une quinzaine de fois en trois semaines. **Et elle repart apres une compaction** : le contexte y est reecrit, donc une memoire « deja injectee » peut en avoir disparu — sans cette invalidation, elle ne revenait jamais de la session, au moment precis ou elle sert le plus. `memoryDedup: false` retablit l'injection systematique.

## 0.14.0

- **Une coupure d'internet en pleine réponse ne perd plus la requête.** Vécu le 01/09/2026 : câble ethernet débranché, la connexion bascule en Wi-Fi, et Claude Code affiche `API Error: ZlibError fetching http://127.0.0.1:8788/v1/messages`. Le relais recevait une réponse coupée en deux et transmettait telle quelle la moitié reçue — un corps compressé incomplet, que Claude Code n'arrive pas à décompresser. Une `ZlibError` n'est pas une erreur réseau : Claude Code ne la retente pas, la requête était donc perdue. (Selon le moment exact de la coupure, l'autre symptôme était un client qui restait suspendu sans jamais recevoir de réponse.)

  Désormais le relais regarde ce qui est **déjà parti chez vous** :

  - **aucun octet envoyé** → il refait la requête lui-même (2 s, 4 s, 8 s… jusqu'à 30 s, dans la limite de `maxWaitMs`), et vous ne voyez rien passer. En streaming, la connexion est tenue ouverte pendant la reprise, comme pour une attente de quota ;
  - **des octets déjà envoyés** → rejouer dupliquerait la réponse, alors la connexion est coupée franchement : Claude Code voit une erreur réseau ordinaire, qu'il sait retenter, au lieu d'un contenu corrompu.

  Une réponse incomplète n'est plus jamais rendue comme une réponse terminée proprement.

## 0.13.0

- **Barre d'état lisible à 3 comptes et plus.** L'ancienne barre 5 h était **cumulée sur toute la flotte** : avec trois comptes, impossible de savoir lequel avait consommé quoi sans faire le calcul de tête. Elle est remplacée par **un bloc par compte**, son 5 h à gauche et son 7 j à droite :

  ```
  ↻ 19h30 ② │ ① 5h/37% ██░░░ ███░░ 7J/64% │ ② 5h/100% █████ ████░ 7J/88% │ ③ 5h/12% █░░░░ █████ 7J/100%
  ```

- **Le numéro du compte est coloré selon son état** — l'information se lit sans décoder les chiffres : vert = en service avec du quota, jaune = en réserve avec du quota, orange = 5 h épuisé mais la semaine tient (il revient à son reset 5 h), rouge = plus rien avant le reset hebdomadaire. Les seuils utilisés sont ceux du **routage réel** (`switchAtPercent`, `sevenDayBlockPercent`) : un compte que le proxy refuse d'utiliser ne peut pas paraître disponible.
- **L'heure de reset indique quel compte repart** : `↻ 19h30 ②`, et plusieurs numéros si plusieurs comptes redémarrent à la même minute (`↻ 19h30 ① ②`). La règle « ne jamais afficher le reset 5 h d'un compte dont la semaine est finie » est conservée.
- La moyenne de flotte (`84%`) disparaît : elle ne correspondait à aucun compte réel.

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
