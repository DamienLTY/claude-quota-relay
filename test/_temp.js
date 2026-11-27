"use strict";
// Aide commune des tests : requise en tete, elle note chaque dossier que fs.mkdtempSync cree sous %TEMP%
// et l'efface a la fin du processus de test (un fichier de test = un processus).
// Le nettoyage ne fait jamais echouer un test : une erreur est ignoree.
const fs = require("fs");

const crees = [];
const mkdtempOrigine = fs.mkdtempSync;
fs.mkdtempSync = (...a) => { const d = mkdtempOrigine(...a); crees.push(d); return d; };
process.on("exit", () => {
  for (const d of crees.reverse()) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { /* reste : tant pis */ } }
});
