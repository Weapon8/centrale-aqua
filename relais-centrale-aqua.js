// Relais Centrale Aqua 1.0.0 : Cloudflare Worker (offre gratuite), par weapon666.
//
// Pourquoi un relais : la page sur GitHub Pages ne peut pas lire directement la
// carte sur le réseau de la maison (le navigateur bloque). La carte envoie donc
// ses mesures ici toutes les 2 minutes, le relais les garde, et la page les lit.
//
// À régler dans Cloudflare (worker → Settings) :
//   - Bindings → KV namespace, nom de variable : AQUA          (obligatoire)
//   - Variables and Secrets → Secret CLE_CARTE                   (obligatoire,
//     la même valeur que CLE_RELAIS dans CentraleAqua.ino)
//   - Variables and Secrets → Secret DISCORD_WEBHOOK             (facultatif,
//     pour recevoir les alarmes sur Discord)
//   - Triggers → Cron Triggers : */5 * * * *                     (facultatif,
//     prévient sur Discord si la carte ne donne plus de nouvelles)
//
// Adresses :
//   GET  /        → état du relais (pour vérifier les réglages)
//   GET  /etat    → dernières mesures + historique 48 h (lu par la page)
//   POST /mesure  → envoi des mesures par la carte (en-tête X-Cle obligatoire)

const VERSION = "1.0.0";

const HISTO_DUREE_S = 48 * 3600;   // on garde 48 h de courbes
const HISTO_PAS_MIN_S = 60;        // au plus un point par minute dans l'historique
const ENVOI_MIN_S = 15;            // une carte qui s'emballe ne vide pas le quota KV
const MUETTE_APRES_S = 10 * 60;    // plus de nouvelles depuis 10 min = carte muette

