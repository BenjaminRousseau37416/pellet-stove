// Automatisme lancé toutes les 5 minutes par Cloudflare (tâche programmée).
// Ventilateur auxiliaire du soir : à partir de l'heure choisie, dès que le poêle est en marche,
// on passe l'auxiliaire à la vitesse voulue (une fois par soir). À la prochaine extinction, on le remet à l'arrêt.

import { getSettings, getRuntime, saveRuntime, recordStatus } from "./store.js";

const TIME_ZONE = "Europe/Brussels";

export function localTime(now, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export async function runAutomation(env, backend, now = new Date()) {
  if (!env.KV) return { action: "no-storage" };
  const { auxEvening: a } = await getSettings(env);
  const rt = await getRuntime(env);
  const { day, minutes } = localTime(now);
  const due = a.enabled && rt.boostDay !== day && minutes >= toMinutes(a.time);

  // Rien à surveiller : on n'interroge même pas le poêle.
  if (!rt.boostActive && !due) return { action: "none" };

  const state = await backend.getState(env);
  await recordStatus(env, state);
  if (state.online === false) return { action: "offline" };

  if (rt.boostActive) {
    if (state.phase === "shutdown" || state.phase === "off") {
      await backend.sendCommand(env, "fan2", 0);
      await saveRuntime(env, { ...rt, boostActive: false, lastReset: now.toISOString() });
      console.log("Automatisme : poêle en extinction, ventilateur auxiliaire remis à l'arrêt.");
      return { action: "reset" };
    }
    return { action: "waiting-shutdown" };
  }

  if (state.phase === "running") {
    await backend.sendCommand(env, "fan2", a.level);
    await saveRuntime(env, { ...rt, boostDay: day, boostActive: true, lastBoost: now.toISOString() });
    console.log(`Automatisme : ventilateur auxiliaire passé à ${a.level}.`);
    return { action: "boost" };
  }
  return { action: "waiting-running" };
}
