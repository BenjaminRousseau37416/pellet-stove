// Mode démo (variable DEMO=1) : un faux poêle en mémoire, pour tester l'interface
// sans toucher au vrai poêle ni avoir besoin des identifiants SmartEK63.
// L'allumage et l'extinction durent 20 secondes, pour voir le bouton se bloquer.

import { Ek63Error, COMMANDS, TRANSITION_PHASES, enrichState, brusselsLocalIso, SCHEDULE_ACTIONS, applyScheduleChange } from "./ek63.js";

const TRANSITION_MS = 20000;

const state = {
  id: "DEMO00000000",
  online: true,
  temperature: 21,
  roomTemperature: 19.4,
  power: 3,
  mode: "manual",
  standbyMode: false,
  relaxMode: false,
  fansNumber: 2,
  fan1Power: 2,
  fan2Power: 0,
  continuousCochleaMode: false,
  scheduling: {
    active: false,
    slot1: { startTime: 7200, endTime: 39600, days: ["TUE", "WED", "THU", "FRI", "SAT"] },
    slot2: { startTime: 0, endTime: 0, days: [] },
    slot3: { startTime: 0, endTime: 0, days: [] },
    slot4: { startTime: 0, endTime: 0, days: [] },
    slot5: { startTime: 0, endTime: 0, days: [] },
    slot6: { startTime: 0, endTime: 0, days: [] },
    slot7: null,
    slot8: null,
  },
  easyTimerDate: null,
};
// Horloge du faux poêle : décalée de ~10 ans comme le vrai, jusqu'à la remise à l'heure.
let clockOffsetMs = -(10 * 365 + 150) * 86400000;
let target = false; // allumé demandé ?
let changedAt = 0;

function currentStatus() {
  const inTransition = Date.now() - changedAt < TRANSITION_MS;
  if (target) return inTransition ? [2, "Accensione"] : [5, "Lavoro"];
  return inTransition && changedAt ? [41, "Raffreddamento"] : [0, "Stufa spenta"];
}

export async function getState() {
  // Easy timer échu : on inverse l'état, comme le vrai poêle.
  if (state.easyTimerDate && Date.now() >= new Date(state.easyTimerDate).getTime()) {
    target = !target;
    changedAt = Date.now();
    state.easyTimerDate = null;
  }
  const [status, statusDescription] = currentStatus();
  const now = new Date();
  const date = brusselsLocalIso(new Date(now.getTime() + clockOffsetMs));
  return enrichState({ ...state, status, statusDescription, date, lastUpdate: now.toISOString() });
}

export async function sendCommand(env, action, value) {
  if (SCHEDULE_ACTIONS.has(action)) {
    state.scheduling = applyScheduleChange(state.scheduling, action, value);
    return { demo: true };
  }
  const build = COMMANDS[action];
  if (!build) throw new Ek63Error(`Commande inconnue : ${action}`, 400);
  const [, body] = build(value); // même validation que pour le vrai poêle
  switch (action) {
    case "timer": state.easyTimerDate = body.date; break;
    case "syncClock": clockOffsetMs = 0; break;
    case "power": {
      const s = await getState();
      if (TRANSITION_PHASES.has(s.phase)) {
        throw new Ek63Error(`Pas possible pendant « ${s.statusFr} » : attends que le poêle ait fini.`, 409);
      }
      target = value;
      changedAt = Date.now();
      break;
    }
    case "temperature": state.temperature = value; break;
    case "powerLevel": state.power = value; break;
    case "fan1": state.fan1Power = value; break;
    case "fan2": state.fan2Power = value; break;
    case "relax": state.relaxMode = value; break;
    case "standby": state.standbyMode = value; break;
    case "mode": state.mode = value; break;
  }
  return { demo: true };
}