const CODES_ALARME = ["sonde", "froid", "chaud", "chute"];
const TEXTE_ALARME = {
  sonde: "sonde débranchée ?",
  froid: "trop froid",
  chaud: "trop chaud",
  chute: "la température chute vite",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, statut = 200) {
  return new Response(JSON.stringify(obj), {
    status: statut,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

// Comparaison de la clé sans fuite de temps
function memeCle(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < eb.length; i++) diff |= (ea[i] ?? 0) ^ eb[i];
  return diff === 0;
}

function nombre(v, min, max) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function texte(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

// Remet en forme ce que la carte envoie, et rejette ce qui n'a pas de sens
function nettoyer(brut) {
  if (!brut || typeof brut !== "object" || !Array.isArray(brut.zones)) return null;
  if (brut.zones.length < 1 || brut.zones.length > 8) return null;
  const zones = brut.zones.map((z) => {
    const t = nombre(z?.t, -20, 70);
    return {
      nom: texte(z?.nom, 24) || "?",
      actif: z?.actif !== false,
      t: t === null ? null : Math.round(t * 100) / 100,
      al: Array.isArray(z?.al) ? CODES_ALARME.filter((c) => z.al.includes(c)) : [],
      coupe: z?.coupe === true,
    };
  });
  const s = brut.seuils || {};
  return {
    zones,
    seuils: {
      bas: nombre(s.bas, -20, 70),
      haut: nombre(s.haut, -20, 70),
      chute: nombre(s.chute, 0, 20),
    },
    up: nombre(brut.up, 0, 1e10),
    rssi: nombre(brut.rssi, -120, 0),
    ble: brut.ble === true,
    version: texte(brut.version, 16),
  };
}

function degres(t) {
  return t === null || t === undefined ? "?" : t.toFixed(1).replace(".", ",") + " °C";
}

async function discord(env, lignes) {
  if (!env.DISCORD_WEBHOOK || lignes.length === 0) return;
  try {
    await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Centrale Aqua", content: lignes.join("\n").slice(0, 1900) }),
    });
  } catch (e) {
    // Discord en panne : on ne bloque pas l'enregistrement des mesures
  }
}

// Alarmes apparues ou disparues depuis le dernier envoi
function changements(avant, apres) {
  const lignes = [];
  apres.zones.forEach((z, i) => {
    const prec = avant?.zones?.[i];
    const anciennes = prec && prec.nom === z.nom ? prec.al : [];
    const nouvelles = z.al.filter((c) => !anciennes.includes(c));
    if (nouvelles.length) {
      lignes.push(`🔴 **${z.nom}** : ${nouvelles.map((c) => TEXTE_ALARME[c]).join(", ")} (${degres(z.t)})`);
    } else if (anciennes.length && z.al.length === 0) {
      lignes.push(`✅ **${z.nom}** : retour à la normale (${degres(z.t)})`);
    }
  });
  return lignes;
}

async function recevoirMesure(request, env) {
  if (!memeCle(request.headers.get("X-Cle"), env.CLE_CARTE)) return json({ ok: false, erreur: "cle" }, 401);
  if (!env.AQUA) return json({ ok: false, erreur: "kv absent" }, 500);

  const corps = await request.text();
  if (corps.length > 8000) return json({ ok: false, erreur: "trop gros" }, 413);
  let brut;
  try {
    brut = JSON.parse(corps);
  } catch (e) {
    return json({ ok: false, erreur: "json" }, 400);
  }
  const mesure = nettoyer(brut);
  if (!mesure) return json({ ok: false, erreur: "format" }, 400);

  const maintenant = Math.floor(Date.now() / 1000);
  const avant = await env.AQUA.get("etat", "json");
  const alarmesChangent = changements(avant, mesure).length > 0;

  if (avant && maintenant - avant.maj < ENVOI_MIN_S && !alarmesChangent) {
    return json({ ok: true, ignore: true });
  }

  // Historique : on repart de zéro si les bacs ont changé de nom ou de nombre
  const noms = mesure.zones.map((z) => z.nom);
  let histo = avant?.histo;
  if (!histo || JSON.stringify(histo.noms) !== JSON.stringify(noms)) histo = { noms, points: [] };
  const dernier = histo.points[histo.points.length - 1];
  if (!dernier || maintenant - dernier[0] >= HISTO_PAS_MIN_S) {
    histo.points.push([maintenant, ...mesure.zones.map((z) => (z.actif ? z.t : null))]);
  }
  const limite = maintenant - HISTO_DUREE_S;
  while (histo.points.length && histo.points[0][0] < limite) histo.points.shift();

  const etat = { maj: maintenant, ...mesure, histo };
  await env.AQUA.put("etat", JSON.stringify(etat));

  const lignes = changements(avant, mesure);
  const etaitMuette = await env.AQUA.get("muette");
  if (etaitMuette) {
    await env.AQUA.delete("muette");
    lignes.unshift("🟢 La centrale répond de nouveau.");
  }
  await discord(env, lignes);

  return json({ ok: true });
}

async function lireEtat(env) {
  if (!env.AQUA) return json({ ok: false, erreur: "kv absent" }, 500);
  const etat = await env.AQUA.get("etat", "json");
  const maintenant = Math.floor(Date.now() / 1000);
  if (!etat) return json({ ok: true, vide: true, serveur: maintenant });
  const age = maintenant - etat.maj;
  return json({ ok: true, serveur: maintenant, age, muette: age > MUETTE_APRES_S, ...etat });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "centrale-aqua",
        version: VERSION,
        kv: !!env.AQUA,
        cle: !!env.CLE_CARTE,
        discord: !!env.DISCORD_WEBHOOK,
      });
    }
    if (request.method === "GET" && url.pathname === "/etat") return lireEtat(env);
    if (request.method === "POST" && url.pathname === "/mesure") return recevoirMesure(request, env);
    return json({ ok: false, erreur: "introuvable" }, 404);
  },

  // Toutes les 5 minutes (si le Cron Trigger est réglé) : la carte est-elle muette ?
  async scheduled(event, env, ctx) {
    if (!env.AQUA || !env.DISCORD_WEBHOOK) return;
    const etat = await env.AQUA.get("etat", "json");
    if (!etat) return;
    const age = Math.floor(Date.now() / 1000) - etat.maj;
    if (age <= MUETTE_APRES_S) return;
    if (await env.AQUA.get("muette")) return;   // déjà prévenu
    await env.AQUA.put("muette", "1");
    const minutes = Math.round(age / 60);
    await discord(env, [
      `⚠️ La centrale ne donne plus de nouvelles depuis ${minutes} min (coupure de courant, wifi ou box ?).`,
    ]);
  },
};
