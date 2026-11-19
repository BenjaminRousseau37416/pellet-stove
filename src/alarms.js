// Historique des alarmes du poêle : signification des codes, d'après le manuel EK63 (section 18).

export const ALARM_INFO = {
  1: { title: "Alarme 1", advice: "Code non décrit dans le manuel : contacter le technicien." },
  2: { title: "Vitesse de l'extracteur de fumées anormale", advice: "Contacter le technicien." },
  3: {
    title: "Flamme éteinte (fumées trop froides)",
    advice: "Vérifier qu'il reste des pellets dans le réservoir.",
  },
  4: {
    title: "Allumage raté",
    advice: "Vérifier la propreté et la position du brasier, et la présence de pellets.",
  },
  5: { title: "Alarme 5", advice: "Code non décrit dans le manuel : contacter le technicien." },
  6: { title: "Sonde de fumées défectueuse ou débranchée", advice: "Contacter le technicien." },
  7: { title: "Fumées trop chaudes", advice: "Vérifier le type de pellets ; en cas de doute, contacter le technicien." },
  8: { title: "Poêle en surchauffe", advice: "Vérifier le type de pellets ; en cas de doute, contacter le technicien." },
  9: { title: "Moteur de la vis sans fin bloqué ou cassé", advice: "Contacter le technicien." },
  10: { title: "Surchauffe de la carte électronique", advice: "Contacter le technicien." },
  11: {
    title: "Pressostat de sécurité déclenché",
    advice: "Vérifier le nettoyage du poêle et du conduit, et que le couvercle du réservoir est bien fermé.",
  },
  12: { title: "Sonde de température ambiante défectueuse", advice: "Contacter le technicien." },
};

export function describeAlarm(code) {
  return ALARM_INFO[code] || { title: `Alarme ${code}`, advice: "Code inconnu : voir le manuel ou contacter le technicien." };
}

// Le serveur renvoie les 10 dernières alarmes (mémoire circulaire, pas dans l'ordre) :
// { code: "ALARM-3", preState, preStateDescription, state, stateDescription: "A03 - fine pellet / stop fiamma",
//   date: "2026-04-11T09:01:59.000" (horloge du poêle, sans fuseau) }.
// translateState : traduction des états (fournie par ek63.js pour éviter une dépendance circulaire).
export function normalizeAlarms(raw, translateState) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a.stateDescription === "string" && /^A\d+/.test(a.stateDescription) && a.date)
    .map((a) => {
      const num = Number(a.stateDescription.match(/^A(\d+)/)[1]);
      const info = describeAlarm(num);
      return {
        code: `AL${String(num).padStart(2, "0")}`,
        title: info.title,
        advice: info.advice,
        original: a.stateDescription,
        before: translateState(a.preStateDescription || ""),
        date: a.date,
      };
    })
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
}
