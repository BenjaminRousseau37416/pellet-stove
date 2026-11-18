// Client du cloud SmartEK63 (Edilkamin, marque EK63).
// Serveur et identifiants Cognito repris de https://github.com/smarthomesven/homey-smartek63

const COGNITO_URL = "https://cognito-idp.eu-central-1.amazonaws.com/";
const CLIENT_ID = "751nsgtv5okg7u05mneacrn480";
export const API_URL = "https://8wmnu4exgg.execute-api.eu-central-1.amazonaws.com/prod";

// Codes d'état considérés comme "allumé" par l'intégration Homey (utilisés en dernier recours).
const ON_STATUSES = new Set([1, 4, 5, 10, 11]);

// Le serveur décrit l'état en italien. Chaque règle donne la traduction et la phase du poêle.
// L'ordre compte : la première règle qui correspond gagne.
// Confirmés sur le poêle : "Stufa spenta" (0), "Potenza 1" (11), "Raffreddamento" (41).
// Les autres sont déduits du vocabulaire Edilkamin. La traduction peut être une fonction du résultat de la regex.
const RULES = [
  [/potenza\s*(\d+)/i, (m) => `En marche · puissance ${m[1]}`, "running"],
  [/allarme/i, "Alarme", "alarm"],
  [/errore|blocco/i, "Erreur", "alarm"],
  [/pulizia finale/i, "Nettoyage final", "cleaning"],
  [/pulizia/i, "Nettoyage", "cleaning"],
  [/spegnimento/i, "Extinction en cours", "shutdown"],
  [/raffreddamento/i, "Refroidissement", "shutdown"],
  [/spent[oa]/i, "Éteint", "off"],
  [/riaccensione/i, "Rallumage", "ignition"],
  [/accensione/i, "Allumage", "ignition"],
  [/preriscald/i, "Préchauffage", "ignition"],
  [/caricamento/i, "Chargement des pellets", "ignition"],
  [/stand-?by|attesa/i, "Veille", "standby"],
  [/modulazione/i, "Modulation", "running"],
  [/fiamma/i, "Flamme présente", "running"],
  [/lavoro|funzionamento/i, "En marche", "running"],
  [/\bacces[oa]\b/i, "Allumé", "running"],
];

export function describeStatus(code, description) {
  for (const [re, fr, phase] of RULES) {
    const m = description && description.match(re);
    if (m) return { fr: typeof fr === "function" ? fr(m) : fr, phase };
  }
  return { fr: description || "", phase: ON_STATUSES.has(code) ? "running" : "unknown" };
}

export function translateStatus(description) {
  return describeStatus(undefined, description).fr;
}

// Phases pendant lesquelles on n'envoie pas de commande marche/arrêt.
export const TRANSITION_PHASES = new Set(["ignition", "shutdown", "cleaning"]);

export class Ek63Error extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Cache en mémoire (une instance de Worker sert souvent plusieurs requêtes),
// doublé d'un cache dans le stockage KV pour les tâches programmées.
let cachedToken = null; // { value, expiresAt }
let cachedHeaterId = null;

export function resetCache() {
  cachedToken = null;
  cachedHeaterId = null;
}

async function login(env) {
  if (!env.EK63_EMAIL || !env.EK63_PASSWORD) {
    throw new Ek63Error("Identifiants SmartEK63 non configurés (secrets EK63_EMAIL et EK63_PASSWORD).", 500);
  }
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: env.EK63_EMAIL, PASSWORD: env.EK63_PASSWORD },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Ek63Error(`Connexion SmartEK63 refusée : ${data.message || res.status}`, 502);
  }
  if (data.ChallengeName) {
    throw new Ek63Error(`Le compte SmartEK63 demande une étape supplémentaire (${data.ChallengeName}).`, 502);
  }
  const auth = data.AuthenticationResult;
  cachedToken = {
    value: auth.IdToken,
    // On renouvelle une minute avant l'expiration.
    expiresAt: Date.now() + (auth.ExpiresIn - 60) * 1000,
  };
  if (env.KV) {
    const ttl = Math.max(60, Math.floor((cachedToken.expiresAt - Date.now()) / 1000));
    await env.KV.put("token", JSON.stringify(cachedToken), { expirationTtl: ttl });
  }
  return cachedToken.value;
}

async function getToken(env, force = false) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  if (!force && env.KV) {
    const stored = await env.KV.get("token", "json");
    if (stored && Date.now() < stored.expiresAt) {
      cachedToken = stored;
      return stored.value;
    }
  }
  return login(env);
}

