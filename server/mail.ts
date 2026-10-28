// E-Mail-Versand (Passwort-Reset): SMTP über SMTP_URL, z.B. smtp://user:pass@mail.example.org:587 oder
// smtps://…:465; Absender MAIL_FROM. Ohne SMTP_URL kein Versand (Reset ist dann aus).
// Lokal mit docker compose: Mailpit fängt alles ab → http://localhost:8025
import nodemailer from 'nodemailer';

export type SendMail = (to: string, subject: string, text: string) => Promise<void>;

export function smtpMailer(url = process.env.SMTP_URL, from = process.env.MAIL_FROM ?? 'BimGuesser <noreply@bimguesser.local>'): SendMail | undefined {
  if (!url) return undefined;
  const transport = nodemailer.createTransport(url);
  return async (to, subject, text) => {
    await transport.sendMail({ from, to, subject, text });
  };
}

/** öffentliche Adresse für Links in Mails – nie aus dem Host-Header (sonst könnte ein Angreifer den Link umlenken) */
export function publicUrl(): string | null {
  const u = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (u) return u;
  if (process.env.NGROK_URL) return process.env.NGROK_URL.replace(/\/+$/, '');
  if (process.env.NGROK_DOMAIN) return `https://${process.env.NGROK_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return null;
}
