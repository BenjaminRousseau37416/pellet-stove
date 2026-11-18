// Worker Cloudflare : petite API protégée par un code d'accès, qui relaie vers le cloud SmartEK63.
// Les fichiers de public/ (l'interface) sont servis directement par Cloudflare.

import * as ek63 from "./ek63.js";
import * as demo from "./demo.js";
import * as store from "./store.js";
import { runAutomation } from "./automation.js";
import { isSampleTick, recordSample, readHistory, demoHistory, brusselsDay, SAMPLE_EVERY_MIN } from "./history.js";

const COOKIE = "poele_session";
const SESSION_DAYS = 365;
const MIN_CODE_LENGTH = 12;

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// La clé de signature dérive du code d'accès : changer le code déconnecte tous les appareils.
async function key(env) {
  return crypto.subtle.importKey("raw", enc.encode("poele-v1:" + env.ACCESS_CODE), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function codeIsValid(env, submitted) {
  if (typeof submitted !== "string") return false;
  const k = await key(env);
  const expected = await crypto.subtle.sign("HMAC", k, enc.encode("code:" + env.ACCESS_CODE));
  // verify() compare en temps constant.
  return crypto.subtle.verify("HMAC", k, expected, enc.encode("code:" + submitted));
}

async function makeSession(env) {
  const issued = String(Date.now());
  const sig = await crypto.subtle.sign("HMAC", await key(env), enc.encode("session:" + issued));
  return `${issued}.${b64url(sig)}`;
}

async function sessionIsValid(env, request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([A-Za-z0-9_-]+)`));
  if (!m) return false;
  const issued = Number(m[1]);
  if (!(Date.now() - issued < SESSION_DAYS * 86400 * 1000)) return false;
  try {
    return await crypto.subtle.verify("HMAC", await key(env), fromB64url(m[2]), enc.encode("session:" + m[1]));
  } catch {
    return false;
  }
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return null;
  return request.json().catch(() => null);
}

// Lance une tâche après la réponse si possible (Workers), sinon l'attend (tests).
async function background(ctx, promise) {
  const safe = promise.catch((e) => console.error(`Tâche de fond : ${e.message || e}`));
  if (ctx && ctx.waitUntil) ctx.waitUntil(safe);
  else await safe;
}

export default {
  // Tâche programmée (toutes les 5 minutes, voir wrangler.jsonc).
  async scheduled(controller, env, ctx) {
    const backend = env.DEMO === "1" ? demo : ek63;
    const now = new Date(controller.scheduledTime || Date.now());
    ctx.waitUntil(runAutomation(env, backend, now).catch((e) => console.error(`Automatisme : ${e.message || e}`)));
    // Relevé de température toutes les 15 minutes (pas en démo : l'historique y est fictif).
    if (isSampleTick(now) && env.DEMO !== "1") {
      ctx.waitUntil(recordSample(env, backend, now).catch((e) => console.error(`Relevé : ${e.message || e}`)));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json({ error: "Introuvable." }, 404);

    if (!env.ACCESS_CODE || env.ACCESS_CODE.length < MIN_CODE_LENGTH) {
      return json({ error: `Le code d'accès (secret ACCESS_CODE) doit faire au moins ${MIN_CODE_LENGTH} caractères.` }, 500);
    }

    // Protection contre les requêtes envoyées depuis un autre site.
    if (request.method !== "GET") {
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return json({ error: "Origine refusée." }, 403);
    }

    const backend = env.DEMO === "1" ? demo : ek63;

    try {
      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || !(await codeIsValid(env, body.code))) {
          await sleep(1000); // ralentit les essais au hasard
          return json({ error: "Code incorrect." }, 401);
        }
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
      }

      if (!(await sessionIsValid(env, request))) return json({ error: "Code d'accès requis." }, 401);

      if (url.pathname === "/api/state" && request.method === "GET") {
        const state = await backend.getState(env);
        await background(ctx, store.recordStatus(env, state));
        return json(state);
      }

      if (url.pathname === "/api/settings" && request.method === "GET") {
        return json({
          storage: !!env.KV,
          ...(await store.getSettings(env)),
          runtime: await store.getRuntime(env),
          statuses: await store.listStatuses(env),
        });
      }

      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || (body.auxEvening === undefined && body.location === undefined)) {
          return json({ error: "Requête invalide." }, 400);
        }
        const next = await store.getSettings(env);
        if (body.auxEvening !== undefined) next.auxEvening = store.validateAuxEvening(body.auxEvening);
        if (body.location !== undefined) next.location = store.validateLocation(body.location);
        await store.saveSettings(env, next);
        // Effet immédiat si l'heure est déjà passée et que le poêle est en marche.
        if (body.auxEvening !== undefined) await background(ctx, runAutomation(env, backend));
        return json({ ok: true, ...next });
      }

      if (url.pathname === "/api/history" && request.method === "GET") {
        const today = brusselsDay(new Date());
        const end = url.searchParams.get("end") || today;
        const days = Number(url.searchParams.get("days") || 7);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || Number.isNaN(Date.parse(end)) || !Number.isInteger(days) || days < 1 || days > 14) {
          return json({ error: "Période invalide." }, 400);
        }
        const list = env.DEMO === "1" ? demoHistory(end, days) : await readHistory(env, end, days);
        return json({ today, end, sampleEveryMin: SAMPLE_EVERY_MIN, days: list });
      }

      if (url.pathname === "/api/command" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || typeof body.action !== "string") return json({ error: "Requête invalide." }, 400);
        const result = await backend.sendCommand(env, body.action, body.value);
        return json({ ok: true, result });
      }

      return json({ error: "Introuvable." }, 404);
    } catch (e) {
      const status = e instanceof ek63.Ek63Error ? e.status : 500;
      console.error(`Erreur ${status} sur ${url.pathname} : ${e.message || e}`);
      return json({ error: e.message || String(e) }, status);
    }
  },
};
