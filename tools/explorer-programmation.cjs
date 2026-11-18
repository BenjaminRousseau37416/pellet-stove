// Exploration : format de la programmation hebdomadaire côté serveur SmartEK63.
//
// À lancer APRÈS avoir créé au moins une plage dans la programmation de l'app officielle. Le script :
//  1. lit l'état du poêle et affiche tout le bloc « scheduling » (les plages et leur format) ;
//  2. envoie UNE requête volontairement invalide à la commande scheduling ({ champInexistant: "x" }) :
//     le serveur la refuse en listant les champs qu'il exige ;
//  3. seulement si le serveur vérifie bien le format, deux autres requêtes au type volontairement faux
//     (active: "x", slot1: "x"), refusées elles aussi, pour connaître le type attendu ;
//  4. relit l'état pour vérifier que la programmation n'a pas bougé.
// Le mot de passe est saisi masqué, jamais affiché ni enregistré.
//
// Lancer : node --use-system-ca tools/explorer-programmation.cjs

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
  console.log("=== Exploration de la programmation hebdomadaire ===\n");
  const email = await ask("E-mail du compte SmartEK63 : ");
  const password = await askHidden("Mot de passe (masqué) : ");
  const token = await login(email, password);
  const heaters = JSON.parse((await call(token, "GET", "/heaters")).text);
  const id = encodeURIComponent(heaters[0].id);

  const before = JSON.parse((await call(token, "GET", `/heaters/${id}`)).text);
  console.log("\nConnecté.\n");
  console.log(`Mode : ${before.mode} · Horloge du poêle : ${before.date}`);
  console.log("Programmation actuelle (scheduling) :");
  console.log(JSON.stringify(before.scheduling, null, 2).replace(/^/gm, "  "));

  console.log("\nRéponses du serveur (requêtes invalides, refusées) :");
  const a = await call(token, "PUT", `/heaters/${id}/scheduling`, { champInexistant: "x" });
  console.log(`  champ bidon       -> ${a.status} ${a.text.slice(0, 400)}`);
  if (a.status === 400 && /not allowed by the schema/.test(a.text)) {
    for (const [label, body] of [["active: \"x\"", { active: "x" }], ["slot1: \"x\"", { slot1: "x" }]]) {
      const r = await call(token, "PUT", `/heaters/${id}/scheduling`, body);
      console.log(`  ${label.padEnd(17)} -> ${r.status} ${r.text.slice(0, 400)}`);
    }
  } else {
    console.log("  Le serveur ne vérifie pas le format : on n'envoie rien de plus.");
  }

  const after = JSON.parse((await call(token, "GET", `/heaters/${id}`)).text);
  const same = JSON.stringify(after.scheduling) === JSON.stringify(before.scheduling);
  console.log(`\nProgrammation après exploration : ${same ? "inchangée" : "ATTENTION : a changé"}`);
  console.log("\nExploration terminée.");
}

main().catch((e) => {
  console.log(`\nERREUR : ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`);
  process.exitCode = 1;
});
