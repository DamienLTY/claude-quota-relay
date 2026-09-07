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
