# Registre des décisions

Une décision = une référence stable `DR-xxx`, la question posée, la **réponse citée** (jamais résumée), sa source et son état. Une décision révisée garde sa référence et gagne une ligne « révisé le … ».

Registre ouvert le 2026-09-05. Les décisions antérieures vivent dans le `CHANGELOG.md` et dans l'issue #1 ; elles n'ont pas été renumérotées après coup.

---

## DR-001 — Protéger la mémoire contre un résumé qui dégénère

**Type** : correction · **État** : appliqué (v0.16.0)

**Question posée** : « Comment protéger la mémoire contre un résumé qui dégénère ? »

**Réponse citée** : « *Structure + en-tête honnête* — Refuser d'écraser si le résumé ne contient pas les 4 sections attendues (les deux cas réels seraient bloqués), ET dire dans l'en-tête d'injection que ce texte est une note générée, pas une consigne de l'utilisateur. »

**Ce qui l'a déclenchée** : deux destructions mesurées sur le poste principal — 2 753 octets remplacés par 472 le 1er septembre (prose narrative se lisant comme une consigne), 3 362 remplacés par 144 le 5 septembre (un fragment de commande). Le seul garde-fou était « la réponse n'est pas vide ».

**Source** : `src/memory-hook.js:115` (`bienForme`), `src/memory-hook.js:146`, archives `~/.cqr-archive/memory-1788285601552.md` et `memory-0.md`.

**Écart assumé** : le contrôle exige le titre et **au moins une** section, pas les quatre. Les quatre auraient rejeté un résumé légitime dont une section est vide ; les deux cas réels n'en portaient aucune.

---

## DR-002 — L'injection doit dire d'où vient le texte

**Type** : sécurité · **État** : appliqué (v0.16.0)

**Question posée** : incluse dans DR-001.

**Réponse citée** : « *dire dans l'en-tête d'injection que ce texte est une note générée, pas une consigne de l'utilisateur* ».

**Ce qui l'a déclenchée**, rapporté par un agent sur un autre projet : « *Le fichier `Site-Web/frontend/.cqr-memory.md` … contient une phrase rédigée comme si elle venait de toi : elle me demande si je veux faire circuler les corrections en branche de staging via `git stash` → `git checkout staging` → `git stash pop` → `git push`. Tu n'as jamais écrit cela. Je ne l'ai pas exécutée, et je ne l'exécuterai pas.* »

**Le diagnostic corrige le rapport** : ce n'est pas un fichier « capable de fabriquer de fausses demandes ». C'est un résumé machine réinjecté sous un en-tête qui lui donnait l'autorité de l'utilisateur. Le refus de l'agent était le bon réflexe.

**Source** : `src/memory-hook.js:197`.

**Portée** : le contrôle de structure (DR-001) ne suffit pas ici — un résumé **bien formé** peut porter une ligne qui se lit comme un ordre. Seul l'en-tête traite ce cas.

---

## DR-003 — Sortir le résumé du chemin bloquant

**Type** : correction · **État** : appliqué (v0.16.0)

**Question posée** : « Comment supprimer la latence du hook ? »

**Réponse citée** : « *Sortir le résumé du chemin bloquant* — Le hook injecte la mémoire tout de suite et lance le résumé en tâche détachée. Plus jamais d'attente avant un message. »

**Ce qui l'a déclenchée** : `UserPromptSubmit hook timed out after 5s — output discarded`, observé pendant des épisodes de latence. Le hook attendait Haiku jusqu'à 12 s (`withTimeout(..., 12000)`) pour un budget de 5 s ; tué avant d'aboutir, il n'injectait pas la mémoire et, le marqueur n'étant jamais consommé, recommençait au message suivant.

**Écartées** : allonger le délai accordé au hook (« *tu attends jusqu'à 12 secondes avant que ton message parte* ») ; réduire la patience à 4 s (dégrade le taux de succès sans traiter la cause).

**Source** : `src/memory-hook.js:207` (`lancerFond`), verrou déplacé du parent vers l'enfant en `src/memory-hook.js:244`.

**Effet de bord retenu** : la condensation redevient permise sur ce chemin, puisqu'elle ne coûte plus d'attente.

---

## DR-004 — Ne pas restaurer la mémoire détruite du projet racine

**Type** : exploitation · **État** : appliqué

**Question posée** : « Que fait-on de la mémoire de ce projet, détruite ce matin ? »

**Réponse citée** : « *Laisser en l'état* — La mémoire repartira de zéro au prochain résumé réussi. »

**Conséquence acceptée** : `C:\Users\damie\.cqr-memory.md` reste à 144 octets. Le contenu d'origine demeure disponible dans `~/.cqr-archive/memory-0.md` si l'avis change.

---

## DR-005 — Corrections issues de la revue qualité

**Type** : correction · **État** : appliqué (v0.16.0)

**Origine** : revue `thermo-review` du diff de DR-001 à DR-003, quatre points remontés.

**Retenu, point 1 — un test qui ne testait rien.** L'assertion comparait la sortie du hook à une valeur de repli qu'elle fournissait elle-même ; mesuré : au tour qui déclenche le premier résumé, la sortie fait **0 octet**, donc le repli s'appliquait toujours. Remplacé par le vrai comportement (ce tour n'injecte rien) plus une vérification que la mémoire fraîche part **au tour suivant**. Source : `test/memory-hook.test.js:59-64`.

**Retenu, point 2 — un refus permanent était possible.** `bienForme` n'acceptait que `MEMOIRE` sans accent, alors que rien n'empêche le modèle d'écrire `MÉMOIRE`. Comme le marqueur n'est consommé que sur succès, un refus systématique aurait relancé un résumé à chaque message, échouant toujours, sans laisser de trace. Le titre accentué est désormais accepté. Source : `src/memory-hook.js:115`.

**Point 3 — vérifié, pas corrigé.** La revue signalait que la survie de l'enfant au parent n'était pas démontrée sur Windows (risque de `Job Object` avec `kill-on-close`). Mesuré en conditions réelles sur l'installation active : parent sorti en **175 ms**, fichier mémoire écrit **2,8 s après sa mort**. La prémisse du correctif tient.

