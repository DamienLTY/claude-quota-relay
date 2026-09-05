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
