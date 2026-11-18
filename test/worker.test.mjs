// Tests du Worker avec un faux serveur SmartEK63 et un faux stockage KV (aucun appel réseau réel).
// Lancer : npm test

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import * as ek63 from "../src/ek63.js";
import { resetCache, translateStatus, describeStatus } from "../src/ek63.js";
import { resetStoreCache } from "../src/store.js";
import { runAutomation, localTime } from "../src/automation.js";
import { isSampleTick, recordSample, dayRange } from "../src/history.js";

const BASE_ENV = { ACCESS_CODE: "un-code-de-test-assez-long", EK63_EMAIL: "test@example.com", EK63_PASSWORD: "secret" };
const HOST = "https://poele.example.workers.dev";

// --- Faux stockage KV -----------------------------------------------------
function makeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, v);
    },
  };
}

// --- Faux serveur ---------------------------------------------------------
let calls;
let tokenCounter;
let validToken;
let device;
let ENV;
let putHook; // permet à un test de simuler la réponse du poêle à une commande
const refused = () => new Response(JSON.stringify({ message: "La stufa non accetta il comando inviato", code: "HEATER_COMMAND" }), { status: 409 });
const heater = { id: "AABBCCDDEEFF", name: "EK63-TEST" };

function setDevice(status, statusDescription) {
  device.status = status;
  device.statusDescription = statusDescription;
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body });
  if (url.startsWith("https://cognito-idp.")) {
    const body = JSON.parse(init.body);
    assert.equal(body.AuthFlow, "USER_PASSWORD_AUTH");
    if (body.AuthParameters.PASSWORD !== BASE_ENV.EK63_PASSWORD) {
      return new Response(JSON.stringify({ __type: "NotAuthorizedException", message: "Incorrect username or password." }), { status: 400 });
    }
    validToken = `jeton-${++tokenCounter}`;
    return new Response(JSON.stringify({ AuthenticationResult: { IdToken: validToken, ExpiresIn: 3600 } }));
  }
  if (url.includes("execute-api")) {
    if (init.headers.Authorization !== validToken) return new Response("Unauthorized", { status: 401 });
    if (url.endsWith("/heaters")) return new Response(JSON.stringify([heater]));
    if (url.endsWith(`/heaters/${heater.id}`)) return new Response(JSON.stringify(device));
    if ((init.method || "GET") === "PUT") {
      return putHook ? putHook(url, JSON.parse(init.body)) : new Response(null, { status: 204 });
    }
  }
  return new Response("not found", { status: 404 });
};

beforeEach(() => {
  calls = [];
  tokenCounter = 0;
  validToken = null;
  device = { id: heater.id, online: true, status: 0, statusDescription: "Stufa spenta", temperature: 22, roomTemperature: 21.5, fansNumber: 2, fan1Power: 2, fan2Power: 0, mode: "manual", relaxMode: false, standbyMode: false,
    // Format relevé sur le vrai poêle le 2026-11-18.
    scheduling: {
      active: false,
      slot1: { startTime: 7200, endTime: 39600, days: ["TUE", "WED", "THU", "FRI", "SAT"] },
      slot2: { startTime: 0, endTime: 0, days: [] }, slot3: { startTime: 0, endTime: 0, days: [] },
      slot4: { startTime: 0, endTime: 0, days: [] }, slot5: { startTime: 0, endTime: 0, days: [] },
      slot6: { startTime: 0, endTime: 0, days: [] }, slot7: null, slot8: null,
    },
  };
  ENV = { ...BASE_ENV };
  putHook = null;
  ek63.timing.scheduleRetryDelays = [0, 0];
  resetCache();
  resetStoreCache();
});

