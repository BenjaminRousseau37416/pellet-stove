// Mode boost : puissance 5 pendant une durée choisie, puis retour aux réglages d'avant.
//
// - Au lancement, on mémorise la puissance, le mode et le mode relax, puis on passe en manuel,
//   sans relax (qui empêche la puissance maximale) et en puissance 5.
// - La tâche programmée (toutes les 5 minutes) remet les réglages à la fin du boost, ou dès que
//   le poêle s'éteint. Si la puissance n'est plus 5, c'est que l'utilisateur a repris la main :
//   le boost s'arrête sans rien changer.
// - Une commande manuelle de puissance, de mode ou de relax arrête aussi le boost (voir index.js).

import { Ek63Error } from "./ek63.js";

const KEY = "boost";
export const BOOST_POWER = 5;
const MAX_RESTORE_ATTEMPTS = 6; // ~30 minutes de nouvelles tentatives si le poêle refuse

export async function getBoost(env) {
  return (env.KV && (await env.KV.get(KEY, "json"))) || null;
}

export async function clearBoost(env) {
  if (env.KV && (await getBoost(env))) await env.KV.delete(KEY);
}

async function saveBoost(env, boost) {
  await env.KV.put(KEY, JSON.stringify(boost));
}

// Remet la puissance, le mode et le relax d'avant le boost. Renvoie true si tout est passé.
async function restore(env, backend, prev) {
  try {
    if (typeof prev.power === "number" && prev.power !== BOOST_POWER) await backend.sendCommand(env, "powerLevel", prev.power);
    if (prev.mode === "auto") await backend.sendCommand(env, "mode", "auto");
    if (prev.relaxMode === true) await backend.sendCommand(env, "relax", true);
    return true;
  } catch (e) {
    console.error(`Boost : réglages non remis (${e.message || e}), nouvel essai au prochain passage.`);
    return false;
  }
}

// minutes > 0 : lancer (ou prolonger) ; 0 ou null : arrêter et remettre les réglages.
export async function setBoost(env, backend, minutes, now = new Date()) {
  if (!env.KV) throw new Ek63Error("Stockage non configuré (espace KV manquant).", 503);
  const current = await getBoost(env);

  if (minutes === 0 || minutes === null) {
    if (current) {
      await restore(env, backend, current.prev);
      await env.KV.delete(KEY);
    }
    return { boost: null };
  }
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) {
    throw new Ek63Error("Le boost dure de 5 à 120 minutes.", 400);
  }

  const until = new Date(now.getTime() + minutes * 60000).toISOString();
  if (current) {
    // Déjà en cours : on prolonge, en gardant les réglages d'origine.
    const boost = { ...current, until, minutes };
    await saveBoost(env, boost);
    return { boost };
  }

  const s = await backend.getState(env);
  if (s.phase !== "running" && s.phase !== "ignition") {
    throw new Ek63Error("Allume d'abord le poêle pour lancer un boost.", 409);
  }
  const boost = {
    startedAt: now.toISOString(),
    until,
    minutes,
    prev: { power: s.power, mode: s.mode, relaxMode: s.relaxMode === true },
    attempts: 0,
  };
  // Enregistré avant les commandes : même en cas d'échec partiel, la fin du boost remettra tout.
  await saveBoost(env, boost);
  if (s.relaxMode) await backend.sendCommand(env, "relax", false);
  if (s.mode !== "manual") await backend.sendCommand(env, "mode", "manual");
  await backend.sendCommand(env, "powerLevel", BOOST_POWER);
  return { boost };
}

// Appelé par la tâche programmée.
export async function checkBoost(env, backend, now = new Date()) {
  const boost = await getBoost(env);
  if (!boost) return { action: "none" };
  const s = await backend.getState(env);
  if (s.online === false) return { action: "offline" };

  const stoveStopped = s.phase === "off" || s.phase === "shutdown" || s.phase === "cleaning";
  const finished = now.getTime() >= Date.parse(boost.until);
  if (!stoveStopped && !finished) {
    if (typeof s.power === "number" && s.power !== BOOST_POWER && boost.attempts === 0) {
      await env.KV.delete(KEY); // l'utilisateur a changé la puissance : il a repris la main
      return { action: "taken-over" };
    }
    return { action: "running" };
  }

  if (await restore(env, backend, boost.prev)) {
    await env.KV.delete(KEY);
    console.log(`Boost terminé (${stoveStopped ? "poêle arrêté" : "durée écoulée"}), réglages remis.`);
    return { action: "restored" };
  }
  if (boost.attempts + 1 >= MAX_RESTORE_ATTEMPTS) {
    await env.KV.delete(KEY);
    return { action: "gave-up" };
  }
  await saveBoost(env, { ...boost, attempts: boost.attempts + 1 });
  return { action: "retry" };
}

// Ce que l'interface a besoin de savoir.
export function publicBoost(boost) {
  return boost ? { until: boost.until, minutes: boost.minutes, startedAt: boost.startedAt, prevPower: boost.prev.power } : null;
}
