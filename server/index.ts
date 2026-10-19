// BimGuesser-Server: Netzdaten laden, App erstellen, auf PORT lauschen
import { createApp } from './app.ts';
import { Network } from './network.ts';

const PORT = Number(process.env.PORT ?? 3000);
const net = Network.load();
const { app } = createApp({ net, version: process.env.APP_VERSION ?? 'dev' });

app.listen(PORT, () => {
  const days = Object.entries(net.data.regularDays).map(([k, v]) => `${k}=${v.date}`).join(', ');
  console.log(`BimGuesser läuft auf http://localhost:${PORT}  (${net.data.stations.length} Stationen, Referenztage: ${days})`);
});
