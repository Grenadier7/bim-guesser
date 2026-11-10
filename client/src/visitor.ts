// Zufällige Kennung dieses Browsers (kein Bezug zur Person): zählt Besucher und ordnet ohne Account Spielergebnisse
// zu, damit die Spielleitung sieht, wie gespielt wird (siehe Datenschutz → Besucherzählung).
let id = '';

export function visitorId(): string {
  if (id) return id;
  try {
    id = localStorage.getItem('oeffi-visitor') ?? '';
    if (!/^[a-z0-9]{12,40}$/.test(id)) localStorage.setItem('oeffi-visitor', (id = crypto.randomUUID().replace(/-/g, '')));
  } catch {
    id = crypto.randomUUID().replace(/-/g, '');
  }
  return id;
}