**Point 4 — écarté.** La lecture de `state.json` est recopiée entre le pré-contrôle du parent et le calcul de l'enfant. Un helper commun serait plus propre, mais extraire une fonction pour deux appels dans le même fichier n'améliore rien de mesurable.

**Contre-épreuves** : chacune des cinq corrections échoue quand on la neutralise, y compris celle de la latence, qui affiche « *mesure 4249 ms pour un appel de 4000 ms* ».

---

## DR-006 — Le dossier d'installation prend le nom officiel du projet

**Type** : exploitation · **État** : appliqué le 2026-09-06

**Constat.** Trois dossiers coexistaient et se ressemblaient : le dépôt (`~/claude-quota-relay`), l'installation réellement vivante sous l'ancien nom (`~/.claude/auth-proxy`, proxy actif sur le port 8787, cinq comptes, six chemins dans `settings.json`), et un doublon mort au nom officiel (`~/.claude/claude-quota-relay`, deux comptes périmés, référencé nulle part). Le code des trois était **identique** — seule la configuration divergeait. Origine du doublon : `install.js:84` vise `<config>/claude-quota-relay`, alors que l'installation historique n'a jamais été renommée.

**Question posée** : « L'installation vit sous l'ancien nom `auth-proxy`, mais le code veut désormais `claude-quota-relay`. On aligne, ou on garde l'ancien nom ? »

**Réponse citée** : « *Aligner sur claude-quota-relay* ».

**Fait.** Doublon archivé puis supprimé, `~/.claude/auth-proxy` renommé en `~/.claude/claude-quota-relay`, et les neuf fichiers qui portaient l'ancien chemin réécrits : `settings.json`, `.local/bin/claude-auth` et son `.cmd`, `hooks/quota-compact-nudge.js`, les cinq `commands/auth*.md`. Archive : `~/.claude/.archive-migration-cqr-20260906-202227/`.

**Preuve** : port 8787 en écoute après redémarrage, `cqr status` affiche cinq comptes, et `grep auth-proxy` ne rend plus aucune référence hors archives. La prochaine mise à jour du dépôt ne peut plus fabriquer de second dossier.

**Contrainte d'exécution** : `ANTHROPIC_BASE_URL` pointe vers ce proxy, donc l'agent qui migre passe par lui. La bascule a été faite par un script unique doté d'un filet `trap EXIT` qui relance le proxy quel que soit le point d'échec — jamais par une suite de commandes séparées.

---

## DR-007 — `cqr` cesse d'être une commande npm

**Type** : exploitation · **État** : appliqué le 2026-09-06

**Constat.** Un `npm link` posé le jour même faisait résoudre `cqr` vers `~/claude-quota-relay/src/cli.js`. Or `cli.js:26` définit son dossier de travail par `__dirname` : la commande cherchait donc sa configuration dans le dépôt, qui n'en contient pas. `cqr status` répondait « *Aucun tokens.json dans …\src — lancez d'abord l'installeur* », et seul `claude-auth` fonctionnait.

**Question posée** : « Que faire du lien npm qui casse la commande `cqr` ? »

**Réponse citée** : « *Retirer le lien, cqr → installation* ».

**Fait.** `npm rm -g claude-quota-relay`, puis `~/.local/bin/cqr` et `cqr.cmd` créés sur le modèle de `claude-auth` — un lanceur d'une ligne vers `~/.claude/claude-quota-relay/cli.js`.

**Preuve** : `which -a cqr` ne rend plus que `/c/Users/damie/.local/bin/cqr`, et `cqr status` affiche les cinq comptes.

**À retenir** : `__dirname` fait du dossier d'exécution la source de vérité. Lier le dépôt au PATH crée donc une seconde installation sans configuration — un `npm link` sur ce projet est à éviter.

---

## DR-008 — La statusline passe à plusieurs lignes, une par compte

**Type** : affichage · **État** : appliqué le 2026-09-07

**Constat.** Depuis `2fe6134`, chaque compte a son bloc `5h / 7j`, mais tous les blocs tiennent sur une seule ligne séparés par `│`. À cinq comptes la ligne dépasse la largeur du terminal et se replie n'importe où : les blocs se coupent en deux, et l'œil ne retrouve plus quel pourcentage appartient à quel compte.

**Question posée** : « Où placer la pastille crédits (● / ◐ / ○) dans la version multi-lignes ? »

**Réponse citée** : « *Fin de la ligne 1* ».

**Question posée** : « Ta statusline d'origine (`~/.claude/statusline.js`) sort le modèle, xhigh et ctx. Aujourd'hui le code ne garde que sa PREMIÈRE ligne et jette le reste. On change ? »

**Réponse citée** : « *Garder la 1re ligne seulement* ».

**Question posée** : « Les barres verticales de bordure dans ta maquette (`│` au début et à la fin de chaque ligne de compte) : décoratives ou réelles ? »

**Réponse citée** : « *│ des deux côtés* ».

**Fait.** `cqr-statusline.js` rend désormais une ligne d'en-tête (préfixe + prochain reset + pastille crédits) suivie d'une ligne par compte, chacune bordée de `│` à gauche et à droite. Les deux pourcentages sont cadrés à droite sur quatre caractères (`  0%`, ` 36%`, `100%`) — sans ce cadrage, la bordure de droite se décalerait d'un compte à l'autre et l'alignement, seule raison d'être du passage multi-lignes, serait perdu.

**Question posée**, en cours de route : « Les barres font 5 caractères chacune. »

**Réponse citée** : « *Je pense que pour les quotas des comptes, on peut augmenter leurs tailles pour avoir la même longueur que le ctx* » — chaque barre passe donc de 5 à 10 caractères, la largeur de la jauge `ctx` de Claude Code sur la ligne d'en-tête.

**Corrigé après revue.** Le cadrage des pourcentages ne suffisait pas : au-delà du neuvième compte, `tag()` n'a plus de chiffre entouré et rend `(10)` — quatre caractères là où les autres en rendent un. Cette ligne-là, et elle seule, perdait sa bordure de droite. Le numéro est désormais calé sur la largeur du plus long tag affiché.

