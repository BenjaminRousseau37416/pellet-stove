// Historique des températures : un relevé toutes les 15 minutes, stocké dans KV.
// Une clé par jour (heure belge) : "hist:2026-11-18" -> [[t, pièce, consigne, chauffe, puissance], ...]
//   t : secondes UTC · chauffe : 1 si le poêle est en allumage ou en marche, sinon 0.
// Environ 4 Ko par jour ; chaque jour est gardé 400 jours puis effacé automatiquement.

import { brusselsLocalIso } from "./ek63.js";
import { recordStatus } from "./store.js";

export const SAMPLE_EVERY_MIN = 15;
const KEEP_DAYS = 400;

const round1 = (x) => Math.round(x * 10) / 10;
export const brusselsDay = (date) => brusselsLocalIso(date).slice(0, 10);

// La tâche programmée tourne toutes les 5 minutes : on relève à :00, :15, :30 et :45.
export function isSampleTick(now) {
  return Math.floor(now.getTime() / 60000) % SAMPLE_EVERY_MIN < 5;
}

export async function recordSample(env, backend, now = new Date()) {
  if (!env.KV) return { action: "no-storage" };
  const s = await backend.getState(env);
  await recordStatus(env, s);
  if (s.online === false || typeof s.roomTemperature !== "number") return { action: "skip" };

  const key = `hist:${brusselsDay(now)}`;
  const list = (await env.KV.get(key, "json")) || [];
  const t = Math.floor(now.getTime() / 1000);
  if (list.length && t - list[list.length - 1][0] < 10 * 60) return { action: "duplicate" };

  const heating = s.phase === "running" || s.phase === "ignition" ? 1 : 0;
  list.push([
    t,
    round1(s.roomTemperature),
    typeof s.temperature === "number" ? s.temperature : null,
    heating,
    typeof s.power === "number" ? s.power : null,
  ]);
  await env.KV.put(key, JSON.stringify(list), { expirationTtl: KEEP_DAYS * 86400 });
  return { action: "recorded" };
}

// Liste des dates (AAAA-MM-JJ) de `days` jours se terminant à `endDay` inclus.
export function dayRange(endDay, days) {
  const end = Date.parse(`${endDay}T12:00:00Z`); // midi : à l'abri des changements d'heure
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
}

export async function readHistory(env, endDay, days = 7) {
  const dates = dayRange(endDay, days);
  const values = env.KV ? await Promise.all(dates.map((d) => env.KV.get(`hist:${d}`, "json"))) : dates.map(() => null);
  return dates.map((date, i) => ({ date, samples: values[i] || [] }));
}

// Données fictives pour le mode démo : une semaine de chauffe le matin et le soir.
export function demoHistory(endDay, days = 7, now = new Date()) {
  const dates = dayRange(endDay, days);
  let room = 18;
  return dates.map((date) => {
    const samples = [];
    const midnight = Date.parse(`${date}T00:00:00Z`) - 3600 * 1000; // ≈ minuit belge en hiver
    for (let q = 0; q < 96; q++) {
      const t = midnight + q * 15 * 60000;
      if (t > now.getTime()) break;
      const hour = q / 4;
      const heating = (hour >= 6.5 && hour < 8.5) || (hour >= 17.5 && hour < 23) ? 1 : 0;
      room += heating ? (22.5 - room) * 0.12 : (16 - room) * 0.025;
      samples.push([Math.floor(t / 1000), round1(room + Math.sin(q) * 0.1), 21, heating, heating ? 3 : 1]);
    }
    return { date, samples };
  });
}
