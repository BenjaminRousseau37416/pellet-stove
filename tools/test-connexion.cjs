// Test : connexion au cloud SmartEK63 (Edilkamin, marque EK63) et lecture de l'état du poêle.
// Le mot de passe est saisi masqué. Il n'est ni affiché, ni écrit dans un fichier.
// Ce script ne fait que LIRE : il n'envoie aucune commande au poêle.
//
// Serveur et identifiants Cognito repris de l'intégration open source Homey :
// https://github.com/smarthomesven/homey-smartek63

const readline = require("readline");
const {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} = require("amazon-cognito-identity-js");

const POOL = new CognitoUserPool({
  UserPoolId: "eu-central-1_mqMTP332P",
  ClientId: "751nsgtv5okg7u05mneacrn480",
});
const API = "https://8wmnu4exgg.execute-api.eu-central-1.amazonaws.com/prod";

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      console.error("Ce script doit être lancé dans un terminal interactif.");
      process.exit(1);
    }
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
          // Retire les marqueurs de collage du terminal et les caractères de contrôle.
          resolve(value.replace(/\x1b\[20[01]~/g, "").replace(/[\x00-\x1f\x7f]/g, ""));
          return;
        } else if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(1);
        } else if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function login(email, password) {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: POOL });
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
      onFailure: reject,
      mfaRequired: () => reject(new Error("Double authentification demandée : pas encore gérée.")),
      newPasswordRequired: () => reject(new Error("Le serveur demande un nouveau mot de passe.")),
    });
  });
}

async function get(path, idToken) {
  const res = await fetch(API + path, { headers: { Authorization: idToken } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${path} : ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const yesNo = (b) => (b === true ? "oui" : b === false ? "non" : String(b));
const ON_STATUSES = [1, 4, 5, 10, 11]; // codes considérés "allumé" par l'intégration Homey

async function main() {
  console.log("=== Test de connexion au cloud SmartEK63 ===\n");
  const email = await ask("E-mail du compte SmartEK63 : ");
  const password = await askHidden("Mot de passe (masqué) : ");

  let idToken;
  try {
    idToken = await login(email, password);
  } catch (e) {
    console.log(`\nÉCHEC de la connexion : ${(e && e.code) || (e && e.name) || ""} ${(e && e.message) || e}`);
    if (e && e.code === "NotAuthorizedException") {
      console.log("E-mail ou mot de passe refusé par le serveur SmartEK63.");
    }
    process.exitCode = 1;
    return;
  }
  console.log("\nOK : connecté au cloud SmartEK63.\n");

  const heaters = await get("/heaters", idToken);
  console.log(`Poêle(s) liés à ton compte : ${heaters.length}`);

  for (const h of heaters) {
    console.log(`\n--- ${h.name || "(sans nom)"} ---`);
    const d = await get(`/heaters/${encodeURIComponent(h.id)}`, idToken);
    console.log(`  Connecté au cloud    : ${yesNo(d.online)}`);
    console.log(`  Allumé               : ${yesNo(ON_STATUSES.includes(d.status))}  (code d'état : ${d.status})`);
    console.log(`  Température pièce    : ${d.roomTemperature} °C`);
    console.log(`  Consigne             : ${d.temperature} °C`);
    console.log(`  Ventilateur 1        : ${d.fan1power}`);
    console.log(`  Mode relax           : ${yesNo(d.relaxMode)}`);
    console.log(`  Mode standby         : ${yesNo(d.standbyMode)}`);
    console.log("\n  Données brutes renvoyées par le serveur :");
    console.log(JSON.stringify(d, null, 2).replace(/^/gm, "    "));
  }
  console.log("\nTest terminé.");
}

main().catch((e) => {
  const cause = e && e.cause && e.cause.code ? ` (${e.cause.code})` : "";
  console.log(`\nERREUR : ${(e && e.message) || e}${cause}`);
  if (cause.includes("CERT")) {
    console.log("Le proxy de l'entreprise intercepte la connexion : relance avec  node --use-system-ca tools/test-connexion.cjs");
  }
  process.exitCode = 1;
});
