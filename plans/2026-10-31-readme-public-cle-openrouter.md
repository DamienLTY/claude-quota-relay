# Plan — README public + clé OpenRouter enregistrable (DR-022)

Source : `REGISTRE-DECISIONS.md` DR-022 (réponses : commande `cle`, env prioritaire ; README anglais + français ; retirer etabli ; pousser après relecture).
Approche : la clé vit dans `compaction.free.key` du fichier de config (`lib.confPath`, comme les jetons Claude) ; une seule fonction `cleOR(cc)` = env || config, utilisée partout. Alternative écartée : fichier séparé `openrouter.key` (2e fichier secret à protéger, désinstallation à revoir).

## A. Commande `cqr compact gratuit cle` (agent : ouvrier)
1. `src/free-compact.js` : remplacer `hasKey` (l.355) par `cleOR(cc)` → `{ key, source: "env"|"config"|null }` (trim, env d'abord) ; l.384 `if (!cle.key)` ; ajouter `key` au plan `go:true` (l.429, pas au plan `journal` l.386) ; `secrets` (l.396) = `[cle.key, ...jetons]` (couvre aussi la clé de config) ; l.523 `"Bearer " + plan.key`. Exporter `cleOR`.
   Vérif : `grep -n "process.env.OPENROUTER_API_KEY" src/free-compact.js` ne sort que dans `cleOR` ; `node test/free-compact.test.js` code 0.
2. `src/proxy.js:1107` : condition `|| freeModule().cleOR(conf0.compaction).key` à la place de la lecture env (garder le `try`). Vérif : `node test/proxy-e2e.test.js` code 0. Dép. : 1.
3. `src/cli.js` bloc `gratuit` (l.493) : `cle <clé>` → refuse vide, < 8 caractères ou avec espaces (code 1, rien écrit) ; sinon `f.key = clé`, `writeConf`, affiche `mask(clé)` + « effet immédiat » + rappel « l'historique du terminal garde la commande ». `cle off` → `delete f.key`. `status` l.521 : « clé : OPENROUTER_API_KEY (environnement, prioritaire) » / « enregistrée (sk-or-v1-xx...abcd) » / « absente -- cqr compact gratuit cle <clé> », jamais en clair. Message `on` l.501 : « clé : cqr compact gratuit cle <clé> (ou OPENROUTER_API_KEY) » ; si aucune clé, le dire. Usage l.523 et aide l.672 : ajouter `cle <clé>|off`. Dép. : 1.
   Vérif : `grep -n "gratuit cle" src/cli.js` ≥ 3 lignes (on, usage, aide).
4. Test dans `test/free-compact.test.js`, bloc CLI l.1060 (copie jetable `DIR_C`, env SANS `OPENROUTER_API_KEY`) : (a) `cli("compact","gratuit","cle",FAKE_CFG)` code 0, `conf().compaction.free.key === FAKE_CFG`, stdout ne contient pas `FAKE_CFG` ; (b) `status` dit « enregistrée », sans la clé en clair ; (c) `cle ""`/`cle ab` code 1, config inchangée ; (d) `cle off` efface. Côté `decide` (modèle l.637, `fresh()`, env vidé puis restauré) : conf avec `free.key` → `pl.go === true`, `pl.key === FAKE_CFG`, `pl.secrets.includes(FAKE_CFG)` ; env posé + config → `pl.key === FAKE_OR_KEY` (priorité) ; aucune clé → repli `cle-absente`. Clés factices assemblées à l'exécution (convention l.13 de entreprise.test.js).
   Vérif : le test échoue si l'on remet `hasKey()` env seul (essai à faire puis annuler) ; `npm test` code 0. Dép. : 1-3.
5. `CHANGELOG.md` : entrée 0.26.0 (commande `cle`, README refait) ; `package.json` version 0.26.0. Vérif : `grep -c "0.26.0" CHANGELOG.md package.json` ≥ 1 chacun.

## B. README.md (anglais) + README.fr.md (français) (agent : ouvrier, rédaction)
6. Lire l'actuel `README.md` en entier (Read limit=100000) et `cqr help` ; relever les faits (commandes, défauts, timeouts, statusline, crédits, garde-fou, dépannage). Lire `src/install.js` et `src/uninstall.js` pour les étapes exactes ; `lib.configDir()` pour l'emplacement réel de `tokens.json`.
7. Écrire `README.fr.md` (refonte), plan : titre + lien « English » ; quoi/pourquoi ; comment ça marche (schéma texte : Claude Code → 127.0.0.1:8787 cqr → Anthropic, bascule de compte) ; **Sécurité** (2e ou 3e section : clés locales dans `tokens.json`, écoute 127.0.0.1 seulement, ne contacte qu'Anthropic / relais d'entreprise choisi (`ANTHROPIC_TARGET_API_URL`) / openrouter.ai si compactage gratuit activé, aucune télémétrie, code court et lisible : `grep -n "https\?://" src/*.js` pour vérifier) ; installation (prérequis Node + Claude Code, `git clone`, `node src/install.js`, ajout des comptes, `cqr status`) ; au quotidien ; ce qui marche tout seul (condensé) ; compactage gratuit (clé requise, openrouter.ai/keys, `cqr compact gratuit cle <clé>`, priorité de la variable, ce qui part chez un tiers et le masquage) ; dépannage ; mise à jour ; désinstallation ; licence.
8. Écrire `README.md` = traduction anglaise fidèle du 7, lien « Français » en tête. Dép. : 7.
   Vérif 7-8 : `grep -ciE "etabli|DR-[0-9]|x-cqr|openrouter-relay|J[0-9]+-[0-9]|quota --json" README.md README.fr.md` = 0 pour chacun ; `grep -c "gratuit cle\|openrouter.ai/keys\|127.0.0.1\|node src/install.js\|cqr status" README.fr.md` ≥ 5 ; mêmes titres de section en nombre égal (`grep -c "^## " README*.md`) ; liens croisés présents ; chaque commande `cqr …` citée existe dans `cqr help` (relecture).
9. Revue (agent : relecteur) sur A et B ; puis l'agent principal pousse (`pousser-subtree.sh --appliquer`, accord déjà donné DR-022).

## Fichiers critiques
`src/free-compact.js`, `src/cli.js`, `src/proxy.js`, `test/free-compact.test.js`, `README.md` / `README.fr.md`.

## Lignes TODO
- [ ] DR-022 A1 cleOR (env || compaction.free.key) dans free-compact.js, plan.key, secrets
- [ ] DR-022 A2 proxy.js:1107 préchauffe si clé de config
- [ ] DR-022 A3 cqr compact gratuit cle <clé>|off, status source masquée, message on, aide
- [ ] DR-022 A4 test clé de config utilisée, jamais en clair, priorité env ; npm test 0
- [ ] DR-022 A5 CHANGELOG + version 0.26.0
- [ ] DR-022 B6-8 README.fr.md + README.md anglais, sans etabli, grep = 0
- [ ] DR-022 B9 revue relecteur puis push subtree

## Risques et points de non-retour
- Clé en argument : reste dans l'historique du shell ; le README le dit (variable d'env en alternative).
- `tokens.json` contient désormais la clé OpenRouter : rien ne doit l'afficher (seul `writeConf` l'écrit) ; la désinstallation qui garde/supprime `tokens.json` s'applique telle quelle.
- Le code garde ses branches etabli (`x-cqr-resume`, réglage) : seul le README les tait.
- Point de non-retour : le push GitHub (dépôt public) — vérifier `grep -rn "sk-or-" README* src test` sans vraie clé avant.

## Questions ouvertes
Aucune.
