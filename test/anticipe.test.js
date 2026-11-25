// Compactage anticipe (DR-980, DR-985) : module de decision du relais. Fonctions pures, jamais d'exception.
// Run: node test/anticipe.test.js
const assert = require("assert");
const A = require("../src/anticipe.js");

let n = 0;
function t(nom, f) { try { f(); n++; } catch (e) { console.error("ECHEC : " + nom + "\n" + (e.stack || e)); process.exit(1); } }

// ---------- messages (formes vues dans le transcrit reel, essai du 23/11) ----------
const user = (c) => ({ role: "user", content: c });
const asst = (c) => ({ role: "assistant", content: c });
const lance = (id) => user([{ type: "tool_result", tool_use_id: "toolu_" + id, content: [{ type: "text", text: "Async agent launched successfully.\nagentId: " + id + " (internal ID - do not mention to user)\noutput_file: C:\\tmp\\" + id + ".output\nThe agent is working in the background." }] }]);
const finTxt = (id, statut) => "<task-notification><task-id>" + id + "</task-id><tool-use-id>toolu_x</tool-use-id><output-file>C:\\tmp\\" + id + ".output</output-file><status>" + (statut || "completed") + "</status><summary>ok</summary><result>rapport</result></task-notification>";
const fin = (id, statut) => user(finTxt(id, statut));
const reprise = (id) => user([{ type: "tool_result", tool_use_id: "toolu_r", content: '{"success":true,"message":"Resuming agent ' + id + '","resumedAgentId":"' + id + '"}' }]);
const ids = (m) => Array.from(A.agentsEnCours(m)).sort();

t("lance sans notification -> {id}", () => assert.deepStrictEqual(ids([user("go"), lance("a1")]), ["a1"]));
for (const s of ["completed", "failed", "killed"]) t("fin " + s + " -> vide", () => assert.deepStrictEqual(ids([lance("a1"), fin("a1", s)]), []));
t("lance, notifie puis relance (reprise) -> {id}", () => assert.deepStrictEqual(ids([lance("a1"), fin("a1"), reprise("a1")]), ["a1"]));
t("lance, notifie, repris, renotifie -> vide", () => assert.deepStrictEqual(ids([lance("a1"), fin("a1"), reprise("a1"), fin("a1")]), []));
t("notification precedee de [SYSTEM NOTIFICATION] -> reconnue", () =>
  assert.deepStrictEqual(ids([lance("a1"), user("[SYSTEM NOTIFICATION - NOT USER INPUT]\nautomated\n\n" + finTxt("a1"))]), []));
t("notification au milieu d'un texte utilisateur -> reconnue", () =>
  assert.deepStrictEqual(ids([lance("a1"), user([{ type: "text", text: "debut" }, { type: "text", text: "blabla " + finTxt("a1") + " suite" }])]), []));
// Constat de l'essai de bout en bout (23/11) : Claude Code range la notification dans un message de role "system" (les rappels de jetons aussi).
t("notification dans un message de role system (tableau de blocs) -> reconnue", () =>
  assert.deepStrictEqual(ids([lance("a1"), { role: "system", content: [{ type: "text", text: "[SYSTEM NOTIFICATION - NOT USER INPUT]\nautomated\n\n" + finTxt("a1") }] }]), []));
t("notification dans un message de role system (chaine) -> reconnue", () => assert.deepStrictEqual(ids([lance("a1"), { role: "system", content: finTxt("a1") }]), []));
t("lancement cite dans un message system -> ignore", () => assert.deepStrictEqual(ids([{ role: "system", content: [{ type: "tool_result", content: "Async agent launched successfully. agentId: a1" }] }]), []));
t("notification citee par l'assistant -> ne ferme rien", () => assert.deepStrictEqual(ids([lance("a1"), asst(finTxt("a1"))]), ["a1"]));
t("deux agents, un fini", () => assert.deepStrictEqual(ids([lance("a1"), lance("b2"), fin("a1")]), ["b2"]));
t("id d'une commande Bash de fond -> ignore", () => assert.deepStrictEqual(ids([user("go"), fin("bash9")]), []));
t("lance puis notification d'un AUTRE id -> reste", () => assert.deepStrictEqual(ids([lance("a1"), fin("zz")]), ["a1"]));
t("rapport d'un Agent au premier plan -> vide", () =>
  assert.deepStrictEqual(ids([user([{ type: "tool_result", tool_use_id: "t", content: "Le sous-agent a termine : voici le rapport. agentId: a1" }])]), []));