// --- Outils ---------------------------------------------------------------
function req(path, { method = "GET", body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return new Request(HOST + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function loginCookie(env = ENV) {
  const res = await worker.fetch(req("/api/login", { method: "POST", body: { code: env.ACCESS_CODE } }), env);
  assert.equal(res.status, 200);
  const set = res.headers.get("Set-Cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  return set.split(";")[0];
}

const puts = () => calls.filter((c) => c.method === "PUT").map((c) => ({ path: c.url.split(`/heaters/${heater.id}/`)[1], body: JSON.parse(c.body) }));
const cognitoCalls = () => calls.filter((c) => c.url.startsWith("https://cognito-idp.")).length;

// --- Accès ----------------------------------------------------------------
test("sans session, l'état est refusé", async () => {
  const res = await worker.fetch(req("/api/state"), ENV);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("un mauvais code est refusé (avec un délai)", async () => {
  const t0 = Date.now();
  const res = await worker.fetch(req("/api/login", { method: "POST", body: { code: "mauvais-code-123" } }), ENV);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.ok(Date.now() - t0 >= 900);
});

test("un code d'accès trop court bloque tout", async () => {
  const res = await worker.fetch(req("/api/state"), { ...ENV, ACCESS_CODE: "court" });
  assert.equal(res.status, 500);
});

test("un cookie falsifié est refusé", async () => {
  const cookie = await loginCookie();
  const forged = cookie.replace(/=(\d+)\./, (m, ts) => `=${Number(ts) + 1}.`);
  const res = await worker.fetch(req("/api/state", { cookie: forged }), ENV);
  assert.equal(res.status, 401);
});

test("changer le code d'accès invalide les anciennes sessions", async () => {
  const cookie = await loginCookie();
  const res = await worker.fetch(req("/api/state", { cookie }), { ...ENV, ACCESS_CODE: "un-tout-nouveau-code-123" });
  assert.equal(res.status, 401);
});

test("une commande venant d'un autre site est refusée", async () => {
  const cookie = await loginCookie();
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "power", value: true }, cookie, origin: "https://site-pirate.example" }), ENV);
  assert.equal(res.status, 403);
  assert.equal(puts().length, 0);
});

test("une commande sans JSON est refusée", async () => {
  const cookie = await loginCookie();
  const r = new Request(HOST + "/api/command", { method: "POST", headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: '{"action":"power","value":true}' });
  const res = await worker.fetch(r, ENV);
  assert.equal(res.status, 400);
});

// --- Lecture et jeton -----------------------------------------------------
test("avec session : l'état du poêle est lu, traduit et classé", async () => {
  setDevice(41, "Raffreddamento");
  const cookie = await loginCookie();
  const res = await worker.fetch(req("/api/state", { cookie }), ENV);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.roomTemperature, 21.5);
  assert.equal(s.statusFr, "Refroidissement");
  assert.equal(s.phase, "shutdown");
  assert.equal(s.isOn, false);
  assert.equal(calls.find((c) => c.url.endsWith(`/heaters/${heater.id}`)).headers.Authorization, "jeton-1");
});

test("le jeton est réutilisé entre deux requêtes", async () => {
  const cookie = await loginCookie();
  await worker.fetch(req("/api/state", { cookie }), ENV);
  await worker.fetch(req("/api/state", { cookie }), ENV);
  assert.equal(cognitoCalls(), 1);
});

test("le jeton est partagé via KV entre deux instances du Worker", async () => {
  ENV.KV = makeKV();
  const cookie = await loginCookie();
  await worker.fetch(req("/api/state", { cookie }), ENV);
  resetCache(); // nouvelle instance : plus de cache mémoire
  await worker.fetch(req("/api/state", { cookie }), ENV);
  assert.equal(cognitoCalls(), 1);
});

test("jeton expiré côté serveur : reconnexion automatique", async () => {
  const cookie = await loginCookie();
  await worker.fetch(req("/api/state", { cookie }), ENV);
  validToken = "jeton-revoque-par-le-serveur";
  const res = await worker.fetch(req("/api/state", { cookie }), ENV);
  assert.equal(res.status, 200);
  assert.equal(cognitoCalls(), 2);
});

test("mauvais mot de passe SmartEK63 : erreur claire", async () => {
  const env = { ...ENV, EK63_PASSWORD: "faux" };
  const cookie = await loginCookie(env);
  const res = await worker.fetch(req("/api/state", { cookie }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Connexion SmartEK63 refusée/);
});

// --- Commandes ------------------------------------------------------------
test("les commandes envoient le bon format au serveur", async () => {
  const cookie = await loginCookie();
  const cases = [
    ["power", true, "status", { status: "on" }],
    ["temperature", 21, "temperature", { temperature: 21 }],
    ["powerLevel", 1, "power", { power: 1 }],
    ["powerLevel", 5, "power", { power: 5 }],
    ["fan1", 3, "fan", { fan: 1, power: 3 }],
    ["fan1", 1, "fan", { fan: 1, power: 1 }],
    ["fan2", 0, "fan", { fan: 2, power: 0 }],
    ["fan2", 2, "fan", { fan: 2, power: 2 }],
    ["relax", true, "relax", { relaxMode: true }],
    ["standby", false, "standby", { standbyMode: false }],
    ["mode", "auto", "mode", { mode: "auto" }],
  ];
  for (const [action, value, path, expected] of cases) {
    calls = [];
    const res = await worker.fetch(req("/api/command", { method: "POST", body: { action, value }, cookie, origin: HOST }), ENV);
    assert.equal(res.status, 200, `${action} ${value}`);
    assert.deepEqual(puts(), [{ path, body: expected }]);
  }
});

test("easy timer : date ISO (UTC) dans N minutes, null pour annuler", async () => {
  const cookie = await loginCookie();
  calls = [];
  const t0 = Date.now();
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "timer", value: 90 }, cookie }), ENV);
  assert.equal(res.status, 200);
  const [put] = puts();
  assert.equal(put.path, "timer");
  assert.match(put.body.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const delta = new Date(put.body.date).getTime() - t0;
  assert.ok(Math.abs(delta - 90 * 60000) < 5000, `écart ${delta}`);

  calls = [];
  const cancel = await worker.fetch(req("/api/command", { method: "POST", body: { action: "timer", value: null }, cookie }), ENV);
  assert.equal(cancel.status, 200);
  assert.deepEqual(puts(), [{ path: "timer", body: { date: null } }]);
});

