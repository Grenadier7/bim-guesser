// Chat-Befehl „/ez“: statt der Nachricht kommt ein zufälliger, harmloser Spruch rund um Wien und die Öffis –
// wer angeben will, macht sich so eher selbst ein bisschen lustig. Nie zweimal derselbe hintereinander je Lobby.

export const EZ_PHRASES = [
  'Ich bin nicht langsam, ich fahre im Intervall.',
  'Bitte zurückbleiben – bei meinem Ego ist kein Platz mehr.',
  'GG! Ich steig jetzt aus und geh den Rest zu Fuß.',
  'Mein Orientierungssinn ist wie die U5: noch in Bau.',
  'Nächster Halt: Bescheidenheit. Ausstieg in Fahrtrichtung links.',
  'Ich hätte gern eine Melange und eine Direktverbindung, bitte.',
  'Wer das liest, kriegt den nächsten Sitzplatz im 13A.',
  'Ihr spielt alle super. Ich sag das nur, weil ich gleich verliere.',
  'Endstation Sehnsucht. Bitte alle aussteigen.',
  'Danke für das faire Spiel – ich geh jetzt eine Leberkässemmel essen.',
  'Ich hab nicht gewonnen, ich hab nur Erfahrung gesammelt. Sehr viel Erfahrung.',
  'Liebe Grüße an meinen Busfahrer. Du weißt, wer gemeint ist.',
  'Ich bin heute so schnell wie die Bim im Stau.',
  'Wartezeit ist auch Lebenszeit, sagt mein Opa. Am Bahnsteig. Seit 1987.',
  'Ich nehm alles zurück und behaupte das Gegenteil.',
  'Bitte halten Sie sich an meinem Punktestand fest.',
  'Ich hab kein Problem, ich hab nur eine Umleitung.',
  'Das war knapp. So knapp wie ein Anschluss mit null Minuten Umsteigezeit.',
  'Wer braucht schon eine Karte? Ich. Ich brauche eine Karte.',
  'Ich übe noch. Seit drei Jahren.',
  'Achtung, Zug fährt ab! Wohin? Keine Ahnung.',
  'Ich hab die Strecke nicht geraten, ich hab sie gefühlt.',
  'Kurze Durchsage: Ich hab keinen Plan, aber eine Jahreskarte.',
  'Mein Lieblingsplatz? Jeder, wo ein Sitzplatz frei ist.',
  'Ich steige um. Auf Bescheidenheit.',
  'Tschuldigung, war das meine Station? Egal, ich bleib einfach sitzen.',
  'Heute gewinnen, morgen wieder in die falsche Richtung fahren.',
  'Ich grüße alle, die den Fahrplan auswendig können. Also niemanden.',
  'Ich bin wie ein Nachtbus: selten, aber immer zur Stelle.',
  'Wenn ich groß bin, werde ich Weiche.',
  'Meine Taktik? Einsteigen, hoffen, staunen.',
  'Schöne Runde! Ich geh jetzt Tauben am Schwedenplatz zählen.',
];

const last = new WeakMap<object, number>();

/** „/ez“ (Groß/klein egal, Leerzeichen drumherum egal)? */
export const isEz = (text: string) => text.trim().toLowerCase() === '/ez';

/** zufälliger Spruch – je Lobby nie derselbe wie zuletzt */
export function ezPhrase(lobby: object, rnd = Math.random): string {
  let i = Math.floor(rnd() * EZ_PHRASES.length);
  if (i === last.get(lobby)) i = (i + 1) % EZ_PHRASES.length;
  last.set(lobby, i);
  return EZ_PHRASES[i];
}