t("texte assistant qui cite 'Async agent launched' -> ignore", () =>
  assert.deepStrictEqual(ids([asst("Async agent launched successfully. agentId: a1")]), []));
for (const [nom, v] of [["absent", undefined], ["null", null], ["vide", []], ["objet", {}], ["chaine", "x"], ["elements bizarres", [null, 3, "a", { role: 1 }, { role: "user", content: 5 }, { role: "user", content: [null, { type: "tool_result", content: null }, 7] }]]])
  t("messages " + nom + " -> vide, sans exception", () => assert.deepStrictEqual(ids(v), []));

// ---------- fenetre, seuil, cible, declenchement ----------
const conf = { compaction: { anticipe: { enabled: true, ratio: 0.94, fenetres: { "claude-opus-5-5": 333000, "claude-haiku-5-5": 1000000 }, cibles: { "claude-haiku-5-5": 400000 } } } };
t("fenetre : normalisation", () => {
  assert.strictEqual(A.fenetre("claude-opus-5-5", conf), 333000);
  assert.strictEqual(A.fenetre("Claude-Opus-5-5[1m]", conf), 333000);
  assert.strictEqual(A.fenetre("claude-opus-5-5-20261101", conf), 333000);
  assert.strictEqual(A.fenetre("claude-sonnet-5-5", conf), null);
  assert.strictEqual(A.fenetre(undefined, conf), null);
  assert.strictEqual(A.fenetre("claude-opus-5-5", {}), null);
  assert.strictEqual(A.fenetre("claude-opus-5-5", null), null);
});
t("fenetre : cle de config non normalisee", () => assert.strictEqual(A.fenetre("claude-opus-5-5", { compaction: { anticipe: { fenetres: { "Claude-Opus-5-5[1m]": 500000 } } } }), 500000));
t("fenetre : valeur non numerique -> null", () => assert.strictEqual(A.fenetre("claude-opus-5-5", { compaction: { anticipe: { fenetres: { "claude-opus-5-5": "x" } } } }), null));
t("seuil = f - 20000 - 13000", () => { assert.strictEqual(A.seuil(333000), 300000); assert.strictEqual(A.seuil(100000), 67000); });
t("cible : defaut f - 13000, explicite prioritaire", () => {
  assert.strictEqual(A.cible(333000, "claude-opus-5-5", conf), 320000);
  assert.strictEqual(A.cible(1000000, "claude-haiku-5-5", conf), 400000);
  assert.strictEqual(A.cible(333000, "claude-opus-5-5", null), 320000);
});
t("declenchement : entier, 282000 pour 333000 a 0,94", () => {
  assert.strictEqual(A.declenchement(333000, 0.94), 282000);
  assert.strictEqual(A.declenchement(333000, 0.05), 15000);
  assert.strictEqual(A.declenchement(333000, undefined), 282000);
  assert.ok(Number.isInteger(A.declenchement(333123, 0.94)));
});

// ---------- contexte ----------
t("contexte : somme des 3 champs d'entree", () => assert.strictEqual(A.contexte({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 999 }), 113));
t("contexte : derniere iteration 'message'", () => assert.strictEqual(A.contexte({ input_tokens: 1, cache_read_input_tokens: 1, iterations: [
  { type: "message", input_tokens: 5, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 }, { type: "advisor_message", input_tokens: 9000 }, { type: "message", input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 90 }, { type: "advisor_message", input_tokens: 9000 }] }), 100));
t("contexte : iterations sans type message -> haut de usage", () => assert.strictEqual(A.contexte({ input_tokens: 2, cache_read_input_tokens: 8, iterations: [{ type: "compaction", input_tokens: 9999 }] }), 10));
t("contexte : champs absents ou usage invalide", () => { assert.strictEqual(A.contexte({}), 0); assert.strictEqual(A.contexte(null), 0); assert.strictEqual(A.contexte({ input_tokens: "x", cache_read_input_tokens: null }), 0); });

