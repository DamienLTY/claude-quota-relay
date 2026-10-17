"use strict";

/**
 * Sonde de mesure sur le flux de reponse SSE.
 *
 * Le proxy local recopie aujourd'hui la reponse verbatim et ne lit que les
 * en-tetes de quota — des pourcentages, pas des tokens. Or le flux porte le
 * cout reel :
 *
 *   message_start .usage -> input_tokens, cache_creation_input_tokens,
 *                           cache_read_input_tokens
 *   message_delta .usage -> output_tokens
 *   message_delta .context_management.applied_edits
 *                        -> cleared_tool_uses, cleared_input_tokens
 *
 * Les lire donne le cout decompose par compte, par modele et par decision,
 * sans emettre une seule completion — donc sans consommer de quota. C'est
 * l'instrument qui permet de juger tout le reste.
 *
 * Trois invariants, dans cet ordre de priorite :
 *
 *   1. NE JAMAIS RETARDER UN CHUNK. On pousse d'abord, on analyse ensuite.
 *      Une sonde qui ajoute de la latence a un flux interactif serait pire
 *      que le probleme qu'elle mesure.
 *   2. NE JAMAIS CASSER LE FLUX. Toute erreur d'analyse est avalee. Une sonde
 *      qui plante coupe la session de l'utilisateur.
 *   3. NE JAMAIS RETENIR DE SECRET. On n'extrait que des nombres et des
 *      identifiants de modele ; jamais le contenu des messages.
 */

const { Transform } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

// Au-dela, on considere qu'on ne lit pas du SSE (corps binaire, gzip, ou
// trame aberrante) et on cesse d'accumuler. Le flux continue intact.
const TAILLE_TAMPON_MAX = 1024 * 1024;

function entete(entetes, nom) {
  if (!entetes) return "";
  return String(entetes[nom] || entetes[nom.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())] || "").toLowerCase();
}

/**
 * Fabrique un decompresseur pour l'encodage annonce, ou null si le corps est
 * deja en clair.
 *
 * Premiere version : on refusait d'analyser toute reponse compressee. Mesure
 * en production : **42 tours reels sur 45 etaient illisibles**, la sonde ne
 * voyait que 2 % du trafic. `accept-encoding` n'est retire qu'en mode
 * keepalive SSE, donc la branche normale recoit du compresse.
 *
 * La decompression ne viole pas l'invariant 1 : elle porte sur une COPIE des
 * octets, alimentee apres que le chunk d'origine a deja ete pousse vers le
 * client. Le flux client ne traverse jamais le decompresseur.
 */
function decompresseur(encodage) {
  if (encodage === "gzip" || encodage === "x-gzip") return zlib.createGunzip();
  if (encodage === "deflate") return zlib.createInflate();
  if (encodage === "br") return zlib.createBrotliDecompress();
  if (encodage === "zstd" && zlib.createZstdDecompress) return zlib.createZstdDecompress();
  return null;
}

/** Vrai si le corps porte un format qu'on sait lire, compresse ou non. */
function analysable(entetes) {
  const encodage = entete(entetes, "content-encoding");
  if (encodage && encodage !== "identity" && !decompresseur(encodage)) return false;
  const type = entete(entetes, "content-type");
  return type.includes("event-stream") || type.includes("json");
}

function entierOuZero(valeur) {
  return Number.isFinite(valeur) ? valeur : 0;
}

/**
 * Cree le Transform a interposer a la place d'un `pipe()` direct.
 *
 * @param {object} options
 * @param {object} options.entetes    en-tetes de la reponse amont
 * @param {string} options.requeteId  correlation ; un rejeu 429/500/reseau
 *                                    produit plusieurs reponses amont pour
 *                                    une seule requete cliente, et sans cet
 *                                    identifiant les mesures se melangent
 * @param {object} options.contexte   champs constants a joindre a la mesure
 *                                    (compte actif, decision de compaction…)
 * @param {function} options.surMesure  rappel invoque avec la mesure complete
 */