**Preuve** : `node test/statusline.test.js` vérifie que la sortie compte `1 + nombre de comptes` lignes, que chaque ligne de compte commence et finit par `│`, et que toutes ont la même longueur une fois les couleurs retirées — sur deux comptes, sur le couple `0%` / `100%`, et sur dix comptes. Contre-épreuve faite : en retirant le calage du numéro, l'assertion « *le 10e compte garde la largeur des neuf autres* » tombe.

---

## DR-009 — Le lanceur Windows du proxy pointait vers un dossier supprimé

**Type** : exploitation · **État** : appliqué le 2026-09-07

**Constat.** `Démarrage/ClaudeAuthProxy.vbs` lançait `C:\Users\damie\.claude\auth-proxy\proxy.js`. Ce dossier a été renommé en `claude-quota-relay` par DR-006, mais le VBS n'a pas été réécrit : il n'est produit par aucun script du dépôt, donc aucun `grep` d'installation ne l'atteignait. Le proxy ne démarrait donc plus avec Windows — panne invisible, parce que le hook `SessionStart` `ensure-proxy.js` le relance à la première session Claude Code.

**Fait.** Chemin corrigé dans le VBS du dossier Démarrage.

**À retenir** : DR-006 a réécrit les neuf fichiers qui portaient l'ancien chemin *sous `~/.claude` et `~/.local`*. Le dossier Démarrage de Windows était hors de ce périmètre. Un renommage d'installation doit balayer aussi les points de lancement du système.

---

## DR-010 — Un refus administratif d'Anthropic ne doit plus passer inaperçu

**Type** : produit · **État** : appliqué le 2026-09-12

**Constat.** `API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.` Ce 400 ne tombait dans aucune branche de `src/proxy.js:672-678` (429 `rejected`, 401/403 `authFail`, 529 `overloaded`, 5xx `serverError`) : il était relayé tel quel au client et le compte restait marqué sain. Donc aucune bascule, aucune quarantaine, aucune trace — chaque requête repartait sur le compte bloqué et échouait. Coût réel signalé par l'utilisateur : « *cette erreur qui m'as couté cher en perte de suivi sur des projets et affaires* ».

**Question posée** : « Quand un compte rend ce 400 "accepte les CGU", que doit faire le relais ? »
**Réponse citée** : « **Quarantaine longue + bascule** » — le compte est mis de côté 6 h et la requête part immédiatement sur un autre compte. Motif : seule une action humaine sur claude.ai répare ce blocage, donc ni la sonde ni un cooldown court n'ont de sens ; et le tour en cours ne doit pas être perdu.

**Question posée** : « Sous quelle forme veux-tu être averti ? »
**Réponse citée** : « **Pop-up + statusline** » — fenêtre Windows bloquante (MessageBox WPF via PowerShell détaché, zéro dépendance) nommant le compte, **plus** un marqueur dans la statusline tant que ce n'est pas réglé, « *au cas où tu rates le pop-up ou qu'il arrive machine verrouillée* ». Demande initiale de l'utilisateur : « *Un pop-up windows serais cool, mais si tu as une solution plus simple et qui fonctionne je suis preneur* ».

**Question posée** : « Quelle portée pour cette détection ? »
**Réponse citée** : « **Ce blocage CGU seul** » — le motif `consumer terms | privacy polic | accept them in claude.ai | terms of service` dans le corps d'un 400. Pas de généralisation à tout 400, pas de traitement du 401 persistant.

**Réserve assumée.** Le blocage n'est pas reproductible à la demande : rien ne prouve que le texte vienne du corps de l'API plutôt que d'une reformulation par Claude Code. Parade : **tout** 400 est désormais journalisé avec les 400 premiers caractères de son corps (`log("BAD REQUEST http400", …)`). Si le motif ne reconnaît pas une future variante, c'est cette ligne du journal qui le dira, au lieu d'un silence.

**Corrigé après revue** (`thermo-review`, trois points). Le principal : le marqueur était levé dès que le compte servait de nouveau, mais **pas la quarantaine de 6 h qu'il avait posée**. Chemin réel — `enterWait` force la requête sur le compte visé quand `maxWaitMs` expire (`proxy.js:530`) : si les conditions ont été acceptées entre-temps, la réponse passe, l'alerte disparaît de la barre d'état, et le routage continue pourtant d'écarter ce compte jusqu'à l'échéance, sans rien dire. Les deux tombent désormais ensemble, et seulement si l'échéance est bien celle posée par ce refus — un 429 survenu depuis garde la sienne. Les deux autres points : un commentaire disant pourquoi l'état est relu après la bufferisation du corps, et un fichier d'alerte nommé par compte (deux comptes bloqués dans le même instant écrasaient un nom fixe, et une alerte se perdait).

