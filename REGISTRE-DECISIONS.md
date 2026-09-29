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

