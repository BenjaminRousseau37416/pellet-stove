// Exploration : quel format le serveur SmartEK63 attend-il pour la durée de veille ?
//
// Ce script ne change rien sur le poêle :
//  - la veille est toujours renvoyée avec sa valeur ACTUELLE (activée ou non) ;
//  - chaque champ testé reçoit un type volontairement faux ("x"), pour que le serveur refuse la requête
//    en expliquant ce qu'il attend. Un champ inconnu est simplement ignoré ou refusé.
// À la fin, il relit l'état pour vérifier que la veille n'a pas bougé.
// Le mot de passe est saisi masqué, jamais affiché ni enregistré.
//
// Lancer : node --use-system-ca tools/explorer-veille.cjs

const readline = require("readline");

const COGNITO_URL = "https://cognito-idp.eu-central-1.amazonaws.com/";
const CLIENT_ID = "751nsgtv5okg7u05mneacrn480";
const API = "https://8wmnu4exgg.execute-api.eu-central-1.amazonaws.com/prod";
const CANDIDATES = [
  "standbyTime", "standbyMinutes", "standbyDelay", "standbyWaitingTime", "standbyTimer", "standbyDuration",
  "waitingTime", "delay", "minutes", "time", "duration", "timer",
];

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
  console.log("=== Exploration de la durée de veille (aucun changement sur le poêle) ===\n");
  const email = await ask("E-mail du compte SmartEK63 : ");
  const password = await askHidden("Mot de passe (masqué) : ");
  const token = await login(email, password);
  console.log("\nConnecté.\n");

  const heaters = JSON.parse((await call(token, "GET", "/heaters")).text);
  const id = encodeURIComponent(heaters[0].id);
  const before = JSON.parse((await call(token, "GET", `/heaters/${id}`)).text);
  const current = before.standbyMode === true;

  console.log("Champs de l'état liés à la veille ou au temps :");
  for (const [k, v] of Object.entries(before)) {
    if (/stand|time|delay|minute|timer|wait/i.test(k)) console.log(`  ${k} = ${JSON.stringify(v)}`);
  }
  console.log(`Tous les champs : ${Object.keys(before).join(", ")}\n`);
  console.log(`Veille actuelle : ${current ? "activée" : "désactivée"} (elle sera renvoyée telle quelle)\n`);

  const probes = [];
  if (!current) probes.push(["corps vide", {}]); // seulement si la veille est déjà désactivée
  probes.push(["champ bidon", { standbyMode: current, champInexistant: "x" }]);
  for (const name of CANDIDATES) probes.push([name, { standbyMode: current, [name]: "x" }]);

  console.log("Réponses du serveur (PUT /standby) :");
  for (const [label, body] of probes) {
    const r = await call(token, "PUT", `/heaters/${id}/standby`, body);
    console.log(`  ${label.padEnd(20)} -> ${r.status} ${r.text.slice(0, 300)}`);
  }

  const after = JSON.parse((await call(token, "GET", `/heaters/${id}`)).text);
  console.log(`\nVeille après exploration : ${after.standbyMode ? "activée" : "désactivée"} ` +
    `(${after.standbyMode === before.standbyMode ? "inchangée" : "ATTENTION : a changé"})`);
  console.log("\nExploration terminée.");
}

main().catch((e) => {
  console.log(`\nERREUR : ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`);
  process.exitCode = 1;
});