function creerSonde(options = {}) {
  const entetes = options.entetes || {};
  const contexte = options.contexte || {};
  const requeteId = options.requeteId || null;
  const surMesure = typeof options.surMesure === "function" ? options.surMesure : null;

  const lisible = analysable(entetes);
  const encodage = entete(entetes, "content-encoding");
  const decodeur = new StringDecoder("utf8");
  let tampon = "";
  let abandonne = !lisible;

  // Alimente en parallele du flux client, jamais dans son chemin.
  let detente = lisible && encodage && encodage !== "identity"
    ? decompresseur(encodage)
    : null;

  const mesure = {
    requete_id: requeteId,
    modele: null,
    arret: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    // -1 distingue « aucun bloc context_management dans la reponse » de
    // « le bloc etait la et n'a rien efface ». Confondre les deux ferait
    // passer une strategie inactive pour une strategie inefficace.
    cleared_tool_uses: -1,
    cleared_input_tokens: -1,
    analyse: lisible,
    // Conserves pour diagnostic : c'est l'absence de ces deux champs qui a
    // laisse passer 42 tours illisibles sur 45 sans qu'on sache pourquoi.
    encodage: encodage || "identity",
    type: entete(entetes, "content-type").split(";")[0] || "",
    octets: 0,
    ...contexte,
  };

  function absorber(nomEvenement, donnees) {
    if (!donnees || typeof donnees !== "object") return;

    if (donnees.type === "message_start" && donnees.message) {
      const message = donnees.message;
      if (message.model) mesure.modele = message.model;
      const usage = message.usage || {};
      mesure.input_tokens = entierOuZero(usage.input_tokens);
      mesure.cache_creation_input_tokens = entierOuZero(
        usage.cache_creation_input_tokens
      );
      mesure.cache_read_input_tokens = entierOuZero(usage.cache_read_input_tokens);
      // Certaines reponses portent deja une sortie partielle ici.
      if (usage.output_tokens) mesure.output_tokens = usage.output_tokens;
      return;
    }

    if (donnees.type === "message_delta") {
      const usage = donnees.usage || {};
      if (Number.isFinite(usage.output_tokens)) {
        mesure.output_tokens = usage.output_tokens;
      }
      if (donnees.delta && donnees.delta.stop_reason) {
        mesure.arret = donnees.delta.stop_reason;
      }
      const edits =
        (donnees.context_management && donnees.context_management.applied_edits) ||
        null;
      if (Array.isArray(edits)) {
        let uses = 0;
        let tokens = 0;
        for (const edit of edits) {
          uses += entierOuZero(edit && edit.cleared_tool_uses);
          tokens += entierOuZero(edit && edit.cleared_input_tokens);
        }
        mesure.cleared_tool_uses = uses;
        mesure.cleared_input_tokens = tokens;
      }
      return;
    }

    // Reponse non-SSE : l'API renvoie l'objet complet d'un coup.
    if (nomEvenement === null && donnees.usage) {
      const usage = donnees.usage;
      mesure.input_tokens = entierOuZero(usage.input_tokens);
      mesure.output_tokens = entierOuZero(usage.output_tokens);
      mesure.cache_creation_input_tokens = entierOuZero(
        usage.cache_creation_input_tokens
      );
      mesure.cache_read_input_tokens = entierOuZero(usage.cache_read_input_tokens);
      if (donnees.model) mesure.modele = donnees.model;
    }
  }

  function consommer(texte) {
    tampon += texte;
    if (tampon.length > TAILLE_TAMPON_MAX) {
      abandonne = true;
      mesure.analyse = false;
      tampon = "";
      return;
    }
    let coupure;
    while ((coupure = tampon.indexOf("\n")) !== -1) {
      const ligne = tampon.slice(0, coupure).replace(/\r$/, "");
      tampon = tampon.slice(coupure + 1);
      if (!ligne.startsWith("data:")) continue;
      const charge = ligne.slice(5).trim();
      if (!charge || charge === "[DONE]") continue;
      try {
        absorber(null, JSON.parse(charge));
      } catch (erreur) {
        // Trame partielle ou non-JSON : sans consequence, on continue.
      }
    }
  }

  if (detente) {
    detente.on("data", (bloc) => {
      if (!abandonne) {
        try {
          consommer(decodeur.write(bloc));
        } catch (erreur) {
          abandonne = true;
          mesure.analyse = false;
        }
      }
    });
    // Un corps mal compresse ne doit pas couper la session : on cesse de
    // mesurer, le client garde son flux intact.
    detente.on("error", () => {
      abandonne = true;
      mesure.analyse = false;
      detente = null;
    });
  }

  function terminer() {
    if (!abandonne) {
      try {
        consommer(decodeur.end());
        // Une reponse JSON simple n'a pas de saut de ligne final : ce qui
        // reste dans le tampon est alors le corps entier.
        if (tampon.trim().startsWith("{")) {
          try {
            absorber(null, JSON.parse(tampon));
          } catch (erreur) {
            /* corps tronque : rien a mesurer */
          }
        }
      } catch (erreur) {
        mesure.analyse = false;
      }
    }
    tampon = "";
    if (surMesure) {
      try {
        surMesure(mesure);
      } catch (erreur) {
        // Invariant 2 : un journal qui echoue ne coupe pas la session.
      }
    }
  }

  const flux = new Transform({
    transform(chunk, _encodage, suite) {
      // Invariant 1 : le chunk part avant toute analyse, et il ne traverse
      // jamais le decompresseur — celui-ci ne recoit qu'une copie.
      this.push(chunk);
      mesure.octets += chunk.length;
      if (!abandonne) {
        try {
          if (detente) detente.write(chunk);
          else consommer(decodeur.write(chunk));
        } catch (erreur) {
          abandonne = true;
          mesure.analyse = false;
        }
      }
      suite();
    },
    flush(suite) {
      if (!detente) {
        terminer();
        suite();
        return;
      }
      // Le decompresseur a encore des octets en vol : on attend qu'il finisse
      // avant d'ecrire la mesure. Le flux client, lui, est deja parti.
      let rendu = false;
      const unefois = () => {
        if (rendu) return;
        rendu = true;
        terminer();
        suite();
      };
      // Filet : une decompression qui ne se termine jamais ne doit pas
      // laisser la reponse en suspens.
      const minuteur = setTimeout(unefois, 5000);
      if (minuteur.unref) minuteur.unref();
      detente.on("end", () => {
        clearTimeout(minuteur);
        unefois();
      });
      detente.on("error", () => {
        clearTimeout(minuteur);
        unefois();
      });
      try {
        detente.end();
      } catch (erreur) {
        clearTimeout(minuteur);
        unefois();
      }
    },
  });

  // Invariant 2, second filet : une erreur du Transform ne doit pas remonter.
  flux.on("error", () => {});

  return { flux, mesure };
}