**Preuve** : `node test/terms-block.test.js` (motif reconnu sur le texte exact d'Anthropic, corps gzippé décodé, 400 banal non reconnu) et `node test/proxy-e2e.test.js` (upstream factice rendant ce 400 sur le compte 1 : le client reçoit un 200 servi par le compte 2, `state.blocked.account1` est écrit, `state.exhausted.account1` porte une échéance à plus de 5 h). Contre-épreuve faite deux fois : en retirant la branche 400 de `proxy.js`, le client reçoit le 400 et l'assertion tombe ; en retirant la levée de quarantaine, le compte reste écarté et l'assertion du cas « refus levé pendant une attente » tombe.

---

## DR-011 — Une requête retenue doit survivre à la veille et au changement de réseau

**Type** : produit · **État** : correctif écrit et testé (v0.19.0 non commitée) ; essais réels « après » partiels ; non déployé

**Constat.** Message rapporté par l'utilisateur : « *Agent "E2 correctif cache gen_py privé" failed: Agent terminated early due to an API error: Request timed out (error type server_error)* ». Contexte cité : « *le sous-agent atteint le quota quand je regarde mon PC le matin […] Je met le PC en veille pour partir et je le ré-ouvre sur un autre réseau et c'est là qu'est mon problème* », et « *Ca arrive également quand le wifi ce coute temporairement* ». Demande : « *que cela continue a conserver la/les requette(s) le temps que le PC sorte de veille et que je retrouve une connexion internet* ».

**Analyse (2026-09-28).** Claude Code 2.1.283 détecte la veille et coupe volontairement sa requête pour la refaire (`StreamSuspendedError` : « *aborting to retry on a fresh connection* ») ; il exige un premier octet du relais sous ~2 min (fenêtre dérivée de `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=120000`), sinon « *Request timed out* ». Trois trous côté relais (`src/proxy.js`) : (1) aucun signal au client pendant l'attente des en-têtes d'Anthropic (`attempt()` coupe le keepalive avant `forward()`) ; (2) aucune détection d'une connexion amont muette (pas de délai sur `preq`) ; (3) seules les erreurs de `NETWORK_ERROR_CODES` sont retentées — une interception TLS ou un portail rendent l'erreur tout de suite. Trace de l'incident absente de ce PC : `proxy.log` ne remonte qu'au 2026-09-24.

**Question posée** : « Sur quel PC l'échec du sous-agent arrive-t-il ? »
**Réponse citée** : « **Sur un autre PC (portable)** »

**Question posée** : « Dans l'autre bâtiment, comment se connecte le PC à internet ? »
**Réponse citée** : « **RJ45 ou Wifi sur VPN habituelle Zscaler** »

**Question posée** : « Quelle solution veux-tu ? » (relais seul / relais + plus de tentatives / réglages seulement)
**Réponse citée** : « **Fait des tests toi même sur ce poste. en mettant en oeuvre tout ce qui pourrais casser, je veux des essais réels.** »

**Question posée** : « Si une erreur ne se règle jamais d'elle-même (par exemple un réseau d'entreprise qui bloque Anthropic en permanence), que doit faire le relais ? »
**Réponse citée** : « **Retenir 60 min puis rendre l'erreur** »

**Round 2 (2026-09-28).**

**Question posée** : « Les essais réels demandent de couper le Wi-Fi de ce PC plusieurs fois (2 à 5 min chaque fois) et de le mettre vraiment en veille. […] D'accord ? »
**Réponse citée** : « **Wi-Fi + veille, réveil auto seul** » — si le réveil automatique échoue, l'essai attend le retour de l'utilisateur.

**Question posée** : « Pour reproduire un vrai changement de réseau, je peux faire passer ce PC […] au partage de connexion de ton iPhone […]. Tu peux l'activer pendant les essais ? »
**Réponse citée** : « **Non, pas d'autre réseau** » — le changement de réseau se teste par coupure et reconnexion au même Wi-Fi.

**Question posée** : « Ta règle "retenir 60 min puis rendre l'erreur" : à quoi l'appliquer ? »
**Réponse citée** : « **À toute coupure (Recommandé)** » — une seule règle : 60 min à partir de la première erreur, quel que soit le type d'erreur réseau.

**Question posée** : « Je reproduis d'abord la panne avec le relais actuel […], puis je rejoue les mêmes essais avec le correctif. […] On fait comme ça ? »
**Réponse citée** : « **Oui, avant puis après (Recommandé)** »

**Round 3 (2026-09-28).** Le réveil automatique a échoué au premier essai en veille (PC resté endormi ~2 h 45) : `RTCWAKE` sur secteur = 2 (« minuteurs importants seulement »).
**Question posée** : « […] puis-je activer ce réglage le temps des essais, puis le remettre exactement comme avant ? »
**Réponse citée** : « **Oui, activer puis remettre (Recommandé)** »

