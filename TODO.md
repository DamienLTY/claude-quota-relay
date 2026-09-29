# TODO

Une case ne se coche que sur une preuve (chiffre, journal, contrôle qui échoue quand on casse).

## DR-011 — Requête retenue à travers la veille et le changement de réseau

- [x] Banc d'essai réel (`%TEMP%\cqr-banc\banc.js`, relais de test port 8799, copie des jetons — dossier à supprimer à la fin) : essai témoin réussi. Preuve : `run-temoin-avant-*` → sortie `SOUS-AGENT-OK`, 4 requêtes dans le journal du relais de test.
- [ ] Essais AVANT (relais HEAD) : muette, certificat, wifi, veille — chacun montre la panne.
  - certificat (4 min) : ÉCHEC du sous-agent — 11 tentatives `502 self-signed certificate` en 3 min.
  - muette (5 min) : `Request timed out.` au bout de 307 s (tentative 1/11), puis réussite à la tentative 2 (la panne a cessé avant l'épuisement des tentatives).
  - wifi coupé 3 min : l'ancien relais TIENT déjà (`ENOTFOUND` était dans sa liste) — pas de reproduction, le correctif n'y change rien.
  - veille 150 s + certificat intercepté au réveil : ÉCHEC du sous-agent — 11/11 tentatives `502 self-signed certificate`, `exitPath=error`, `durationMs=400808` (`run-veille-certificat-avant-*`, interrompu par le redémarrage du PC après ce constat).
  - veille seule (1er essai) : non concluant — le réveil auto était bloqué (`RTCWAKE`=2), PC resté endormi ~2 h 45.
- [x] Correctif `src/proxy.js` : signal au client pendant l'attente d'Anthropic, connexion amont muette détectée et retentée, toute erreur sans réponse retentée 60 min depuis la 1re erreur. Preuve : `npm test` vert (2 passes complètes, dont 1 échec isolé non reproduit de `proxy-e2e`, lecture non atomique de `state.json` par le test — hypothèse, non prouvée).
- [x] Test automatique qui échoue sans le correctif. Preuve : `test/network-hold.test.js` échoue sur le `proxy.js` de HEAD (`connexion muette : … TIMEOUT`) ; contre-épreuves par mutation : sans la borne propre aux coupures → `en-tetes sans corps … TIMEOUT` ; sans la coupure du 400 tronqué → `400 coupe en plein corps … TIMEOUT`.
- [ ] Essais APRÈS : mêmes essais, tous réussis.
  - certificat (4 min) : RÉUSSI — 10 tentatives `NETWORK err` du relais, le sous-agent n'en a consommé aucune (`SOUS-AGENT-OK`).
  - muette (5 min) : RÉUSSI mais reprise à 180 s au lieu de 90 s (Node double le délai pendant la poignée de main TLS : 3 s demandées → 6 s mesurées) — corrigé par `idle + 1 s/32 Ko` ; À REFAIRE pour confirmer.
  - wifi coupé 3 min : RÉUSSI (l'ancien relais aussi).
  - veille + certificat au réveil : À FAIRE.
  - veille + wifi absent au réveil : À FAIRE.
- [x] Revue `thermo-review` (sous-agent Sonnet, 2026-09-29) : 0 bloquant. Corrigés : `upstreamIdleMs: 0` inversait l'effet (test + mutation, 2 requêtes amont au lieu d'1), budget `cutStart` remis à zéro après une attente de quota, commentaire du délai précisé. Rejeté avec preuve : « le délai dépasse le garde-fou client » (fenêtre client = 120 s + 1 s/32 Ko, la mienne = 90 s + 1 s/32 Ko). Signalés non corrigés (préexistants, hors demande) : `probeToken` appelle `done()` deux fois si le corps stagne ; `writeHead` après `ctx.sse` laisse un client pendu sur `route.none`/conf illisible/jeton invalide ; 5xx d'un proxy d'entreprise limités à 15 min (`serverErrorMaxMs`), pas 60. `npm test` : 31 contrôles verts après ces corrections.
- [ ] Déploiement sur ce PC, version, CHANGELOG ; déploiement sur le portable (à faire par l'utilisateur ou /relais).
- [ ] Nettoyage : supprimer `%TEMP%\cqr-banc` (contient une copie des jetons).

- [ ] Remettre le réveil par minuteur sur secteur à sa valeur d'origine : `powercfg /setacvalueindex SCHEME_CURRENT 238c9fa8-0aad-41ed-83f4-97be242c8f20 bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d 2` puis `powercfg /setactive SCHEME_CURRENT` (passé à 1 le 2026-09-28 pour les essais, accord DR-011 round 3).

Tâches de fond en cours : aucune. L'essai réel `muette apres` (2026-09-29 ~02:04) a été TUÉ par Claude Code pour pression mémoire (910 Mo libres sur 8 Go, Chrome > 2 Go) : ni réussi ni échoué, à relancer seulement sur demande de l'utilisateur, idéalement Chrome fermé. Aucun processus de test résiduel.