test("remise à l'heure : heure belge au format de l'horloge du poêle", async () => {
  assert.equal(ek63.brusselsLocalIso(new Date("2026-11-18T12:00:00Z")), "2026-11-18T13:00:00.000");
  assert.equal(ek63.brusselsLocalIso(new Date("2026-07-01T12:00:00Z")), "2026-07-01T14:00:00.000");
  const cookie = await loginCookie();
  calls = [];
  const t0 = Date.now();
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "syncClock", value: true }, cookie }), ENV);
  assert.equal(res.status, 200);
  const [put] = puts();
  assert.equal(put.path, "date");
  assert.match(put.body.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000$/);
  const sent = Date.parse(put.body.date + "Z");
  const expected = Date.parse(ek63.brusselsLocalIso(new Date(t0)) + "Z");
  assert.ok(Math.abs(sent - expected) < 5000);
});

test("décalage de l'horloge du poêle", async () => {
  const cookie = await loginCookie();
  const lastUpdate = "2026-11-18T12:00:00.000Z"; // 13:00 en Belgique
  Object.assign(device, { lastUpdate, date: "2026-11-18T13:01:00.000" });
  let s = await (await worker.fetch(req("/api/state", { cookie }), ENV)).json();
  assert.equal(s.clockOffsetMin, 1);
  Object.assign(device, { date: "2016-06-20T01:28:38.000" });
  s = await (await worker.fetch(req("/api/state", { cookie }), ENV)).json();
  assert.ok(s.clockOffsetMin < -5_000_000);
});

test("programmation : une tranche modifiée, tout le reste renvoyé à l'identique", async () => {
  const cookie = await loginCookie();
  const send = async (action, value) => {
    calls = [];
    const res = await worker.fetch(req("/api/command", { method: "POST", body: { action, value }, cookie }), ENV);
    assert.equal(res.status, 200, `${action} ${JSON.stringify(value)}`);
    const [put] = puts();
    assert.equal(put.path, "scheduling");
    return put.body;
  };

  let body = await send("scheduleSlot", { slot: 7, startTime: 64800, endTime: 79200, days: ["SUN", "SAT"] });
  assert.deepEqual(Object.keys(body), ["active", "slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "slot7", "slot8"]);
  assert.deepEqual(body.slot7, { startTime: 64800, endTime: 79200, days: ["SAT", "SUN"] });
  assert.deepEqual(body.slot1, device.scheduling.slot1);
  assert.equal(body.slot8, null);
  assert.equal(body.active, false);

  body = await send("scheduleSlot", { slot: 1, clear: true });
  assert.deepEqual(body.slot1, { startTime: 0, endTime: 0, days: [] });

  body = await send("scheduleActive", true);
  assert.equal(body.active, true);
  assert.deepEqual(body.slot1, device.scheduling.slot1);

  body = await send("scheduleSlot", { slot: 2, startTime: 0, endTime: 86400, days: ["MON"] });
  assert.deepEqual(body.slot2, { startTime: 0, endTime: 86400, days: ["MON"] });
});

test("programmation refusée une fois par le poêle : nouvelle tentative réussie", async () => {
  const cookie = await loginCookie();
  let n = 0;
  putHook = () => (++n === 1 ? refused() : new Response(null, { status: 204 }));
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "scheduleActive", value: true }, cookie }), ENV);
  assert.equal(res.status, 200);
  assert.equal(puts().length, 2);
});

