// Exploration : quelles commandes le serveur SmartEK63 connaît-il, en plus de celles qu'on utilise ?
// But : trouver où se règle la durée de veille.
//
// Étape 1 — sans rien envoyer au poêle : pour chaque nom de commande possible, on demande au serveur
//   quelles méthodes il accepte (requête OPTIONS, la même que celle qu'un navigateur fait avant un appel).
//   Une commande inexistante répond 403 ; une commande existante répond 200 avec ses méthodes.
// Étape 2 — seulement pour les commandes nouvelles dont le nom évoque la veille ou une durée :
//   a) on envoie un champ bidon : si le serveur vérifie le format, il refuse en le disant ;
//   b) uniquement dans ce cas, on envoie un corps vide : le serveur refuse en listant les champs obligatoires.
//   Si le serveur ne vérifie pas le format, on s'arrête là (rien d'autre n'est envoyé).
// Le mot de passe est saisi masqué, jamais affiché ni enregistré.
//
// Lancer : node --use-system-ca tools/explorer-commandes.cjs

const readline = require("readline");

const COGNITO_URL = "https://cognito-idp.eu-central-1.amazonaws.com/";
const CLIENT_ID = "751nsgtv5okg7u05mneacrn480";
const API = "https://8wmnu4exgg.execute-api.eu-central-1.amazonaws.com/prod";

const KNOWN = ["status", "temperature", "fan", "relax", "standby", "mode"];
const CONTROL = "zz-commande-inexistante";
const CANDIDATES = [
  "standby-time", "standbyTime", "standby_time", "standby/time", "standby-timer", "standbyTimer",
  "standby-delay", "standbyDelay", "standby/delay", "standby/settings", "timer", "timers",
  "easytimer", "easy-timer", "easyTimer", "settings", "parameters", "params", "config", "configuration",
  "power", "power-level", "powerLevel", "scheduling", "schedule", "chrono", "cochlea",
  "continuousCochleaMode", "date", "name", "alarms", "info", "details",
];
// Étape 2 seulement pour ces noms : les commandes génériques (settings, parameters…) sont juste signalées,
// car un envoi pourrait y remplacer des réglages.
const RELATED = /stand|time|timer|delay/i;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value.replace(/\x1b\[20[01]~/g, "").replace(/[\x00-\x1f\x7f]/g, ""));
          return;
        } else if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(1);
        } else if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function login(email, password) {
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
    body: JSON.stringify({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: CLIENT_ID, AuthParameters: { USERNAME: email, PASSWORD: password } }),
  });
  const data = await res.json();
  if (!res.ok || !data.AuthenticationResult) throw new Error(`Connexion refusée : ${data.message || res.status}`);
  return data.AuthenticationResult.IdToken;
}

async function options(path) {
  const res = await fetch(API + path, {
    method: "OPTIONS",
    headers: { Origin: "https://d12bttrzid7f09.cloudfront.net", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  await res.text();
  return { status: res.status, methods: res.headers.get("access-control-allow-methods") || "" };
}

async function send(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

async function main() {
  console.log("=== Exploration des commandes SmartEK63 ===\n");
  const email = await ask("E-mail du compte SmartEK63 : ");
  const password = await askHidden("Mot de passe (masqué) : ");
  const token = await login(email, password);
  const heaters = JSON.parse(await (await fetch(API + "/heaters", { headers: { Authorization: token } })).text());
  const base = `/heaters/${encodeURIComponent(heaters[0].id)}`;
  console.log("\nConnecté.\n\nÉtape 1 : commandes existantes (requêtes OPTIONS, rien n'est envoyé au poêle)");

  const show = async (label, path) => {
    const r = await options(path);
    console.log(`  ${label.padEnd(24)} -> ${r.status} ${r.methods}`);
    return r;
  };
  await show("(le poêle lui-même)", base);
  const control = await show(`(témoin) ${CONTROL}`, `${base}/${CONTROL}`);
  for (const k of KNOWN) await show(`(connue) ${k}`, `${base}/${k}`);

  const found = [];
  for (const c of CANDIDATES) {
    const r = await show(c, `${base}/${c}`);
    if (r.status === 200 && r.status !== control.status) found.push({ name: c, methods: r.methods });
  }
  console.log(`\nNouvelles commandes trouvées : ${found.length ? found.map((f) => `${f.name} [${f.methods}]`).join(", ") : "aucune"}`);
  if (control.status === 200) {
    console.log("Le témoin répond aussi 200 : cette méthode ne permet pas de distinguer les commandes. Arrêt.");
    return;
  }

  const toProbe = found.filter((f) => RELATED.test(f.name) && /PUT|PATCH|POST/.test(f.methods));
  if (!toProbe.length) { console.log("\nRien à examiner de plus. Exploration terminée."); return; }

  console.log("\nÉtape 2 : format attendu (requêtes refusées par le serveur si son format est vérifié)");
  for (const f of toProbe) {
    const method = (f.methods.match(/PUT|PATCH|POST/) || ["PUT"])[0];
    const a = await send(token, method, `${base}/${f.name}`, { champInexistant: "x" });
    console.log(`  ${f.name} ${method} champ bidon -> ${a.status} ${a.text}`);
    if (a.status === 400 && /not allowed by the schema/.test(a.text)) {
      const b = await send(token, method, `${base}/${f.name}`, {});
      console.log(`  ${f.name} ${method} corps vide  -> ${b.status} ${b.text}`);
    } else {
      console.log(`  ${f.name} : le serveur ne vérifie pas le format, on n'envoie rien de plus.`);
    }
  }
  console.log("\nExploration terminée.");
}

main().catch((e) => {
  console.log(`\nERREUR : ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`);
  process.exitCode = 1;
});
