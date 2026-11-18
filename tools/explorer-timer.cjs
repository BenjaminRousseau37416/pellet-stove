// Exploration : format de l'easy timer (allumage/extinction différés) côté serveur SmartEK63.
//
// À lancer APRÈS avoir réglé un easy timer dans l'app officielle (ex. 3 heures, pour qu'il ne se déclenche pas
// pendant l'essai). Le script :
//  1. lit l'état du poêle et affiche la date du timer, l'horloge du poêle et l'heure réelle ;
//  2. envoie UNE requête volontairement invalide à la commande timer ({ date: true }) : le serveur la refuse
//     en indiquant le type de date qu'il attend (et si « null » est accepté, ce qui servirait à annuler) ;
//  3. relit l'état pour vérifier que le timer n'a pas bougé.
// Le mot de passe est saisi masqué, jamais affiché ni enregistré.
//
// Lancer : node --use-system-ca tools/explorer-timer.cjs

const readline = require("readline");

const COGNITO_URL = "https://cognito-idp.eu-central-1.amazonaws.com/";
const CLIENT_ID = "751nsgtv5okg7u05mneacrn480";
const API = "https://8wmnu4exgg.execute-api.eu-central-1.amazonaws.com/prod";

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

async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  console.log("=== Exploration de l'easy timer ===\n");
  const email = await ask("E-mail du compte SmartEK63 : ");
  const password = await askHidden("Mot de passe (masqué) : ");
  const token = await login(email, password);
  const heaters = JSON.parse((await call(token, "GET", "/heaters")).text);
  const id = encodeURIComponent(heaters[0].id);

  const before = JSON.parse((await call(token, "GET", `/heaters/${id}`)).text);
  console.log("\nConnecté.\n");
  console.log(`Heure réelle (UTC)   : ${new Date().toISOString()}`);
  console.log(`Horloge du poêle     : ${JSON.stringify(before.date)}`);
  console.log(`Date de l'easy timer : ${JSON.stringify(before.easyTimerDate)}`);
  console.log(`État du poêle        : ${before.status} ${before.statusDescription}\n`);

  const r = await call(token, "PUT", `/heaters/${id}/timer`, { date: true });
  console.log(`Requête invalide { date: true } -> ${r.status} ${r.text.slice(0, 300)}`);

  const after = JSON.parse((await call(token, "GET", `/heaters/${id}`)).text);
  console.log(`\nDate de l'easy timer après : ${JSON.stringify(after.easyTimerDate)} ` +
    `(${JSON.stringify(after.easyTimerDate) === JSON.stringify(before.easyTimerDate) ? "inchangée" : "ATTENTION : a changé"})`);
  console.log("\nExploration terminée.");
}

main().catch((e) => {
  console.log(`\nERREUR : ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`);
  process.exitCode = 1;
});