test("programmation refusée mais appliquée quand même : succès sans renvoi", async () => {
  const cookie = await loginCookie();
  putHook = (url, body) => { device.scheduling = body; return refused(); };
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "scheduleSlot", value: { slot: 3, startTime: 3600, endTime: 7200, days: ["MON"] } }, cookie }), ENV);
  assert.equal(res.status, 200);
  assert.equal(puts().length, 1);
});

test("programmation toujours refusée : message clair après trois essais", async () => {
  const cookie = await loginCookie();
  putHook = () => refused();
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "scheduleActive", value: true }, cookie }), ENV);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /refusé la programmation/);
  assert.equal(puts().length, 3);
});

test("autre commande refusée par le poêle : message clair, pas de nouvelle tentative", async () => {
  const cookie = await loginCookie();
  putHook = () => refused();
  const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "fan1", value: 2 }, cookie }), ENV);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Le poêle a refusé la commande/);
  assert.equal(puts().length, 1);
});

test("programmation : valeurs invalides refusées sans rien envoyer", async () => {
  const cookie = await loginCookie();
  const bad = [
    ["scheduleSlot", { slot: 9, startTime: 0, endTime: 1800, days: ["MON"] }],
    ["scheduleSlot", { slot: 1, startTime: 3600, endTime: 3600, days: ["MON"] }],
    ["scheduleSlot", { slot: 1, startTime: 7200, endTime: 3600, days: ["MON"] }],
    ["scheduleSlot", { slot: 1, startTime: 900, endTime: 3600, days: ["MON"] }],
    ["scheduleSlot", { slot: 1, startTime: 0, endTime: 90000, days: ["MON"] }],
    ["scheduleSlot", { slot: 1, startTime: 0, endTime: 3600, days: [] }],
    ["scheduleSlot", { slot: 1, startTime: 0, endTime: 3600, days: ["LUN"] }],
    ["scheduleSlot", { slot: 1, startTime: 0, endTime: 3600, days: ["MON", "MON"] }],
    ["scheduleSlot", "slot1"],
    ["scheduleActive", "oui"],
  ];
  for (const [action, value] of bad) {
    calls = [];
    const res = await worker.fetch(req("/api/command", { method: "POST", body: { action, value }, cookie }), ENV);
    assert.equal(res.status, 400, `${action} ${JSON.stringify(value)}`);
    assert.equal(calls.length, 0);
  }
});

test("marche/arrêt refusé pendant allumage, extinction et nettoyage", async () => {
  const cookie = await loginCookie();
  for (const [code, desc] of [[41, "Raffreddamento"], [2, "Accensione"], [7, "Pulizia finale"], [3, "Spegnimento"]]) {
    setDevice(code, desc);
    calls = [];
    const res = await worker.fetch(req("/api/command", { method: "POST", body: { action: "power", value: false }, cookie }), ENV);
    assert.equal(res.status, 409, desc);
    assert.equal(puts().length, 0);
  }
  setDevice(5, "Lavoro");
  const ok = await worker.fetch(req("/api/command", { method: "POST", body: { action: "power", value: false }, cookie }), ENV);
  assert.equal(ok.status, 200);
});

test("les valeurs invalides sont refusées sans rien envoyer au poêle", async () => {
  const cookie = await loginCookie();
  const bad = [
    ["temperature", 50], ["temperature", 21.5], ["temperature", "22"],
    ["fan1", 0], ["fan1", 4], ["fan2", 4], ["fan2", -1], ["fan2", 2.5], ["fan", 2],
    ["power", "on"], ["mode", "turbo"], ["inconnue", 1],
    ["powerLevel", 0], ["powerLevel", 6], ["powerLevel", 2.5], ["powerLevel", "3"],
    ["timer", 45], ["timer", 0], ["timer", 750], ["timer", "60"], ["timer", 15], ["timer", undefined],
  ];
  for (const [action, value] of bad) {
    calls = [];
    const res = await worker.fetch(req("/api/command", { method: "POST", body: { action, value }, cookie }), ENV);
    assert.equal(res.status, 400, `${action} ${value}`);
    assert.equal(puts().length, 0);
  }
});