async function call(env, method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, attempt > 0);
    const res = await fetch(API_URL + path, {
      method,
      headers: {
        Authorization: token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) continue; // jeton expiré : on se reconnecte une fois
    const text = await res.text();
    if (method !== "GET") {
      // Journal des commandes (visible avec « wrangler tail ») : jamais de jeton ni de mot de passe.
      console.log(JSON.stringify({ commande: path, envoye: body, statut: res.status, reponse: text.slice(0, 300) }));
    }
    if (!res.ok) {
      let code = null;
      try { code = JSON.parse(text).code || null; } catch {}
      if ((res.status === 409 && code === "HEATER_COMMAND") || (res.status === 408 && code === "HEATER_TIMEOUT")) {
        // Le serveur a transmis la commande, mais le poêle l'a refusée (409) ou n'a pas répondu à temps (408).
        // Dans les deux cas, il arrive qu'elle ait quand même été appliquée : voir sendCommand.
        const e = new Ek63Error(
          res.status === 408
            ? "Le poêle n'a pas confirmé à temps. Réessaie dans quelques secondes."
            : "Le poêle a refusé la commande : il était peut-être occupé. Réessaie dans quelques secondes.",
          res.status
        );
        e.heaterRefused = true;
        throw e;
      }
      throw new Ek63Error(`Le serveur SmartEK63 a répondu ${res.status} : ${text.slice(0, 200)}`, 502);
    }
    return text ? JSON.parse(text) : {};
  }
}

async function getHeaterId(env) {
  if (env.HEATER_ID) return env.HEATER_ID;
  if (cachedHeaterId) return cachedHeaterId;
  const heaters = await call(env, "GET", "/heaters");
  if (!Array.isArray(heaters) || heaters.length === 0) {
    throw new Ek63Error("Aucun poêle n'est lié à ce compte SmartEK63.", 404);
  }
  cachedHeaterId = heaters[0].id;
  return cachedHeaterId;
}

// Heure locale belge au format de l'horloge du poêle : "2026-11-18T15:04:05.000" (sans fuseau).
export function brusselsLocalIso(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Brussels",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000`;
}

// Décalage de l'horloge du poêle (minutes), mesuré au moment de la dernière mise à jour de l'état.
function clockOffsetMinutes(d) {
  if (typeof d.date !== "string") return null;
  const reference = d.lastUpdate ? new Date(d.lastUpdate) : new Date();
  const stove = Date.parse(d.date.replace(/Z$/, "") + "Z");
  const real = Date.parse(brusselsLocalIso(reference) + "Z");
  return Number.isNaN(stove) ? null : Math.round((stove - real) / 60000);
}

export function enrichState(d) {
  const { fr, phase } = describeStatus(d.status, d.statusDescription);
  return { ...d, phase, statusFr: fr, isOn: phase === "running" || phase === "standby", clockOffsetMin: clockOffsetMinutes(d) };
}

export async function getState(env) {
  const id = await getHeaterId(env);
  return enrichState(await call(env, "GET", `/heaters/${encodeURIComponent(id)}`));
}

const MIN_TIMER = 30;
const MAX_TIMER = 12 * 60;

// Le serveur attend { fan: numéro du ventilateur, power: vitesse } (vitesse 6 au maximum côté serveur).
function fanCommand(index, min, max) {
  return (v) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Ek63Error(`Ventilateur ${index} : vitesse entière entre ${min} et ${max}.`, 400);
    }
    return ["fan", { fan: index, power: v }];
  };
}

