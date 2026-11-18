# Pellet Stove — piloter un poêle à pellets EK63 sans l'app SmartEK63

Petite application web mobile (installable sur l'écran d'accueil) pour piloter un poêle à pellets
**EK63 d'Edilkamin** à la place de l'app officielle **SmartEK63**. Elle parle au même cloud que l'app
officielle, tourne **gratuitement sur Cloudflare Workers** et est protégée par un code d'accès.

> Projet personnel et **non officiel**, sans lien avec Edilkamin. Il utilise une API non documentée
> qui peut changer à tout moment. À utiliser à vos risques ; l'app ne contourne aucune sécurité du poêle.

## Fonctionnalités

**Au quotidien**
- Température de la pièce et état du poêle traduit en français (allumage, en marche, refroidissement…).
- Marche / arrêt, bloqué pendant l'allumage, l'extinction et le nettoyage (et refusé côté serveur).
- Ventilateur principal (1–3) et auxiliaire (arrêt, 1–3), puissance (1–5), mode manuel / automatique.
- **Boost** : puissance 5 pendant 15 min, 30 min ou 1 h, puis retour automatique à la puissance, au mode et
  au relax d'avant (aussi dès que le poêle s'éteint). Changer soi-même la puissance arrête le boost.
- **Easy timer** : allumage ou extinction différés, par demi-heures, avec compte à rebours et annulation.
- **Auxiliaire le soir** : à partir d'une heure choisie, dès que le poêle est en marche, l'auxiliaire passe à
  la vitesse voulue, puis repasse à l'arrêt à la prochaine extinction du poêle.

**Plus de réglages**
- Consigne et veille automatique (actives en mode automatique), mode relax.
- **Programmation hebdomadaire** : 8 tranches horaires (heures par demi-heures, jours de la semaine).
- Remise à l'heure de l'horloge du poêle.
- Liste des états du poêle rencontrés (code et libellé italien → français).

**Montre Wear OS**
- Une tuile « Poêle » : température de la pièce, état, et un bouton Allumer / Éteindre (voir `watch/`).

**Suivi des températures**
- Relevé de la température de la pièce toutes les 15 minutes, conservé 400 jours.
- Graphique par **semaine** (lundi → dimanche) ou par **jour**, avec les périodes de chauffe en fond.
- Température extérieure de la commune choisie (Open-Meteo), sans jamais afficher de prévision.
- Résumé (moyennes, min–max, heures de chauffe) et tableau par jour ou par heure.

## Architecture

```
Téléphone (page web)
   │  code d'accès → cookie de session (HttpOnly, 1 an)
   ▼
Worker Cloudflare  ── /api/state, /api/command, /api/settings, /api/history
   │  tâche programmée toutes les 5 min : auxiliaire du soir, fin du boost, relevé de température (1 sur 3)
   │  stockage KV : réglages, états rencontrés, historique, jeton en cache
   ▼
Cloud SmartEK63 (AWS Cognito + API Gateway)  ──►  poêle (module Wi-Fi)

Téléphone ──► Open-Meteo (température extérieure, appelé directement par la page)
Montre (tuile Wear OS) ──► Worker /api/watch, avec une clé dédiée (lecture de l'état + marche/arrêt)
```

| Fichier | Rôle |
|---|---|
| `src/index.js` | Worker : code d'accès, routes `/api/*`, tâche programmée |
| `src/ek63.js` | Client du cloud SmartEK63 : connexion, jeton, commandes, traduction et phase des états |
| `src/store.js` | Stockage KV : réglages, état de l'automatisme, états rencontrés |
| `src/automation.js` | Automatisme « auxiliaire le soir » |
| `src/boost.js` | Mode boost : lancement, fin automatique, retour aux réglages d'avant |
| `src/history.js` | Relevés de température et lecture de l'historique |
| `src/demo.js` | Faux poêle pour le mode démo |
| `public/` | Interface (une seule page HTML, sans dépendance), manifeste et icônes |
| `test/worker.test.mjs` | Tests automatiques avec un faux serveur SmartEK63 et un faux KV |
| `scripts/make-icons.mjs` | Génère les icônes PNG |
| `tools/` | Scripts de diagnostic lancés depuis un PC (voir plus bas) |
| `watch/` | App Wear OS (Kotlin) : la tuile Marche/Arrêt pour la montre |

