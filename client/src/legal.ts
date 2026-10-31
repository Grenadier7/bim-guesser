// Rechtliches: Impressum, Datenschutzerklärung, Nutzungsregeln, Quellen & Lizenzen – als Fenster über allem
// (wie das Account-Fenster), erreichbar über die Fußzeile der Startseite und per Link (#impressum, #datenschutz …).
// Die Angaben zum Betreiber kommen aus der Spiel-Konfiguration (Admin-Seite → Einstellungen → Impressum & Datenschutz).
import { DEFAULT_HOSTING, type LegalInfo } from '../../shared/config.ts';
import { accountApi } from './account.ts';
import { app } from './store.ts';
import { esc, h } from './ui.ts';

export type LegalPage = 'impressum' | 'datenschutz' | 'regeln' | 'quellen';

const PAGES: [LegalPage, string][] = [
  ['impressum', 'Impressum'],
  ['datenschutz', 'Datenschutz'],
  ['regeln', 'Nutzungsregeln'],
  ['quellen', 'Quellen & Lizenzen'],
];
/** Stand der Datenschutzerklärung – bei inhaltlichen Änderungen anpassen */
const PRIVACY_DATE = '31. Oktober 2026';

const sheet = h('div', { class: 'acct-sheet legal-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Rechtliches' });
sheet.hidden = true;
document.body.append(sheet);
let page: LegalPage = 'impressum';
let contactP: Promise<{ contact: string | null; mail: boolean }> | null = null;

export function openLegal(p: LegalPage) {
  page = p;
  sheet.hidden = false;
  document.body.classList.add('acct-open');
  void render();
}

function close() {
  sheet.hidden = true;
  document.body.classList.remove('acct-open');
  if (PAGES.some(([p]) => location.hash === `#${p}`)) history.replaceState(null, '', location.pathname + location.search);
}

sheet.addEventListener('click', (e) => e.target === sheet && close());
document.addEventListener('keydown', (e) => e.key === 'Escape' && !sheet.hidden && close());

/** Link wie /#datenschutz öffnet gleich die Seite */
export function openLegalFromHash() {
  const p = PAGES.find(([id]) => location.hash === `#${id}`);
  if (p) openLegal(p[0]);
}
window.addEventListener('hashchange', openLegalFromHash);

/** Fußzeile mit allen rechtlichen Links (Startseite) */
export function legalFooter(): string {
  return `<nav class="legal-foot" aria-label="Rechtliches">${PAGES.map(([id, label]) => `<a href="#${id}" data-legal="${id}">${label}</a>`).join('<span aria-hidden="true">·</span>')}</nav>`;
}

export function bindLegalLinks(root: HTMLElement) {
  root.querySelectorAll<HTMLAnchorElement>('[data-legal]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openLegal(a.dataset.legal as LegalPage);
    }),
  );
}

async function info(): Promise<{ l: LegalInfo; email: string | null; mail: boolean }> {
  contactP ??= accountApi.privacy().catch(() => ((contactP = null), { contact: null, mail: false }));
  const srv = await contactP;
  const l = app.config?.legal ?? { name: '', street: '', city: '', email: '', phone: '', purpose: '', hosting: DEFAULT_HOSTING, mailProvider: '' };
  return { l, email: l.email || srv.contact, mail: srv.mail };
}

const mail = (e: string | null) => (e ? `<a href="mailto:${esc(e)}">${esc(e)}</a>` : '<i>wird noch ergänzt</i>');

function operator(l: LegalInfo, email: string | null): string {
  const lines = [l.name, l.street, l.city].filter(Boolean).map(esc);
  return `<p>${lines.length ? lines.join('<br>') : '<i>Angaben zum Betreiber werden noch ergänzt.</i>'}</p>
    <p>E-Mail: ${mail(email)}${l.phone ? `<br>Telefon: ${esc(l.phone)}` : ''}</p>`;
}