// Commandes autorisées : action -> (valeur validée) -> [chemin, corps].
export const COMMANDS = {
  power: (v) => {
    if (typeof v !== "boolean") throw new Ek63Error("power attend true ou false.", 400);
    return ["status", { status: v ? "on" : "off" }];
  },
  temperature: (v) => {
    // Le poêle ignore les demi-degrés : entiers uniquement.
    if (!Number.isInteger(v) || v < 10 || v > 35) {
      throw new Ek63Error("temperature attend un nombre entier entre 10 et 35.", 400);
    }
    return ["temperature", { temperature: v }];
  },
  // Puissance de chauffe (mode manuel) : 1 à 5. Le serveur la renvoie dans `power`.
  // Format supposé d'après l'état ({ power: N }) ; en cas d'écart, le serveur renvoie un 400 qui l'explique.
  powerLevel: (v) => {
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new Ek63Error("La puissance va de 1 à 5.", 400);
    return ["power", { power: v }];
  },
  // Ventilateur principal : 1 à 3. Ventilateur auxiliaire (vers la chambre) : 0 à 3.
  fan1: fanCommand(1, 1, 3),
  fan2: fanCommand(2, 0, 3),
  relax: (v) => {
    if (typeof v !== "boolean") throw new Ek63Error("relax attend true ou false.", 400);
    return ["relax", { relaxMode: v }];
  },
  standby: (v) => {
    if (typeof v !== "boolean") throw new Ek63Error("standby attend true ou false.", 400);
    return ["standby", { standbyMode: v }];
  },
  mode: (v) => {
    if (v !== "auto" && v !== "manual") throw new Ek63Error("mode attend auto ou manual.", 400);
    return ["mode", { mode: v }];
  },
  // Remise à l'heure de l'horloge du poêle, à l'heure belge, au même format que celui qu'il renvoie.
  // Format supposé : en cas d'écart, le serveur répond 400 en expliquant ce qu'il attend.
  syncClock: () => ["date", { date: brusselsLocalIso(new Date()) }],
  // Easy timer : inverse l'état du poêle (allumé ⇄ éteint) après `v` minutes ; null annule.
  // Le serveur attend la date de déclenchement (ISO, UTC) et renvoie la même dans `easyTimerDate`.
  // Comme l'app officielle : par demi-heures uniquement (ici de 30 min à 12 h).
  timer: (v) => {
    if (v === null) return ["timer", { date: null }];
    if (!Number.isInteger(v) || v < MIN_TIMER || v > MAX_TIMER || v % 30 !== 0) {
      throw new Ek63Error("L'easy timer se règle par demi-heures, de 30 min à 12 h.", 400);
    }
    return ["timer", { date: new Date(Date.now() + v * 60000).toISOString() }];
  },
};

// --- Programmation hebdomadaire ---------------------------------------------
// Le serveur stocke { active, slot1..slot8 } ; une tranche = { startTime, endTime, days } avec des heures
// en secondes depuis minuit (heure belge), par demi-heures, ou { 0, 0, [] } si vide, ou null (jamais réglée).
// Il exige les 9 champs à chaque envoi : on part toujours de l'état actuel et on ne change que le nécessaire.
export const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SLOT_KEYS = ["slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "slot7", "slot8"];
export const SCHEDULE_ACTIONS = new Set(["scheduleActive", "scheduleSlot"]);

function validateSlot(v) {
  const okTime = (t) => Number.isInteger(t) && t >= 0 && t <= 86400 && t % 1800 === 0;
  if (!okTime(v.startTime) || !okTime(v.endTime)) {
    throw new Ek63Error("Les heures vont par demi-heures, de 00:00 à 24:00.", 400);
  }
  if (v.startTime >= v.endTime) throw new Ek63Error("L'heure de fin doit être après l'heure de début.", 400);
  const days = v.days;
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !DAYS.includes(d)) || new Set(days).size !== days.length) {
    throw new Ek63Error("Choisis au moins un jour.", 400);
  }
  return { startTime: v.startTime, endTime: v.endTime, days: DAYS.filter((d) => days.includes(d)) };
}

export function applyScheduleChange(current, action, value) {
  const base = current || {};
  const next = { active: base.active === true };
  for (const k of SLOT_KEYS) next[k] = base[k] === undefined ? null : base[k];
  if (action === "scheduleActive") {
    if (typeof value !== "boolean") throw new Ek63Error("La programmation s'active avec true ou false.", 400);
    next.active = value;
  } else if (action === "scheduleSlot") {
    if (!value || typeof value !== "object" || !Number.isInteger(value.slot) || value.slot < 1 || value.slot > 8) {
      throw new Ek63Error("Tranche invalide (1 à 8).", 400);
    }
    next[`slot${value.slot}`] = value.clear === true ? { startTime: 0, endTime: 0, days: [] } : validateSlot(value);
  } else {
    throw new Ek63Error(`Commande inconnue : ${action}`, 400);
  }
  return next;
}