## Installation

Prérequis : Node.js 22 ou plus récent, un compte Cloudflare gratuit (adresse e-mail vérifiée) et un compte SmartEK63.

```bash
npm install
npx wrangler login
npx wrangler kv namespace create poele
```

Reporter l'identifiant affiché dans `wrangler.jsonc` (`kv_namespaces[0].id`, l'identifiant présent est
celui de mon compte), puis :

```bash
npx wrangler deploy
npx wrangler secret put EK63_EMAIL
npx wrangler secret put EK63_PASSWORD
npx wrangler secret put ACCESS_CODE
```

- `EK63_EMAIL` / `EK63_PASSWORD` : identifiants du compte SmartEK63.
- `ACCESS_CODE` : code d'accès à l'app, 12 caractères minimum. Le changer déconnecte tous les appareils.

Ouvrir l'adresse `https://poele.<sous-domaine>.workers.dev` sur le téléphone, entrer le code, puis
« Ajouter à l'écran d'accueil ». La commune pour la température extérieure se choisit dans l'écran Températures.

## Montre Wear OS (`watch/`)

Une app sans écran propre : elle ajoute une **tuile** (l'écran qu'on atteint en balayant depuis le cadran)
avec la température de la pièce, l'état du poêle et un bouton **Allumer / Éteindre**. Le bouton est bloqué
pendant l'allumage et l'extinction ; toucher la tuile ailleurs actualise l'état. Les appels réseau passent par
WorkManager, l'état est mis en cache sur la montre et la tuile se redemande toutes les 10 minutes.

La montre n'utilise pas le code d'accès de l'app web mais une **clé dédiée**, qui ne permet que deux choses :

| Route du Worker | Rôle |
|---|---|
| `GET /api/watch` | État résumé : `online`, `isOn`, `phase`, `statusFr`, `roomTemperature`, `canToggle` |
| `POST /api/watch/power` | `{ "on": true \| false }` |

**Configuration**
1. Créer une clé d'au moins 32 caractères et la déclarer au Worker : `npx wrangler secret put WATCH_TOKEN`.
2. Créer `watch/secrets.properties` (ignoré par git) :
   ```properties
   WORKER_URL=https://poele.<sous-domaine>.workers.dev
   WATCH_TOKEN=<la même clé>
   ```
3. Créer `watch/local.properties` (ignoré par git) avec `sdk.dir=C:/chemin/vers/Android/Sdk`.

**Compilation** (JDK 17 ou plus, SDK Android avec `platforms;android-36` et `build-tools;36.0.0`) :
```bash
cd watch
./gradlew assembleDebug   # → app/build/outputs/apk/debug/app-debug.apk
```
Derrière un proxy d'entreprise : `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=Windows-ROOT` (Windows).

**Installation sur la montre** (Wear OS 4 ou plus récent, PC et montre sur le même Wi-Fi) :
1. Sur la montre : *Paramètres → À propos de la montre → Informations sur le logiciel*, toucher 5 fois
   *Version du logiciel* ; puis *Options de développement* → activer *Débogage ADB* et *Débogage sans fil*.