function impressum(l: LegalInfo, email: string | null): string {
  return `<h3>Impressum</h3>
    <p class="muted">Angaben nach § 5 E-Commerce-Gesetz und Offenlegung nach § 25 Mediengesetz</p>
    <h4>Medieninhaber und Betreiber</h4>${operator(l, email)}
    ${l.purpose ? `<h4>Grundlegende Richtung</h4><p>${esc(l.purpose)}</p>` : ''}
    <h4>Kein offizielles Angebot</h4>
    <p>BimGuesser ist ein unabhängiges Spiel und kein Angebot der Wiener Linien, der ÖBB oder eines Verkehrsverbunds. Linien- und Haltestellennamen sowie Farben dienen nur dazu, das echte Netz wiederzuerkennen.</p>
    <h4>Haftung für Inhalte</h4>
    <p>Die Inhalte werden mit Sorgfalt erstellt. Fahrpläne, Fahrzeiten und Verbindungen im Spiel stammen aus offenen Daten und werden für das Spiel aufbereitet – sie können vom echten Betrieb abweichen. Für die Reiseplanung bitte die offiziellen Auskünfte (z.B. WienMobil, AnachB, ÖBB Scotty) verwenden. Für Richtigkeit, Vollständigkeit und ständige Verfügbarkeit wird keine Gewähr übernommen.</p>
    <h4>Haftung für Links</h4>
    <p>Für Inhalte verlinkter fremder Seiten sind ausschließlich deren Betreiber verantwortlich. Wird eine Rechtsverletzung bekannt, wird der Link umgehend entfernt.</p>
    <h4>Urheberrecht</h4>
    <p>Texte, Gestaltung und Programm von BimGuesser sind urheberrechtlich geschützt. Verwendete Daten und Karten stehen unter den Lizenzen ihrer Quellen – siehe <a href="#quellen" data-legal="quellen">Quellen & Lizenzen</a>.</p>
    <h4>Kontakt</h4>
    <p>Fragen, Hinweise auf Fehler oder rechtliche Anliegen bitte an ${mail(email)}.</p>`;
}