// Compare deux programmations en considérant null et { 0, 0, [] } comme une même tranche vide.
function sameSchedule(a, b) {
  const norm = (sc) => {
    const s = sc || {};
    return JSON.stringify([s.active === true, ...SLOT_KEYS.map((k) => {
      const sl = s[k];
      if (!sl || !Array.isArray(sl.days) || sl.days.length === 0) return "vide";
      return [sl.startTime, sl.endTime, DAYS.filter((d) => sl.days.includes(d))];
    })]);
  };
  return norm(a) === norm(b);
}

// Délais avant de revérifier puis de réessayer quand le poêle refuse ou ne confirme pas (modifiables par les tests).
// Commandes simples : court, pour rester sous le délai d'attente de la montre (10 s).
export const timing = { scheduleRetryDelays: [3000, 6000], commandRetryDelays: [2000, 3000] };

// Pour chaque commande : la valeur demandée se retrouve-t-elle dans l'état du poêle ?
const APPLIED = {
  temperature: (s, v) => s.temperature === v,
  powerLevel: (s, v) => s.power === v,
  fan1: (s, v) => s.fan1Power === v,
  fan2: (s, v) => s.fan2Power === v,
  relax: (s, v) => s.relaxMode === v,
  standby: (s, v) => s.standbyMode === v,
  mode: (s, v) => s.mode === v,
  timer: (s, v) => (v === null ? !s.easyTimerDate : !!s.easyTimerDate),
  power: (s, v) => (v ? s.phase === "ignition" || s.phase === "running" : s.phase !== "ignition" && s.phase !== "running"),
};
// Marche/arrêt : on vérifie, mais on ne renvoie jamais la commande d'office.
const NO_RESEND = new Set(["power"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le poêle refuse parfois une programmation (409 HEATER_COMMAND), y compris une commande qu'il accepte
// juste après : on vérifie si elle a quand même été appliquée, sinon on réessaie.
async function sendSchedule(env, action, value) {
  const before = await getState(env);
  const desired = applyScheduleChange(before.scheduling, action, value);
  const id = encodeURIComponent(await getHeaterId(env));
  const put = () => call(env, "PUT", `/heaters/${id}/scheduling`, desired);
  try {
    return await put();
  } catch (e) {
    if (!e.heaterRefused) throw e;
    console.log(JSON.stringify({ programmation_refusee: true, avant: before.scheduling }));
  }
  for (const wait of timing.scheduleRetryDelays) {
    await sleep(wait);
    const now = await getState(env);
    if (sameSchedule(now.scheduling, desired)) {
      console.log("Programmation appliquée malgré le refus annoncé.");
      return {};
    }
    try {
      const r = await put();
      console.log("Programmation acceptée après une nouvelle tentative.");
      return r;
    } catch (e) {
      if (!e.heaterRefused) throw e;
    }
  }
  throw new Ek63Error("Le poêle a refusé la programmation, même après deux nouvelles tentatives. Réessaie dans une minute.", 409);
}

export async function sendCommand(env, action, value) {
  if (SCHEDULE_ACTIONS.has(action)) {
    applyScheduleChange({}, action, value); // valide avant tout appel au serveur
    return sendSchedule(env, action, value);
  }
  const build = COMMANDS[action];
  if (!build) throw new Ek63Error(`Commande inconnue : ${action}`, 400);
  const [path, body] = build(value);
  if (action === "power") {
    // Pas de marche/arrêt pendant un allumage, une extinction ou un nettoyage.
    const s = await getState(env);
    if (TRANSITION_PHASES.has(s.phase)) {
      throw new Ek63Error(`Pas possible pendant « ${s.statusFr} » : attends que le poêle ait fini.`, 409);
    }
  }
  const id = await getHeaterId(env);
  const put = () => call(env, "PUT", `/heaters/${encodeURIComponent(id)}/${path}`, body);
  let lastError;
  try {
    return await put();
  } catch (e) {
    if (!e.heaterRefused || !APPLIED[action]) throw e;
    lastError = e;
  }
  // Le poêle a refusé ou n'a pas confirmé : la commande est peut-être quand même passée.
  const delays = timing.commandRetryDelays;
  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);
    if (APPLIED[action](await getState(env), value)) {
      console.log(`Commande ${action} appliquée malgré l'absence de confirmation du poêle.`);
      return {};
    }
    if (NO_RESEND.has(action) || i === delays.length - 1) continue;
    try {
      const r = await put();
      console.log(`Commande ${action} acceptée après une nouvelle tentative.`);
      return r;
    } catch (e) {
      if (!e.heaterRefused) throw e;
      lastError = e;
    }
  }
  throw lastError;
}