// --- États ----------------------------------------------------------------
test("traduction et phase des états italiens", () => {
  const cases = [
    ["Stufa spenta", "Éteint", "off"],
    ["Spento", "Éteint", "off"],
    ["Raffreddamento", "Refroidissement", "shutdown"],
    ["Spegnimento", "Extinction en cours", "shutdown"],
    ["Accensione", "Allumage", "ignition"],
    ["Riaccensione", "Rallumage", "ignition"],
    ["Pulizia finale", "Nettoyage final", "cleaning"],
    ["Lavoro", "En marche", "running"],
    ["Stufa accesa", "Allumé", "running"],
    ["Potenza 1", "En marche · puissance 1", "running"],
    ["Potenza 5", "En marche · puissance 5", "running"],
    ["Allarme", "Alarme", "alarm"],
  ];
  for (const [it, fr, phase] of cases) assert.deepEqual(describeStatus(0, it), { fr, phase }, it);
  assert.equal(translateStatus("Qualcosa"), "Qualcosa");
  // état inconnu : on se rabat sur les codes "allumé" de l'intégration Homey
  assert.equal(describeStatus(4, "Qualcosa").phase, "running");
  assert.equal(describeStatus(99, "Qualcosa").phase, "unknown");
});

test("les états rencontrés sont retenus et listés", async () => {
  ENV.KV = makeKV();
  const cookie = await loginCookie();
  setDevice(41, "Raffreddamento");
  await worker.fetch(req("/api/state", { cookie }), ENV);
  setDevice(0, "Stufa spenta");
  await worker.fetch(req("/api/state", { cookie }), ENV);
  await worker.fetch(req("/api/state", { cookie }), ENV);
  const s = await (await worker.fetch(req("/api/settings", { cookie }), ENV)).json();
  assert.deepEqual(s.statuses.map((x) => [x.code, x.description, x.fr]), [[0, "Stufa spenta", "Éteint"], [41, "Raffreddamento", "Refroidissement"]]);
});

