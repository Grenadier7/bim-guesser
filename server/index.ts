// BimGuesser-Server: Netzdaten laden, App erstellen, auf PORT lauschen
import { createApp } from './app.ts';
import { cleanDiskCache } from './efa.ts';
import { Network } from './network.ts';

const PORT = Number(process.env.PORT ?? 3000);

// Sicherheitsnetz: ein übersehener Fehler in einer Hintergrund-Aufgabe darf nicht alle laufenden Spiele beenden
process.on('unhandledRejection', (e) => console.error(`[${new Date().toISOString()}] Unbehandelter Fehler:`, e));
const net = Network.load();
const { app } = createApp({ net, version: process.env.APP_VERSION ?? 'dev' });
for (const w of net.referenceWarnings()) console.warn(`⚠ ${w}`);

// Auskunfts-Cache aufräumen: kurz nach dem Start und dann täglich
const clean = () => void cleanDiskCache().then((n) => n && console.log(`Auskunfts-Cache: ${n} abgelaufene Einträge gelöscht`));
setTimeout(clean, 10_000).unref();
setInterval(clean, 24 * 3600 * 1000).unref();

const server = app.listen(PORT, () => {
  const days = Object.entries(net.data.regularDays).map(([k, v]) => `${k}=${v.date}`).join(', ');
  console.log(`BimGuesser läuft auf http://localhost:${PORT}  (${net.data.stations.length} Stationen, Referenztage: ${days})`);
});

// docker stop / Strg+C: Statistik sichern und sauber beenden (offene Live-Verbindungen halten den Prozess nicht auf)
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    net.saveUsage();
    server.close();
    process.exit(0);
  });