// ---------- flux SSE ----------
// Caractere multi-octets volontaire dans un evenement non touche : une coupure au milieu d'un caractere ne doit rien changer.
const ev = (nom, d) => "event: " + nom + "\ndata: " + JSON.stringify(d) + "\n\n";
const crlf = (s) => s.replace(/\n/g, "\r\n"); // le JSON de ces fixtures ne contient aucun saut de ligne brut
function flux(opts) {
  opts = opts || {};
  const startUsage = Object.assign({ input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: opts.cr == null ? 289000 : opts.cr, output_tokens: 1 }, opts.startUsage || {});
  const deltaUsage = Object.assign({ output_tokens: 57 }, opts.deltaUsage || {});
  const d = { type: "message_delta", delta: { stop_reason: opts.stop || "end_turn", stop_sequence: null } };
  if (!opts.sansUsage) d.usage = deltaUsage;
  return ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: startUsage } })
    + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "voila l'\u00e9t\u00e9, \u00e7a marche \u{1F600}" } })
    + ev("content_block_stop", { type: "content_block_stop", index: 0 })
    + "event: message_delta\ndata: " + (opts.dataIllisible ? "{pas du json" : JSON.stringify(d)) + "\n\n"
    + ev("message_stop", { type: "message_stop" });
}
function passe(texte, params, coupes) {
  const T = A.transformeSSE(params), out = [];
  T.on("data", (c) => out.push(Buffer.from(c)));
  const b = Buffer.from(texte, "utf8"); let pos = 0;
  for (const c of (coupes || [])) { if (c > pos && c < b.length) { T.write(b.subarray(pos, c)); pos = c; } }
  T.write(b.subarray(pos)); T.end();
  return Buffer.concat(out);
}
const decisions = [];
const P = (extra) => Object.assign({ ratio: 0.94, fenetre: 333000, cible: 320000, surDecision: (d) => decisions.push(d) }, extra || {});
function deltaDe(buf) { const m = /event: message_delta\r?\ndata: (.*)\r?\n/.exec(buf.toString("utf8")); return JSON.parse(m[1]); }
const LIGNE_DELTA = /event: message_delta\r?\ndata: .*\r?\n\r?\n/;
function somme(o) { return o.input_tokens + o.cache_creation_input_tokens + o.cache_read_input_tokens; }

t("end_turn a 94 % tout juste (282000) -> reecrit, somme = cible, reste intact", () => {
  decisions.length = 0;
  const entree = flux({ cr: 282000 - 1004 }); // 4 + 1000 + cr = 282000 pile
  const sortie = passe(entree, P());
  const u = deltaDe(sortie).usage;
  assert.strictEqual(somme(u), 320000);
  assert.strictEqual(u.input_tokens, 4); assert.strictEqual(u.cache_creation_input_tokens, 1000); assert.strictEqual(u.output_tokens, 57);
  assert.deepStrictEqual(decisions, [{ gonfle: true, contexte: 282000, declenchement: 282000, cible: 320000 }]);
  assert.strictEqual(sortie.toString("utf8").replace(LIGNE_DELTA, ""), entree.replace(LIGNE_DELTA, ""));
});
t("end_turn a 97 % -> reecrit", () => assert.strictEqual(somme(deltaDe(passe(flux({ cr: 290000 }), P())).usage), 320000)); // 291004 / 300000
t("93,9 % (281999) -> octet pour octet, decision gonfle=false", () => {
  decisions.length = 0;
  const entree = flux({ cr: 281999 - 1004 });
  assert.strictEqual(passe(entree, P()).toString("utf8"), entree);
  assert.deepStrictEqual(decisions, [{ gonfle: false, contexte: 281999, declenchement: 282000, cible: 320000 }]);
});
t("tool_use -> identique, aucune decision", () => {
  decisions.length = 0;
  const entree = flux({ stop: "tool_use" });
  assert.strictEqual(passe(entree, P()).toString("utf8"), entree); assert.strictEqual(decisions.length, 0);
});
t("max_tokens -> identique", () => { const e = flux({ stop: "max_tokens" }); assert.strictEqual(passe(e, P()).toString("utf8"), e); });
t("contexte deja au-dessus de la cible -> identique (rien a gonfler)", () => {
  decisions.length = 0;
  const e = flux({ cr: 330000 }); assert.strictEqual(passe(e, P()).toString("utf8"), e);
  assert.strictEqual(decisions[0].gonfle, false);
});
t("delta sans usage -> usage pose depuis message_start", () => assert.strictEqual(somme(deltaDe(passe(flux({ sansUsage: true }), P())).usage), 320000));
t("data illisible -> identique", () => { const e = flux({ dataIllisible: true }); assert.strictEqual(passe(e, P()).toString("utf8"), e); });
t("flux sans message_start -> identique (rien a lire)", () => { const e = ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }); assert.strictEqual(passe(e, P()).toString("utf8"), e); });