// --- Réglages -------------------------------------------------------------
test("réglages : lecture par défaut, validation et enregistrement", async () => {
  ENV.KV = makeKV();
  const cookie = await loginCookie();
  let s = await (await worker.fetch(req("/api/settings", { cookie }), ENV)).json();
  assert.deepEqual(s.auxEvening, { enabled: false, time: "20:00", level: 2 });
  assert.equal(s.storage, true);

  for (const bad of [{ enabled: "oui", time: "20:00", level: 2 }, { enabled: true, time: "25:00", level: 2 }, { enabled: true, time: "20:00", level: 0 }]) {
    const res = await worker.fetch(req("/api/settings", { method: "POST", body: { auxEvening: bad }, cookie }), ENV);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const res = await worker.fetch(req("/api/settings", { method: "POST", body: { auxEvening: { enabled: true, time: "21:30", level: 3 } }, cookie }), ENV);
  assert.equal(res.status, 200);
  s = await (await worker.fetch(req("/api/settings", { cookie }), ENV)).json();
  assert.deepEqual(s.auxEvening, { enabled: true, time: "21:30", level: 3 });
});

test("réglages sans stockage : erreur claire", async () => {
  const cookie = await loginCookie();
  const res = await worker.fetch(req("/api/settings", { method: "POST", body: { auxEvening: { enabled: true, time: "20:00", level: 2 } }, cookie }), ENV);
  assert.equal(res.status, 503);
});

// --- Automatisme : auxiliaire du soir -------------------------------------
test("heure belge (hiver UTC+1, été UTC+2)", () => {
  assert.deepEqual(localTime(new Date("2026-11-17T19:30:00Z")), { day: "2026-11-17", minutes: 20 * 60 + 30 });
  assert.deepEqual(localTime(new Date("2026-07-01T18:00:00Z")), { day: "2026-07-01", minutes: 20 * 60 });
  assert.deepEqual(localTime(new Date("2026-11-17T23:30:00Z")), { day: "2026-11-18", minutes: 30 });
});

test("automatisme désactivé : le poêle n'est même pas interrogé", async () => {
  ENV.KV = makeKV();
  const r = await runAutomation(ENV, ek63, new Date("2026-11-17T20:00:00Z"));
  assert.equal(r.action, "none");
  assert.equal(calls.length, 0);
});

test("automatisme : soirée complète", async () => {
  ENV.KV = makeKV();
  await ENV.KV.put("settings", JSON.stringify({ auxEvening: { enabled: true, time: "20:00", level: 2 } }));
  const at = (iso) => runAutomation(ENV, ek63, new Date(iso));

  // 19:55 (heure belge) : trop tôt, aucun appel
  assert.equal((await at("2026-11-17T18:55:00Z")).action, "none");
  assert.equal(calls.length, 0);

  // 20:05 mais poêle éteint : on attend, sans commande
  setDevice(0, "Stufa spenta");
  assert.equal((await at("2026-11-17T19:05:00Z")).action, "waiting-running");
  assert.equal(puts().length, 0);

  // 20:30 : poêle allumé par l'utilisateur, encore en allumage
  setDevice(2, "Accensione");
  assert.equal((await at("2026-11-17T19:30:00Z")).action, "waiting-running");

  // 20:45 : en marche -> auxiliaire à 2
  setDevice(5, "Lavoro");
  calls = [];
  assert.equal((await at("2026-11-17T19:45:00Z")).action, "boost");
  assert.deepEqual(puts(), [{ path: "fan", body: { fan: 2, power: 2 } }]);

  // 21:00 : toujours en marche -> rien de plus
  calls = [];
  assert.equal((await at("2026-11-17T20:00:00Z")).action, "waiting-shutdown");
  assert.equal(puts().length, 0);

  // 23:10 : extinction -> auxiliaire à l'arrêt
  setDevice(41, "Raffreddamento");
  calls = [];
  assert.equal((await at("2026-11-17T22:10:00Z")).action, "reset");
  assert.deepEqual(puts(), [{ path: "fan", body: { fan: 2, power: 0 } }]);

  // 23:30 : rallumé le même soir -> pas de second passage
  setDevice(5, "Lavoro");
  calls = [];
  assert.equal((await at("2026-11-17T22:30:00Z")).action, "none");
  assert.equal(calls.length, 0);

  // lendemain 20:10 en marche -> nouveau passage
  calls = [];
  assert.equal((await at("2026-11-18T19:10:00Z")).action, "boost");
});

test("automatisme : désactivé après le passage, l'arrêt à l'extinction a quand même lieu", async () => {
  ENV.KV = makeKV();
  await ENV.KV.put("settings", JSON.stringify({ auxEvening: { enabled: true, time: "20:00", level: 2 } }));
  setDevice(5, "Lavoro");
  assert.equal((await runAutomation(ENV, ek63, new Date("2026-11-17T19:10:00Z"))).action, "boost");
  await ENV.KV.put("settings", JSON.stringify({ auxEvening: { enabled: false, time: "20:00", level: 2 } }));
  setDevice(0, "Stufa spenta");
  calls = [];
  assert.equal((await runAutomation(ENV, ek63, new Date("2026-11-17T21:10:00Z"))).action, "reset");
  assert.deepEqual(puts(), [{ path: "fan", body: { fan: 2, power: 0 } }]);
});

test("automatisme : poêle hors ligne, aucune commande", async () => {
  ENV.KV = makeKV();
  await ENV.KV.put("settings", JSON.stringify({ auxEvening: { enabled: true, time: "20:00", level: 2 } }));
  setDevice(5, "Lavoro");
  device.online = false;
  assert.equal((await runAutomation(ENV, ek63, new Date("2026-11-17T19:10:00Z"))).action, "offline");
  assert.equal(puts().length, 0);
});

test("la tâche programmée lance l'automatisme", async () => {
  ENV.KV = makeKV();
  await ENV.KV.put("settings", JSON.stringify({ auxEvening: { enabled: true, time: "00:00", level: 1 } }));
  setDevice(5, "Lavoro");
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now() }, ENV, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.deepEqual(puts(), [{ path: "fan", body: { fan: 2, power: 1 } }]);
});

// --- Historique des températures -----------------------------------------
test("relevé : seulement aux quarts d'heure", () => {
  assert.equal(isSampleTick(new Date("2026-11-18T14:00:00Z")), true);
  assert.equal(isSampleTick(new Date("2026-11-18T14:15:00Z")), true);
  assert.equal(isSampleTick(new Date("2026-11-18T14:05:00Z")), false);
  assert.equal(isSampleTick(new Date("2026-11-18T14:10:00Z")), false);
});

