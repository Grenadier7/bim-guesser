// E-Mail-Versand (Passwort-Reset): SMTP über SMTP_URL, z.B. smtp://user:pass@mail.example.org:587 oder
// smtps://…:465; Absender MAIL_FROM. Ohne SMTP_URL kein Versand (Reset ist dann aus) – außer MAIL_FILE (Entwicklung).
// Lokal mit docker compose: Mailpit fängt alles ab → http://localhost:8025
import { appendFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

export type SendMail = (to: string, subject: string, text: string) => Promise<void>;

export function smtpMailer(url = process.env.SMTP_URL, from = process.env.MAIL_FROM ?? 'BimGuesser <noreply@bimguesser.local>'): SendMail | undefined {
  // Entwicklung/Tests ohne Mailserver: MAIL_FILE=pfad → Mails als JSON-Zeilen in diese Datei
  const file = process.env.MAIL_FILE;
  if (!url && file) return async (to, subject, text) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), to, subject, text })}
`);
  if (!url) return undefined;
  let transport: ReturnType<typeof nodemailer.createTransport>;
  let host = '?';
  try {
    host = new URL(url).hostname;
    transport = nodemailer.createTransport(url);
  } catch (e) {
    // eine kaputte SMTP_URL darf den Server nie zum Absturz bringen – dann ist nur „Passwort vergessen“ aus
    console.error(`✖ SMTP_URL ist ungültig (${(e as Error).message}) – „Passwort vergessen“ ist aus.`);
    return undefined;
  }
  // gleich beim Start anmelden: im Log steht sofort, ob der Mailversand geht (Passwort steht nie im Log)
  if (process.env.NODE_ENV === 'production')
    transport.verify().then(
      () => console.log(`✔ Mailversand bereit (${host})`),
      (e: Error) => console.warn(`✖ Mailversand über ${host} geht nicht: ${e.message}`),
    );
  return async (to, subject, text) => {
    await transport.sendMail({ from, to, subject, text });
  };
}

/** Adresse fürs Log gekürzt: competitive.trust@gmail.com → co***@gmail.com */
export function maskEmail(mail: string): string {
  const [user, domain] = mail.split('@');
  return `${user.slice(0, 2)}***@${domain ?? ''}`;
}

/** öffentliche Adresse für Links in Mails – nie aus dem Host-Header (sonst könnte ein Angreifer den Link umlenken) */
export function publicUrl(): string | null {
  const u = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (u) return u;
  if (process.env.NGROK_URL) return process.env.NGROK_URL.replace(/\/+$/, '');
  if (process.env.NGROK_DOMAIN) return `https://${process.env.NGROK_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return null;
}