// iterations
const IT = (cr, extra) => Object.assign({ type: "message", input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: cr, output_tokens: 57 }, extra || {});
t("iterations seulement dans message_start -> copie corrigee posee dans le delta", () => {
  const u = deltaDe(passe(flux({ startUsage: { iterations: [IT(289000)] } }), P())).usage;
  assert.strictEqual(somme(u), 320000);
  assert.strictEqual(u.iterations.length, 1); assert.strictEqual(somme(u.iterations[0]), 320000); assert.strictEqual(u.iterations[0].output_tokens, 57);
});
t("iterations dans le delta -> derniere iteration 'message' reecrite, advisor intact", () => {
  const adv = { type: "advisor_message", input_tokens: 9000, output_tokens: 5 };
  const u = deltaDe(passe(flux({ startUsage: { iterations: [IT(100)] }, deltaUsage: { iterations: [IT(100), adv, IT(289000, { output_tokens: 11 })] } }), P())).usage;
  assert.strictEqual(somme(u), 320000);
  assert.strictEqual(somme(u.iterations[2]), 320000); assert.strictEqual(u.iterations[2].output_tokens, 11);
  assert.strictEqual(somme(u.iterations[0]), 1104); assert.deepStrictEqual(u.iterations[1], adv);
});
t("iterations absentes -> pas d'iterations inventees", () => assert.strictEqual(deltaDe(passe(flux(), P())).usage.iterations, undefined));
t("le contexte juge est celui de l'iteration, pas du haut de usage", () => {
  decisions.length = 0;
  // haut de usage a 290 k mais iteration 'message' a 6 k : Claude Code lit l'iteration -> sous le seuil
  const e = flux({ startUsage: { iterations: [IT(5000)] } });
  assert.strictEqual(passe(e, P()).toString("utf8"), e); assert.strictEqual(decisions[0].contexte, 6004);
});

// coupures et formes d'evenements
t("coupe a CHAQUE position (un seul point de coupe) -> meme sortie qu'en un morceau", () => {
  const e = flux({ startUsage: { iterations: [IT(289000)] } });
  const ref = passe(e, P());
  assert.ok(ref.toString("utf8") !== e);
  for (let i = 1; i < Buffer.byteLength(e); i++) assert.ok(passe(e, P(), [i]).equals(ref), "coupe en " + i);
});
t("coupes multiples (chaque octet du debut du flux, puis le reste)", () => {
  const e = flux(); const ref = passe(e, P()); const c = []; for (let i = 1; i < 400; i++) c.push(i);
  assert.ok(passe(e, P(), c).equals(ref));
});
t("CRLF : reecrit, fins de ligne conservees", () => {
  const e = crlf(flux()); const s = passe(e, P());
  assert.strictEqual(somme(deltaDe(s).usage), 320000);
  assert.strictEqual(s.toString("utf8").split("\r\n").length, e.split("\r\n").length);
  assert.ok(!/[^\r]\n/.test(s.toString("utf8")));
  const bas = crlf(flux({ cr: 1000 })); assert.strictEqual(passe(bas, P()).toString("utf8"), bas);
});
t("coupe a chaque position, CRLF", () => {
  const e = crlf(flux()); const ref = passe(e, P());
  for (let i = 1; i < Buffer.byteLength(e); i++) assert.ok(passe(e, P(), [i]).equals(ref), "coupe en " + i);
});
t("une seule decision par reponse meme avec deux end_turn", () => {
  decisions.length = 0;
  const e = flux() + ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
  passe(e, P()); assert.strictEqual(decisions.length, 1);
});
t("surDecision qui leve -> le flux passe quand meme", () => assert.strictEqual(somme(deltaDe(passe(flux(), P({ surDecision: () => { throw new Error("boum"); } }))).usage), 320000));
t("fin de flux sans separateur final -> rien de perdu", () => { const e = flux().replace(/\n\n$/, ""); assert.strictEqual(passe(e, P()).toString("utf8").length > 0, true); });
t("parametres invalides -> flux identique, aucune exception", () => {
  const e = flux();
  for (const p of [{}, { ratio: "x", fenetre: 0, cible: 0 }, undefined]) assert.strictEqual(passe(e, p).toString("utf8"), e);
});

// ---------- le module n'utilise que des modules natifs ----------
t("require : modules natifs seulement", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "anticipe.js"), "utf8");
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) assert.ok(/^(node:|stream$)/.test(m[1]), "require non natif : " + m[1]);
});

console.log("anticipe.test.js : " + n + " tests OK");