test("relevé : enregistré par jour belge, sans doublon, ignoré hors ligne", async () => {
  ENV.KV = makeKV();
  setDevice(5, "Lavoro");
  Object.assign(device, { roomTemperature: 21.46, temperature: 22, power: 3 });
  assert.equal((await recordSample(ENV, ek63, new Date("2026-11-18T22:45:00Z"))).action, "recorded"); // 23:45 à Bruxelles
  assert.equal((await recordSample(ENV, ek63, new Date("2026-11-18T22:50:00Z"))).action, "duplicate");
  assert.equal((await recordSample(ENV, ek63, new Date("2026-11-18T23:00:00Z"))).action, "recorded"); // minuit : jour suivant
  setDevice(0, "Stufa spenta");
  device.online = false;
  assert.equal((await recordSample(ENV, ek63, new Date("2026-11-18T23:15:00Z"))).action, "skip");

  const day1 = await ENV.KV.get("hist:2026-11-18", "json");
  const day2 = await ENV.KV.get("hist:2026-11-19", "json");
  assert.deepEqual(day1, [[Date.parse("2026-11-18T22:45:00Z") / 1000, 21.5, 22, 1, 3]]);
  assert.equal(day2.length, 1);
});

test("historique : 7 jours lus d'un coup, période validée", async () => {
  ENV.KV = makeKV();
  await ENV.KV.put("hist:2026-11-18", JSON.stringify([[1795000000, 20.1, 21, 0, 1]]));
  const cookie = await loginCookie();
  const res = await worker.fetch(req("/api/history?end=2026-11-18&days=7", { cookie }), ENV);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.deepEqual(h.days.map((d) => d.date), dayRange("2026-11-18", 7));
  assert.equal(h.days[0].date, "2026-11-12");
  assert.equal(h.days[6].samples.length, 1);
  assert.equal(h.sampleEveryMin, 15);
  for (const bad of ["end=18-11-2026", "days=0", "days=30", "end=2026-13-45"]) {
    assert.equal((await worker.fetch(req(`/api/history?${bad}`, { cookie }), ENV)).status, 400, bad);
  }
  assert.equal((await worker.fetch(req("/api/history"), ENV)).status, 401);
});

test("dates sur 7 jours, y compris au changement d'heure", () => {
  assert.deepEqual(dayRange("2027-03-31", 3), ["2027-03-29", "2027-03-30", "2027-03-31"]);
  assert.deepEqual(dayRange("2026-10-26", 2), ["2026-10-25", "2026-10-26"]);
});

test("commune : enregistrée arrondie, sans écraser l'auxiliaire du soir", async () => {
  ENV.KV = makeKV();
  const cookie = await loginCookie();
  await worker.fetch(req("/api/settings", { method: "POST", body: { auxEvening: { enabled: true, time: "21:00", level: 2 } }, cookie }), ENV);
  const res = await worker.fetch(req("/api/settings", { method: "POST", body: { location: { name: "Namur", region: "Wallonie, Belgique", latitude: 50.46694, longitude: 4.86746 } }, cookie }), ENV);
  assert.equal(res.status, 200);
  const s = await (await worker.fetch(req("/api/settings", { cookie }), ENV)).json();
  assert.deepEqual(s.location, { name: "Namur", region: "Wallonie, Belgique", latitude: 50.47, longitude: 4.87 });
  assert.equal(s.auxEvening.time, "21:00");
  for (const bad of [{ name: "", latitude: 1, longitude: 1 }, { name: "X", latitude: 95, longitude: 1 }, { name: "X", latitude: "50", longitude: 4 }]) {
    const r = await worker.fetch(req("/api/settings", { method: "POST", body: { location: bad }, cookie }), ENV);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

// --- Démo -----------------------------------------------------------------
test("mode démo : allumage simulé, bouton bloqué pendant l'allumage", async () => {
  const env = { ACCESS_CODE: BASE_ENV.ACCESS_CODE, DEMO: "1" };
  const cookie = await loginCookie(env);
  const on = await worker.fetch(req("/api/command", { method: "POST", body: { action: "power", value: true }, cookie }), env);
  assert.equal(on.status, 200);
  const s = await (await worker.fetch(req("/api/state", { cookie }), env)).json();
  assert.equal(s.phase, "ignition");
  const again = await worker.fetch(req("/api/command", { method: "POST", body: { action: "power", value: false }, cookie }), env);
  assert.equal(again.status, 409);
  assert.equal(calls.length, 0);
});