function datenschutz(l: LegalInfo, email: string | null, mailOn: boolean): string {
  return `<h3>Datenschutzerklärung</h3>
    <p class="muted">Stand: ${PRIVACY_DATE}</p>
    <div class="legal-box"><b>Kurz gesagt:</b> Kein Tracking, keine Werbung, keine Analyse-Dienste, kein Verkauf von Daten. Ohne Account bleibt fast alles in deinem Browser. Mit Account speichert der Server nur, was das Spiel braucht – und du kannst alles jederzeit selbst löschen.</div>

    <h4>1. Verantwortlicher</h4>${operator(l, email)}

    <h4>2. Nutzung ohne Account</h4>
    <ul>
      <li><b>Im Browser</b> (lokaler Speicher, nicht beim Betreiber): Spielname, Einstellungen, Lernfortschritt, Training, Tutorial-Stand, ob ein Hinweis geschlossen wurde, und die laufende Spielsitzung (nur bis der Tab geschlossen wird). Du kannst das jederzeit über die Browser-Einstellungen löschen.</li>
      <li><b>Besucherzählung</b>: Damit der Betreiber sieht, wie viele Leute gerade spielen, meldet die Seite etwa jede Minute eine zufällig erzeugte Kennung dieses Browsers an den Server. Sie hat keinen Bezug zu deiner Person oder IP-Adresse. Gespeichert wird nur, an welchen Tagen die Kennung da war (und ob mit Account) – nach 90 Tagen gelöscht.</li>
      <li><b>Spiele und Chat</b>: In einer Lobby sehen die anderen Mitspielenden deinen Spielnamen, deine Antworten und Punkte sowie Chat-Nachrichten. Lobbys und Chat liegen nur im Arbeitsspeicher des Servers und verschwinden, wenn die Lobby endet (spätestens nach wenigen Stunden).</li>
      <li><b>Verbindungsdaten</b>: Beim Aufruf verarbeitet der Server technisch nötige Daten wie die IP-Adresse – nur kurzzeitig im Arbeitsspeicher, um Missbrauch (z.B. massenhafte Anfragen) abzuwehren. Es werden keine Zugriffsprotokolle mit IP-Adressen gespeichert.</li>
    </ul>
    <p>Rechtsgrundlage: berechtigtes Interesse am sicheren Betrieb des Spiels (Art. 6 Abs. 1 lit. f DSGVO).</p>

    <h4>3. Account</h4>
    <p>Ein Account ist freiwillig. Gespeichert werden:</p>
    <ul>
      <li>Benutzername und Passwort – das Passwort nur als nicht umkehrbarer Hash, niemand kann es lesen.</li>
      <li>E-Mail-Adresse (freiwillig) – nur für „Passwort vergessen“, für andere nie sichtbar.</li>
      <li>Spielstand (Lernfortschritt, Einstellungen, Tutorial), Statistik (Spiele, Punkte, Medaillen, Lieblingslinien), Freundschaften und Einladungen, Zeitpunkt der letzten Aktivität.</li>
    </ul>
    <p>Sichtbar für alle: Name, Level, Medaillen und seit wann du dabei bist. Nur für Freunde: Statistik, Lieblingslinien und ob du online bist.</p>
    <p>Rechtsgrundlage: Nutzungsvertrag (Art. 6 Abs. 1 lit. b DSGVO). Speicherdauer: bis du den Account löschst (Account-Fenster → ⚙️ → „Account löschen“) – dann ist alles sofort weg. Anmeldungen laufen nach 180 Tagen ab, Einladungen nach 2 Stunden.</p>

    <h4>4. „Passwort vergessen“</h4>
    <p>Wenn du eine E-Mail-Adresse hinterlegt hast und das Passwort zurücksetzt, bekommst du einen Link, der eine Stunde gilt.${mailOn ? ` Die E-Mail wird über ${l.mailProvider ? esc(l.mailProvider) : 'einen E-Mail-Anbieter'} verschickt.` : ''}</p>

    <h4>5. Cookie</h4>
    <p>Es gibt genau ein Cookie (<code>bg_sid</code>): Es hält dich angemeldet und wird beim Abmelden gelöscht. Es ist technisch notwendig (§ 165 Abs. 3 TKG 2021), dient nicht der Werbung oder Analyse und braucht deshalb keine Einwilligung. Ohne Account wird kein Cookie gesetzt.</p>

    <h4>6. Karte</h4>
    <p>Die Kartenbilder lädt dein Browser direkt von Esri (Environmental Systems Research Institute, Redlands, USA; Kartendaten u.a. © OpenStreetMap). Dabei erhält Esri technisch deine IP-Adresse und welcher Kartenausschnitt geladen wird. Rechtsgrundlage: berechtigtes Interesse an einer funktionierenden Karte (Art. 6 Abs. 1 lit. f DSGVO). Dabei können Daten in die USA übermittelt werden.</p>

    <h4>7. Fahrplanauskunft</h4>
    <p>Für Verbindungen fragt der Server bei Bedarf die offene Fahrplanauskunft der Wiener Linien ab – nur mit Haltestellen und Uhrzeit, ohne Daten über dich.</p>

    <h4>8. Hosting</h4>
    <p>${esc(l.hosting || DEFAULT_HOSTING)}</p>

    <h4>9. Moderation und Sicherheit</h4>
    <p>Chat-Nachrichten und Namen werden automatisch auf beleidigende Wörter geprüft. Zur Moderation kann die Spielleitung laufende Lobbys samt Chat einsehen und Spielende entfernen. Zur Verwaltung sieht sie die Accounts (inkl. hinterlegter E-Mail-Adresse) und kann sie umbenennen, abmelden oder löschen. Solche Eingriffe werden protokolliert. Für Statistiken (z.B. Spiele je Tag, oft gewählte Linien) werden nur Zahlen ohne Personenbezug gespeichert.</p>

    <h4>10. Weitergabe</h4>
    <p>Daten werden nicht verkauft und nicht für Werbung genutzt. Weitergegeben wird nur, was in den Punkten 4, 6 und 8 steht. Es gibt keine automatisierten Entscheidungen oder Profile.</p>

    <h4>11. Deine Rechte</h4>
    <p>Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch. Am einfachsten: Account selbst löschen, sonst eine E-Mail an ${mail(email)}. Wenn du meinst, dass deine Daten nicht richtig verarbeitet werden, kannst du dich bei der Datenschutzbehörde beschweren (Barichgasse 40–42, 1030 Wien, <a href="https://www.dsb.gv.at" target="_blank" rel="noopener">dsb.gv.at</a>).</p>`;
}

