// Chat-Moderation: gesperrte Wörter werden im Chat durch Sternchen ersetzt, Spieler- und Account-Namen damit abgelehnt.
// Erkennt auch einfache Tarnung: Groß/klein, Ziffern statt Buchstaben (f1ck, h0re), Satzzeichen dazwischen (f.u.c.k),
// gedehnte Buchstaben (fuuuck). Kurze Wörter (≤ 4 Buchstaben) nur als ganzes Wort – sonst träfe „hure“ auch „Schurer“.
// Die Liste pflegt die Admin-Seite (Spiel-Konfiguration „chat“).

let words: string[][] = [];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', $: 's', '7': 't', '€': 'e', '8': 'b' };

/** Wort für den Vergleich: klein, Tarnung entfernt, Wiederholungen zusammengezogen */
function norm(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0-9!@$€]/g, (c) => LEET[c] ?? c)
    .replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
}

export function setBadWords(list: string[]) {
  words = list.map((w) => w.split(' ').map(norm).filter(Boolean)).filter((w) => w.length);
}

/** Welche Wörter (Indizes in `tokens`) gehören zu einem gesperrten Wort oder Ausdruck? */
function hits(tokens: string[]): Set<number> {
  const n = tokens.map(norm);
  const out = new Set<number>();
  for (const bad of words) {
    if (bad.length === 1) {
      const b = bad[0];
      n.forEach((t, i) => {
        if (t && (b.length <= 4 ? t === b || t === `${b}s` || t === `${b}n` : t.includes(b))) out.add(i);
      });
    } else
      for (let i = 0; i + bad.length <= n.length; i++) if (bad.every((b, k) => n[i + k] === b || n[i + k].startsWith(b))) for (let k = 0; k < bad.length; k++) out.add(i + k);
  }
  return out;
}

/** Chat-Nachricht: gesperrte Wörter durch Sternchen ersetzen */
export function moderate(text: string): string {
  const tokens = text.split(/(\s+)/);
  const words = tokens.filter((_, i) => i % 2 === 0);
  const bad = hits(words);
  if (!bad.size) return text;
  return tokens.map((t, i) => (i % 2 === 0 && bad.has(i / 2) ? '*'.repeat([...t].length) : t)).join('');
}

/** Name (Spieler, Account) mit gesperrtem Wort? – auch zusammengeschrieben (z.B. „xFickx“) */
export function isOffensive(name: string): boolean {
  if (hits(name.split(/\s+/)).size) return true;
  const all = norm(name);
  return words.some((w) => w.join('').length >= 5 && all.includes(w.join('')));
}