/**
 * Journal JSONL en append. Une ligne par reponse amont.
 *
 * Rotation mensuelle (J3-3) : sans chemin explicite, la ligne va dans
 * `<dossier>/usage-AAAA-MM.jsonl`, le mois etant celui (UTC) du `ts` ecrit dans
 * la ligne ; le premier ecrit d'un nouveau mois ouvre donc un nouveau fichier.
 * Rien n'est jamais supprime ni renomme : l'ancien `usage.jsonl` sans date reste
 * tel quel. Avec un chemin explicite (CQR_USAGE_FILE, tests), un seul fichier,
 * comme avant.
 *
 * Ecriture synchrone volontaire : ces lignes font quelques centaines
 * d'octets, elles arrivent en fin de reponse (jamais dans le chemin
 * interactif), et une ecriture synchrone garantit qu'un arret brutal du
 * proxy ne perd pas la derniere mesure.
 *
 * @param {string} [cheminFichier]  fichier unique (pas de rotation)
 * @param {object} [options]
 * @param {string} [options.dossier]     dossier du journal tourne (defaut ~/.delest)
 * @param {function} [options.maintenant] horloge injectee (tests) : () => Date
 */
function creerJournal(cheminFichier, options = {}) {
  const dossier = options.dossier ||
    path.join(process.env.USERPROFILE || process.env.HOME || ".", ".delest");
  const maintenant = typeof options.maintenant === "function" ? options.maintenant : () => new Date();
  const prets = new Set();
  return function ecrire(mesure) {
    try {
      const ts = maintenant().toISOString();
      const cible = cheminFichier ||
        path.join(dossier, "usage-" + ts.slice(0, 7) + ".jsonl");
      const parent = path.dirname(cible);
      if (!prets.has(parent)) {
        fs.mkdirSync(parent, { recursive: true });
        prets.add(parent);
      }
      fs.appendFileSync(cible, JSON.stringify({ ts, ...mesure }) + "\n");
    } catch (erreur) {
      // Disque plein, permission refusee : on perd la mesure, pas la session.
    }
  };
}

module.exports = { creerSonde, creerJournal, analysable };