function regeln(email: string | null): string {
  return `<h3>Nutzungsregeln</h3>
    <ul class="legal-rules">
      <li><b>Kostenlos und ohne Gewähr.</b> BimGuesser ist ein Spiel. Es kann Fehler haben oder zeitweise nicht erreichbar sein.</li>
      <li><b>Nicht für die Reiseplanung.</b> Fahrpläne und Verbindungen sind für das Spiel aufbereitet und können vom echten Betrieb abweichen.</li>
      <li><b>Fair und freundlich.</b> Keine Beleidigungen, Drohungen, Hetze oder anstößigen Namen, kein Spam. Der Chat filtert solche Wörter automatisch; die Spielleitung kann Spielende aus Lobbys entfernen, anstößige Namen ändern und Accounts löschen.</li>
      <li><b>Dein Account.</b> Halte dein Passwort geheim. Unter 14 Jahren bitte nur mit Zustimmung der Eltern einen Account anlegen.</li>
      <li><b>Keine Automatisierung.</b> Bitte keine Bots oder massenhaften Anfragen – das stört alle anderen.</li>
      <li><b>Änderungen.</b> Spiel und Regeln können sich ändern. Fragen oder Probleme: ${mail(email)}.</li>
    </ul>`;
}

function quellen(): string {
  return `<h3>Quellen & Lizenzen</h3>
    <ul class="legal-rules">
      <li><b>Haltestellen, Linien und Live-Auskunft:</b> Wiener Linien – <a href="https://www.wienerlinien.at/open-data" target="_blank" rel="noopener">Open Data</a>, Lizenz CC BY 4.0.</li>
      <li><b>Fahrplan:</b> Datenquelle: Mobilitätsverbünde Österreich OG – <a href="https://data.mobilitaetsverbuende.at" target="_blank" rel="noopener">data.mobilitaetsverbuende.at</a> (für das Spiel verarbeitet).</li>
      <li><b>Adressen und Bezirksgrenzen:</b> Stadt Wien – <a href="https://data.wien.gv.at" target="_blank" rel="noopener">data.wien.gv.at</a>, Lizenz CC BY 4.0.</li>
      <li><b>Karte:</b> Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende.</li>
      <li><b>Software:</b> <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a> (BSD-2-Clause), Express (MIT), Nodemailer (MIT-0), yauzl (MIT).</li>
    </ul>
    <p class="muted">Die Daten wurden für das Spiel aufbereitet (z.B. Haltestellen zusammengefasst, Fahrzeiten gemittelt).</p>`;
}

async function render() {
  const { l, email, mail: mailOn } = await info();
  const content = page === 'impressum' ? impressum(l, email) : page === 'datenschutz' ? datenschutz(l, email, mailOn) : page === 'regeln' ? regeln(email) : quellen();
  sheet.innerHTML = `<div class="acct-box legal-box-wrap">
    <div class="acct-top"><b>Rechtliches</b><button class="icon-btn" id="legal-close" aria-label="Schließen">✕</button></div>
    <div class="acct-tabs" role="tablist">${PAGES.map(([id, label]) => `<button role="tab" aria-selected="${id === page}" class="${id === page ? 'on' : ''}" data-page="${id}">${label}</button>`).join('')}</div>
    <div class="acct-body legal">${content}</div></div>`;
  sheet.querySelector('#legal-close')!.addEventListener('click', close);
  sheet.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((b) => b.addEventListener('click', () => ((page = b.dataset.page as LegalPage), void render())));
  bindLegalLinks(sheet);
  sheet.querySelector<HTMLElement>('.acct-body')!.scrollTop = 0;
}