**État au 2026-09-29.** Correctif dans `src/proxy.js` : toute erreur sans réponse d'Anthropic est retentée 60 min depuis la première (`networkErrorMaxMs`), une connexion muette est refaite après 90 s (`upstreamIdleMs`, désactivable à 0), le signal SSE ne s'interrompt plus pendant l'attente d'Anthropic. Preuves : `test/network-hold.test.js` (échoue sur le `proxy.js` de HEAD ; quatre contre-épreuves par mutation) et `npm test` à 31 contrôles verts ; essais réels AVANT — certificat intercepté (sous-agent mort, 11/11 tentatives en 3 min), connexion muette (`Request timed out.` à 307 s), veille + certificat au réveil (sous-agent mort, `durationMs=400808`) ; essais réels APRÈS — certificat (réussi, aucune tentative client consommée), Wi-Fi coupé 3 min (réussi, mais l'ancien relais tenait déjà : pas de gain à en tirer). **Non prouvé** : les deux essais avec vraie veille du PC après correctif, et la reprise à 90 s (un essai a donné 180 s, corrigé depuis, essai de confirmation tué par manque de mémoire de la machine). Le message exact « Request timed out (server_error) » n'a pas été reproduit tel quel ; la trace de l'incident est sur le portable.


---

## DR-012 — Le relais lui-même meurt sans laisser de trace

**Type** : exploitation · **État** : appliqué le 2026-10-02 en 0.20.0 sur ce PC (essai réel réussi) ; installé sur le PC d'entreprise le 2026-10-02 ; cause de l'incident non tranchée (message d'enquête pas encore rapporté)

**Constat.** Rapporté par l'utilisateur, PC d'entreprise, deux sessions Claude Code, huit sous-agents tués d'un coup : « *Agent "X21 — revue du lot BG" failed: Agent terminated early due to an API error: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED) (error type server_error)* ». `ECONNREFUSED` = plus rien n'écoute sur le port du relais : le processus était mort, ce n'est pas une erreur relayée.

Enquête de l'agent du PC d'entreprise, citée : « *le relais s'est arrêté vers 6 h 18 (heure de Paris), sans message d'erreur ni trace de plantage* » ; « *il est reparti tout seul à 7 h 00. Le script de démarrage ne le relance qu'à l'ouverture d'une session Claude, d'où 42 minutes de coupure* » ; écartés : « *la compaction de la conversation, les scripts automatiques de Claude Code, les quotas épuisés […] et une mise en veille ou un redémarrage de Windows* » ; « *Piste probable, non prouvée : quelque chose d'extérieur l'a arrêté* ».

Hypothèse de l'utilisateur, citée : « *je pense que cela viens du faite que j'avais trop de sous-agents ouverts en même temps et que le relais a voulu switcher de compte de quota* ».

Demande : « *Trouve une solution, ultrathink pourquoi ca a pu bugger. brainstorm une solution pour catcher ce genre d'erreur.* »

**Analyse (2026-10-01, trois enquêtes en sous-agents, aucun fichier du dépôt touché).**

Établi :
- L'hypothèse « trop de sous-agents + bascule de compte » n'est **pas reproduite** : relais v0.19.0 isolé, 3 boucles de 6 vagues de 20 à 40 requêtes simultanées, ~1 300 requêtes amont dont ~670 en 429, coupures en plein flux, 5xx, 400 « conditions », abandons clients → processus vivant, stderr vide, mémoire 42-91 Mo sans croissance (`%TEMP%\cqr-stress\harness.js`). Réserve : version du relais du PC d'entreprise inconnue.
- Un journal muet ne prouve pas un arrêt extérieur : `proxy.js` n'a ni `uncaughtException` ni `unhandledRejection`, la pile d'un plantage part dans `proxy.out.log` seulement (`ensure-proxy.js:26`, `cli.js:69`), jamais dans `proxy.log` ; lancé par le VBS de Démarrage (`Run …, 0, False`), elle est perdue. `SIGINT`/`SIGTERM` → `exit(0)` muet (`proxy.js:853-854`). Un arrêt brutal (TerminateProcess) ne laisse rien et laisse `proxy.pid` périmé — preuve écrasée par la relance de 07:00.
- Deux plantages réels reproduits : `notifyWindows` lance `wscript.exe` sans écouteur `'error'` (`lib.js:317-318`, appelé `proxy.js:723`) → si wscript ne peut pas se lancer au moment d'un 400 « conditions », le relais meurt (`spawn wscript.exe ENOENT`, code 1) ; jeton à caractère invalide → `ERR_INVALID_CHAR` depuis un minuteur (`proxy.js:253`, `:650`).
- 42 min parce que rien ne relance un relais mort en cours de session : seul le hook SessionStart `startup|resume|clear` le fait (`install.js:166`).
- Ce PC : relais vivant depuis le 13/09 (17,5 j), aucune mort, mais le journal ne garde ni démarrage (coupé à 500 Ko, `proxy.js:83`) ni arrêt.
- Défauts annexes (pas des causes de mort) : `probeToken` appelle `done()` deux fois (`proxy.js:288`, `:291`) → seconde requête amont facturée pour le même client ; abandon client → requête amont jamais annulée (`proxy.js:444`, `:646`) ; `ping()` 800 ms d'`ensure-proxy.js:16` → 2e relais qui efface `proxy.pid` du premier.

Ouvert : la cause réelle sur le PC d'entreprise (fin de `proxy.out.log`, lignes de `proxy.log` avant 06:18, journal Windows, version, mode de lancement) ; la stratégie de relance ; la forme de l'alerte ; les défauts annexes à inclure.

**Mesure D (2026-10-01, Claude Code 2.1.286, port fermé, faux serveur).** Plus rien n'écoute → 11 tentatives (0,5 s doublé, plafond 32 s, gigue 0-25 %), abandon à **~180 s** (181,9 s mesurées) avec exactement le message de l'incident. Serveur rouvert à 30/60/120/160 s → la requête aboutit (code 0) ; à 200 s → échec. Même chose pour un sous-agent : rouvert à 30 s il termine (`exitPath=completed`), jamais rouvert il meurt à 178,9 s avec « *Agent terminated early due to an API error: API Error: Connection refused…* ». `CLAUDE_CODE_MAX_RETRIES` existe : 15 → 16 tentatives, 363 s ; au-delà, ramené à 15 (`clamped to 15`) sauf `CLAUDE_CODE_RETRY_WATCHDOG=1` (plafond 300, ~2 h 40 — lu dans le binaire, non testé en entier). Sorties : `%TEMP%\cqr-retry\`. Incident de mesure : le premier essai a atteint le vrai relais, car le bloc `env` de `~/.claude/settings.json` écrase l'environnement du processus — une vraie requête, ~0,01 $ ; essais suivants isolés par `CLAUDE_CONFIG_DIR` vide.
**Conséquence** : un relais relancé en moins de ~3 min sauve les sous-agents en cours ; en 42 min, aucun.

**Round 1 (2026-10-01).**

**Question posée** : « La vraie cause est sur le PC d'entreprise : il faut lire la fin de proxy.out.log, le journal du relais juste avant 6 h 18, le journal Windows, et la version installée. Comment récupère-t-on ces traces ? » (proposé : via /relais, recommandé)
**Réponse citée** : « **Message à coller** »

**Question posée** : « Quand le relais est mort puis relancé, comment veux-tu être prévenu ? » (proposé : statusline + journal, recommandé)
**Réponse citée** : « **Journal seulement** »

**Question posée** : « Les enquêtes ont trouvé des défauts qui ne tuent pas le relais. Lesquels corriger dans la foulée ? »
**Réponse citée** : « **Double requête de sonde, Requête non annulée, proxy.pid effacé, Journal sans démarrages** » — les quatre.

**Round 2 (2026-10-01).**

**Question posée** : « Mesuré : Claude Code réessaie ~3 min quand le relais ne répond plus ; relancé avant, les sous-agents en cours survivent. Quel gardien pour relancer le relais ? » (proposé : tâche Windows chaque minute, recommandé ; gardien résident ; les deux)
**Réponse citée** (Autre) : « **Je ne sais pas quoi faire, car sur PC d'entreprise soummis a des restrictions A.V, je ne sais pas ce qui est le mieux. Je ne dit pas que ca va bloquer, mais que cela peut.** » → question rouverte au round 3, avec une option qui n'ajoute aucun mécanisme Windows (ni tâche planifiée, ni wscript).

**Question posée** : « Faut-il aussi allonger la patience de Claude Code de ~3 min à ~6 min (CLAUDE_CODE_MAX_RETRIES=15 dans ~/.claude/settings.json, sur chaque PC) ? »
**Réponse citée** : « **Oui, 15 (Recommandé)** »

**Question posée** : « Quand le relais rencontre une erreur imprévue (le genre qui le tue aujourd'hui), que doit-il faire ? » (proposé : noter + redémarrer, recommandé ; noter + continuer)
**Réponse citée** (Autre) : « **Je ne veux pas que les requettes soit coupés, sinon ca veux dire que claude code bouffe des tokens a tout refaire, l'idée étais de conserver la requette quand même.** » → le relais note l'erreur et continue ; chaque cause connue est ramenée dans le chemin normal de la requête (retentée/basculée), pas abandonnée.

**Question posée** : « Une fois tout prouvé par les tests, jusqu'où je vais ? » (proposé : commit + déploiement ici, recommandé)
**Réponse citée** : « **Tout + push** » — commit, installation sur ce PC, push, message à coller pour le PC d'entreprise.

**Correction de ma part** : le point 8 du message à coller créait une tâche planifiée d'essai ; sur un PC d'entreprise sous EDR, c'est un geste de persistance classique qui peut lever une alerte. Remplacé par des lectures seules.

**Mesure E (2026-10-01, Claude Code 2.1.286, sessions interactives isolées, port fermé).** Le binaire porte `statusLine.refreshInterval` (« *Re-run the status line command every N seconds in addition to event-driven updates* », secondes, minimum 1). Pendant les 11 tentatives `ECONNREFUSED` (~3 min) : sans ce réglage, la statusline tourne **2 fois** (démarrage, fin du tour en erreur) ; avec `refreshInterval: 5`, **39 fois**, toutes les 5,0 s, sans interruption. Aucun hook ne part pendant les tentatives (`StopFailure` vient après leur épuisement). `cqr-statusline.js` ne fait aucun appel HTTP (lit `stdin` et trois fichiers, `:57-61`) ; un contrôle `process.kill(pid,0)` est gratuit, un refus TCP coûte ~4 ms. Traces : `%TEMP%\cqr-statusline-essai\`.
**Conséquence** : un gardien logé dans la statusline relance le relais en quelques secondes, sans tâche planifiée ni wscript, tant qu'une session Claude est ouverte.

**Round 3 (2026-10-01).**

**Question posée** : « Mesuré : la statusline de Claude Code peut tourner toutes les N secondes, même pendant que Claude Code réessaie de joindre un relais mort. Quel gardien ? » (proposé : statusline 10 s, recommandé ; statusline + tâche Windows ; statusline 5 s)
**Réponse citée** : « **Statusline, 10 s (Recommandé)** »

**Frontière vide.** Périmètre retenu : tracer toute mort (démarrage, arrêt, signal, erreur imprévue, arrêt brutal détecté au redémarrage) dans `proxy.log` seulement ; ne plus mourir d'une erreur imprévue et ramener chaque cause connue dans le chemin normal de la requête ; gardien dans la statusline toutes les 10 s ; `CLAUDE_CODE_MAX_RETRIES=15` ; les quatre défauts annexes ; commit, installation ici, push, message pour le PC d'entreprise.

**Question posée** (2026-10-01) : « Étape 5 : après installation sur CE PC, je veux tuer brutalement le vrai relais pour prouver que le gardien le relance seul (~10 s). […] D'accord ? »
**Réponse citée** : « **Oui, essai réel (Recommandé)** »

**Fait (0.20.0).** Le relais ne s'arrête plus sur une erreur : gardes `uncaughtException`/`unhandledRejection` (noter + continuer), et garde par requête — une exception en pleine requête rejoue la requête une fois si rien n'est encore parti vers le client, sinon termine la réponse pour que Claude Code retente aussitôt. Causes connues ramenées dans la requête (`wscript` introuvable, `http.request` qui lève → compte écarté et bascule, `'error'` sur la réponse client). Journal de vie `VIE` dans `proxy.log` (démarrage avec PID, version, Node, `lance_par` ; sortie ; signal ; erreur imprévue ; « arret brutal precedent detecte » au redémarrage), qui survit à la rotation. Gardien dans la statusline (`refreshInterval: 10`) : port qui ne répond pas, pas de `proxy.stopped`, pas de relance depuis moins de 60 s (`proxy.guard`) → `ensure-proxy.js` détaché. `CLAUDE_CODE_MAX_RETRIES=15`. Annexes : sonde à un seul `done()`, amont détruit quand le client part, `proxy.pid` écrit après `listen`.

**Corrigé après revue** (`thermo-review`, verdict À CORRIGER). (1) Rester vivant laissait une requête orpheline, pendue des jours (`API_TIMEOUT_MS` 7 j, battements SSE sans fin) — c'est l'inverse de « conserver la requête » → garde par requête. (2) Gardien fondé sur `process.kill(pid,0)` : aveugle si Windows réattribue le PID d'un relais tué — mesuré, 1 essai sur 2 après 25 lancements → test du port seul. (3) Relances sans limite si le relais ne peut pas démarrer (motif d'alerte EDR) → une par minute. (4) `cli.js` effaçait `proxy.stopped` avant le démarrage (fenêtre pendant `cqr restart`) → retiré. (5) Une tempête d'erreurs évinçait les lignes de démarrage → piles tronquées à 1 500 caractères, 300 lignes `VIE`, les vieilles erreurs partent en premier. **Refusé** : (6) déplacer des fonctions de `proxy.js` vers `lib.js` — refonte hors demande. Contre-revue de la garde par requête : 0 défaut à corriger, 4 mineurs acceptés.

**Boucle 1 (ratée, de ma part).** J'ai cru qu'un `cqr stop` sous Windows laisserait une fausse alerte « arret brutal » (TerminateProcess, aucun gestionnaire) et fait ajouter une ligne « arret voulu ». Mesuré à l'installation : `stopProxy` (`cli.js:132-148`) efface déjà `proxy.pid` après l'arrêt, le cas ne se produit pas → code retiré. Leçon : vérifier le chemin réel avant de corriger une alerte supposée.

**Écarté avec raison.** Deux gardiens qui tirent dans la même milliseconde lancent deux relais : mesuré à l'essai réel, le perdant sort sur `EADDRINUSE` et `proxy.pid` reste juste. Pas de dégât, un verrou atomique coûterait plus que le processus de trop.

**Preuve.** `npm test` vert (49 contrôles avant le retrait de la boucle 1) ; `test/relais-vie.test.js` échoue 9/9 sur HEAD, chaque correctif a sa mutation qui fait tomber son seul scénario. **Essai réel sur ce PC (2026-10-02 01:45, heure de Paris)** : installation → `VIE demarrage pid=30540 version=0.20.0 node=v22.22.0 lance_par=cli`, `refreshInterval` = 10 et `CLAUDE_CODE_MAX_RETRIES` = "15" dans `settings.json` ; relais tué par `taskkill /F` à 23:45:57,5 UTC → `VIE demarrage pid=37068 version=0.20.0 … lance_par=statusline` à 23:46:06,531, puis `VIE arret brutal precedent detecte pid=30540 derniere_ligne_du_journal=2026-10-01T23:45:51.749Z` — **~9 s de coupure au lieu de 42 min**, sans le filet de l'essai (`%TEMP%\cqr-essai-reel\essai.log`). La statusline a pris `refreshInterval` à chaud.

**Non prouvé.** La cause de l'incident du PC d'entreprise ; le comportement du gardien sous l'antivirus de ce PC-là ; la levée d'une exception dans les rouages internes de `pipe` (hors garde par requête).

**PC d'entreprise (2026-10-02).** Rapport de l'agent de là-bas, cité : « *Dernière ligne du journal : [2026-10-02T03:52:02.620Z] VIE demarrage pid=29200 version=0.20.0 node=v22.22.2 lance_par=cli* » ; `statusLine.refreshInterval` « *10, comme attendu* » ; `env.CLAUDE_CODE_MAX_RETRIES` « *"15", comme attendu* » ; « *Aucune alerte antivirus, aucun blocage* » ; « *les 6 comptes sont conservés* ». L'installeur y a aussi laissé une sauvegarde `settings.json.bak-*` qui contient des jetons (comportement antérieur de l'installeur, une sauvegarde par installation).

## DR-013 — La statusline affichait un reset de quota déjà passé

**Type** : correctif · **État** : corrigé en 0.20.1 et copié (`lib.js` + `package.json`, sans redémarrer le relais) sur ce PC le 2026-10-02 ; PC d'entreprise : corrigé et vérifié le 2026-10-02 (rapport cité plus bas)

**Constat (enquête, 3 sous-agents `ouvrier`, lecture seule).** Le relais garde l'ancien instant de reset d'un compte tant que celui-ci n'envoie pas de nouvel en-tête (`src/proxy.js:406-407`) ; la statusline prend le plus petit reset parmi les comptes qui ont encore du quota hebdomadaire sans le comparer à maintenant (`src/cqr-statusline.js:91-95`). Sur ce PC, le compte ③ répond en 403 sans en-têtes depuis le 2026-10-01 08:40 UTC : son `reset5h` périmé (−20 h) gagne, la statusline affiche `↻ 10h40 ③` au lieu de `↻ 11h40 ② ⑤`, et ③ reste figé à 5h 100 %. Le routeur, lui, a déjà la garde (`src/proxy.js:182-183`, fenêtre échue → utilisation 0) ; Claude Code aussi (`R4e`, binaire 2.1.287 : reset passé ignoré).

**Non prouvé.** Le lien avec le reset de limite offert par Anthropic : aucun en-tête de reset offert n'a été capturé (1 681 réponses lues, `5h-reset`/`7d-reset` toujours présents et futurs, même à 0 %). Cause du 403 du compte ③ : inconnue (corps de réponse non journalisé).

**Demande de l'utilisateur, citée (2026-10-02).** « *Corrige-le : ignore les resets passés dans la statusline et fait en sorte que le soucis ne revienne pas. C'est pareil sur mon PC d'entreprise* »

**Décision (reprise de la garde déjà posée dans le routeur, pas de nouvelle règle).** Un reset passé = fenêtre écoulée : l'utilisation de cette fenêtre vaut 0 et le reset est ignoré. Posé dans `lib.accounts()` (source unique de la statusline, du garde de workflow et de `cqr preflight`), pas dans la statusline seule, pour que le défaut ne revienne par aucune autre porte. Hors périmètre, signalé : comptes déjà à 0 % comptés dans « prochain reset » ; cause du 403 de ③.

**Corrigé après revue** (`thermo-review`, verdict À CORRIGER, 1 constat réel). Un compte muet avec reset périmé ET cooldown en cours (`state.exhausted`, posé par un 403) devenait « libre à 0 % » pour `bestHeadroom` → le garde de workflow se taisait alors que le routeur écarte ce compte (`proxy.js:184`). Corrigé : `bestHeadroom` compte pour 100 un compte en cooldown (100 et non `null` : `cqr-workflow-guard.js:36` laisse passer en silence sur `null`). Écarté avec raison : paramètre `now` par défaut, commentaire croisé dans `proxy.js`, cas de test redondants — mineurs, hors demande.

**Preuve.** `npm test` exit 0, 48 PASS, 0 FAIL (relancé par l'agent principal, `%TEMP%\cqr-npmtest-final-dr013.log`) ; `test/lib.test.js` et `test/statusline.test.js` échouent sur le `lib.js` de HEAD (`↻ 11h54 ③`, `5h/100%`), 5 mutations font chacune tomber leur test, le cas `bestHeadroom` + cooldown échoue sans son correctif (`0 !== 70`). **Sur ce PC, état réel** : avant, `↻ 10h40 ③` ; après, `↻ 16h40 ②` (14:40 UTC = prochain reset réel), ③ affiché à `5h/  0%` (fenêtre échue) au lieu de 100 %.

**Choix d'installation.** Seul `src/lib.js` a changé : la statusline, le garde et `preflight` le rechargent à chaque lancement, le relais en cours ne s'en sert pas. Copie directe de `lib.js` + `package.json` plutôt que `cqr update`, qui redémarre le relais et coupe les requêtes en vol des sessions ouvertes ; `cqr update` rattrapera le reste (aucun autre fichier utile n'a changé) au prochain redémarrage voulu. Sauvegardes de l'ancien : `%TEMP%\lib.js.0.20.0.bak`, `%TEMP%\package.json.0.20.0.bak`.

**Non prouvé / hors périmètre.** Cause du 403 du compte ③ (corps non journalisé) ; lien avec le reset offert par Anthropic ; sur ce PC ③ s'affiche désormais à 0 % alors qu'il répond 403 (le cooldown le sépare du routage, la statusline ne le sait pas) ; comptes déjà à 0 % comptés dans « prochain reset ». Le PC d'entreprise n'a pas été examiné : la correction repose sur l'identité du code, pas sur une lecture de son `state.json`.

**Round de clôture (2026-10-02).** Question : commit + push de la 0.20.1 pour le PC d'entreprise ? **Réponse citée** : « **Commit + push + message (Recommandé)** » — commit sur `main`, push, puis message à coller en lecture seule pour le PC d'entreprise.

**PC d'entreprise (2026-10-02).** Rapport de l'agent de là-bas, cité : « *Le dépôt est passé en 0.20.1 (8ea1c5d) et lib.js est copié (cmp identique). Je n'ai lancé ni install.js, ni cqr restart, ni cqr update, et je n'ai pas touché à settings.json. Le relais n'a pas redémarré.* » ; « *③ : 5h 100 %, barre pleine → 5h 0 %* » ; « *En-tête : ↻ 10h40 ③ → ↻ 16h40 ②* » ; « *state.json gardait pour ③ h5=100 avec un reset5h du 2026-10-01 08:40 UTC, passé depuis plus d'un jour (relevé à 10:47 UTC)* » ; « *package.json n'avait pas à être copié : le dépôt est lui-même le dossier d'installation* ». Les valeurs 7J sont inchangées.

**Ce que ce rapport établit.** Le même défaut, au même instant exact (`reset5h` de ③ = 2026-10-01 08:40 UTC), sur les deux PC, et le même correctif le résout. **Inférence, non prouvée** : ③ est le même compte sur les deux PC et il est devenu muet pour tous au même moment (403 à 08:40:02 UTC) — le défaut vient donc du compte, pas d'un PC, ce qui rend plausible un lien avec le reset de limite offert par Anthropic (hypothèse de l'utilisateur) ; le corps du 403 n'est toujours pas journalisé. **Reste ouvert** : savoir pourquoi ③ renvoie 403 (jeton à renouveler ? compte touché ?). Le relais en marche garde l'ancien `lib.js` en mémoire et `state.json` garde h5=100 pour ③ tant qu'il ne répond pas ; seule la statusline affiche la correction — sans effet sur le routage, qui avait déjà la garde.

## DR-014 — Mémoire factuelle sans modèle et journal des compactages

**Type** : évolution · **État** : appliqué en 0.21.0 (commit, push, installation sur ce PC le 2026-10-05) ; PC d'entreprise : à faire

**Constat (etabli, 2026-10-04).** Le `.cqr-memory.md` résumé par Haiku dérivait : il fusionnait l'ancienne mémoire avec les 14 000 derniers caractères d'un condensé, où les intentions survivent et les résultats sont coupés à 100 caractères. Il était réécrit à chaque bascule de compte (jusqu'à 6 par heure), sur le quota du compte quitté. Au banc de fidélité, ce résumé obtenait 4/20 contre 13/20 pour le résumé natif de Claude Code.

**Décisions de l'utilisateur, citées (registre d'etabli).**
- etabli:DR-050 : « État factuel sans modèle » — « Bâti à chaque compactage et au démarrage à partir des faits : derniers commits, fichiers non commités, section « En cours » de la TODO, dernières décisions du registre. 0 quota, aucune dérive possible. Les notes déjà écrites restent dans une section que rien ne réécrit. »
- etabli:DR-060 : « Faits + notes figées » — « Sections : 5 derniers commits, fichiers non commités, « En cours » de la TODO, 5 dernières décisions du registre ; puis « Notes » (l'ancien contenu, jamais réécrit par le hook, modifiable à la main). […] Exclusion par `.git/info/exclude` au lieu de modifier le `.gitignore` du projet. Dossier sans git ni TODO : notes seules. »
- etabli:DR-048 : « Relais modifié » — « Variable `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` + ≈ 6 lignes dans `proxy.js` + test […]. Ajoute le type de requête (principale, sous-agent, compactage) au journal. »
- etabli:DR-059 : « Ici maintenant + GitHub » — « Codé et testé dans le clone `Outils/claude-quota-relay`, qui reste la source jusqu'à J2. Poussé sur `DamienLTY/claude-quota-relay` (ton autre PC le récupère), puis installé sur ce PC. »
- etabli:DR-066 : « Garder, et l'écrire » — `cqr compact off` coupe aussi la mémoire factuelle.

**Ce qui change.** `src/memory-hook.js` rebâtit la mémoire au `SessionStart` et au `PreCompact`, sans appel de modèle ; `UserPromptSubmit` ne fait qu'injecter (dédoublonné, `SessionStart` compris). Les aides Haiku de `src/lib.js` sont supprimées. Le journal porte `classe=` et `session=` (8 caractères) sur les lignes `RESP`, et une ligne `CLAUDE-COMPACT motif=…` par compactage. L'installeur pose la variable seulement si elle est absente.

**Décidé par l'agent principal, après revue de sécurité.** Les 6 en-têtes d'indice (`x-claude-code-request-class`, `-agent-type`, `-prompt-id`, `-compaction`, `-context-compacted`, `-prev-tool-durations`) sont lus pour le journal puis retirés avant l'envoi à l'amont : l'amont, y compris le Worker du PC d'entreprise, reçoit ce qu'il recevait avant. `x-claude-code-session-id`, `-agent-id` et `-parent-agent-id` partent comme avant, car Claude Code les envoie même sans la variable. Repris du correctif local installé : un `cqr stop` voulu n'est plus pris pour un plantage au démarrage.

**Revues.** Qualité (`thermo-review`) et sécurité (DR-039 d'etabli) : aucun bloquant. Corrigés : en-têtes d'indice, 4 tests de `resolveUpstream` perdus, commentaires périmés, double injection au démarrage, exclusion dans un worktree (`git rev-parse --git-path info/exclude`), `-c core.fsmonitor=false`, variable posée seulement si absente. Non retenus : test du délai git, expurgation des lignes de TODO, ménage des restes à la désinstallation.

**Preuve.** `npm test` exit 0, 50 lignes PASS (relancé par l'agent principal le 2026-10-05). Chaque correction défaite fait échouer son test ; restauration octet à octet. jalon, côté graphe : etabli:DR-067, jalon:DR-113.