2. *Débogage sans fil → Associer un nouvel appareil* : noter l'adresse, le port et le code affichés.
3. Sur le PC : `adb pair <adresse>:<port d'association> <code>`, puis `adb connect <adresse>:<port>` (le port
   affiché sur l'écran *Débogage sans fil*), puis `adb install -r watch/app/build/outputs/apk/debug/app-debug.apk`.
4. Sur la montre : appui long sur le cadran ou balayage jusqu'à la fin des tuiles → *Ajouter une tuile* → « Poêle ».

## Développement

```bash
npm test          # tests automatiques (aucun appel réseau)
npm run demo      # app locale avec un faux poêle : http://localhost:8787 (code de démo dans package.json)
npx wrangler deploy
```

Derrière un proxy d'entreprise qui inspecte le HTTPS, Node ne reconnaît pas le certificat du proxy :
définir `NODE_USE_SYSTEM_CA=1` (ou lancer `node --use-system-ca …`).

## API SmartEK63 (rétro-ingénierie)

Connexion : AWS Cognito (`eu-central-1_mqMTP332P`, client `751nsgtv5okg7u05mneacrn480`), flux
`USER_PASSWORD_AUTH`. Le jeton `IdToken` est envoyé tel quel dans l'en-tête `Authorization`.
Base : `https://8wmnu4exgg.execute-api.eu-central-1.amazonaws.com/prod`.

| Requête | Corps | Remarques |
|---|---|---|
| `GET /heaters` | | Liste des poêles du compte |
| `GET /heaters/{id}` | | État : `status`, `statusDescription` (italien), `roomTemperature`, `temperature`, `power`, `mode`, `fan1Power`, `fan2Power`, `easyTimerDate`, `scheduling`, `date` (horloge du poêle)… |
| `PUT …/status` | `{ "status": "on" \| "off" }` | |
| `PUT …/temperature` | `{ "temperature": 21 }` | Degrés entiers |
| `PUT …/power` | `{ "power": 1..5 }` | Utile en mode manuel |
| `PUT …/fan` | `{ "fan": 1 \| 2, "power": n }` | Vitesse réelle (maximum 6 côté serveur) |
| `PUT …/mode` | `{ "mode": "auto" \| "manual" }` | |
| `PUT …/relax` / `…/standby` | `{ "relaxMode": bool }` / `{ "standbyMode": bool }` | La veille n'a pas de durée réglable |
| `PUT …/timer` | `{ "date": "<ISO UTC>" }` ou `{ "date": null }` | Easy timer : inverse l'état à cette date ; `null` annule |
| `PUT …/date` | `{ "date": "AAAA-MM-JJTHH:mm:ss.000" }` | Horloge du poêle, heure locale sans fuseau |
| `PUT …/scheduling` | `{ active, slot1 … slot8 }` | Les 9 champs à chaque fois ; tranche = `{ startTime, endTime, days }` en secondes depuis minuit (demi-heures) |
| `GET …/alarms`, `PUT …/cochlea` | | Existent, non utilisées |

À savoir :
- La passerelle valide le format des requêtes : un champ inconnu renvoie un 400 qui liste les champs attendus.
- Le poêle répond parfois `409 {"code":"HEATER_COMMAND"}` (« la stufa non accetta il comando »), y compris
  pour une commande qu'il a bien appliquée ou qu'il accepte quelques secondes plus tard. Pour la
  programmation, le Worker relit l'état puis réessaie deux fois.
- États confirmés : `0` « Stufa spenta », `11` « Potenza 1 », `41` « Raffreddamento ». Les autres libellés
  sont classés par mots-clés et listés dans l'app au fur et à mesure qu'ils apparaissent.

## Outils de diagnostic (`tools/`)

Scripts à lancer sur un PC (`node --use-system-ca tools/<script>`). Le mot de passe est saisi masqué
et n'est jamais affiché ni enregistré. Les scripts `explorer-*` n'envoient que des requêtes volontairement
invalides, refusées par la passerelle, pour découvrir les formats attendus.

| Script | Usage |
|---|---|
| `test-connexion.cjs` | Se connecter et afficher l'état complet du poêle |
| `explorer-commandes.cjs` | Lister les commandes qui existent côté serveur |
| `explorer-veille.cjs`, `explorer-timer.cjs`, `explorer-programmation.cjs` | Format de la veille, de l'easy timer et de la programmation |

## Coûts

Tout tient dans les offres gratuites :
- Cloudflare Workers : environ 300 à 3 000 requêtes par jour, pour 100 000 gratuites.
- KV : environ 130 écritures par jour, pour 1 000 gratuites.
- Open-Meteo : gratuit pour un usage personnel non commercial, quelques appels par consultation.

## Crédits

- Identifiants Cognito et premières routes repris de [homey-smartek63](https://github.com/smarthomesven/homey-smartek63).
- Données météo : [Open-Meteo.com](https://open-meteo.com/), licence CC BY 4.0.
