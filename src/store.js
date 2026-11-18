// Stockage persistant (Cloudflare KV) : réglages, état de l'automatisme, états du poêle rencontrés.

import { Ek63Error, describeStatus } from "./ek63.js";

export const DEFAULT_SETTINGS = {
  // Ventilateur auxiliaire du soir : passe à `level` à partir de `time` (heure belge) si le poêle est en marche,
  // puis revient à l'arrêt à la prochaine extinction du poêle.
  auxEvening: { enabled: false, time: "20:00", level: 2 },
};

export function requireKV(env) {
  if (!env.KV) throw new Ek63Error("Stockage non configuré (espace KV manquant).", 503);
  return env.KV;
}

export async function getSettings(env) {
  const stored = env.KV ? await env.KV.get("settings", "json") : null;
  return {
    auxEvening: { ...DEFAULT_SETTINGS.auxEvening, ...(stored && stored.auxEvening) },
    // Commune utilisée pour la température extérieure (Open-Meteo), coordonnées arrondies à ~1 km.
    location: (stored && stored.location) || null,
  };
}

export function validateLocation(l) {
  if (l === null) return null;
  if (!l || typeof l !== "object") throw new Ek63Error("Commune invalide.", 400);
  const { name, region, latitude, longitude } = l;
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Ek63Error("Nom de commune invalide.", 400);
  if (region !== undefined && region !== null && (typeof region !== "string" || region.length > 120)) {
    throw new Ek63Error("Région invalide.", 400);
  }
  const ok = (x, max) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= max;
  if (!ok(latitude, 90) || !ok(longitude, 180)) throw new Ek63Error("Coordonnées invalides.", 400);
  const r2 = (x) => Math.round(x * 100) / 100;
  return { name: name.trim(), region: region || null, latitude: r2(latitude), longitude: r2(longitude) };
}

export function validateAuxEvening(a) {
  if (!a || typeof a !== "object") throw new Ek63Error("Réglage invalide.", 400);
  if (typeof a.enabled !== "boolean") throw new Ek63Error("enabled attend true ou false.", 400);
  if (typeof a.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time)) {
    throw new Ek63Error("L'heure doit être au format HH:MM.", 400);
  }
  if (!Number.isInteger(a.level) || a.level < 1 || a.level > 3) {
    throw new Ek63Error("La vitesse doit être 1, 2 ou 3.", 400);
  }
  return { enabled: a.enabled, time: a.time, level: a.level };
}

export async function saveSettings(env, settings) {
  await requireKV(env).put("settings", JSON.stringify(settings));
}

export async function getRuntime(env) {
  return (env.KV && (await env.KV.get("runtime", "json"))) || { boostActive: false, boostDay: null };
}

export async function saveRuntime(env, runtime) {
  await requireKV(env).put("runtime", JSON.stringify(runtime));
}

// Bibliothèque des états rencontrés : { "41": { description: "Raffreddamento", firstSeen: "..." } }.
// On n'écrit dans KV que lorsqu'un état nouveau apparaît.
let knownStatuses = null;

export function resetStoreCache() {
  knownStatuses = null;
}

export async function recordStatus(env, state) {
  if (!env.KV || state.status === undefined || state.status === null) return;
  const key = String(state.status);
  if (knownStatuses && knownStatuses[key] && knownStatuses[key].description === state.statusDescription) return;
  knownStatuses = (await env.KV.get("statuses", "json")) || {};
  if (knownStatuses[key] && knownStatuses[key].description === state.statusDescription) return;
  knownStatuses[key] = { description: state.statusDescription, firstSeen: new Date().toISOString() };
  await env.KV.put("statuses", JSON.stringify(knownStatuses));
}

export async function listStatuses(env) {
  const stored = (env.KV && (await env.KV.get("statuses", "json"))) || {};
  return Object.entries(stored)
    .map(([code, v]) => ({ code: Number(code), description: v.description, firstSeen: v.firstSeen, ...describeStatus(Number(code), v.description) }))
    .sort((a, b) => a.code - b.code);
}
