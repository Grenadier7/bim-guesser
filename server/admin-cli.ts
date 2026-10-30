// Admin-Rechte über die Kommandozeile – bewusst nicht über die Webseite (wer Zugriff auf den Server hat, entscheidet)
//
//   lokal:      npm run admin -- list | grant <Name> | revoke <Name>
//   Container:  docker exec oeffi-guesser node server/admin-cli.ts grant <Name>
//
// Arbeitet direkt auf STATE_DIR/accounts.db und darf laufen, während der Server läuft (SQLite mit WAL).
import { AccountAdmin, Accounts } from './accounts.ts';
import { Network } from './network.ts';

const [cmd, name] = process.argv.slice(2);
const usage = () => {
  console.log('Aufruf: admin-cli.ts list | grant <Benutzername> | revoke <Benutzername>');
  process.exit(1);
};

const accounts = new Accounts(Network.load());
const admin = new AccountAdmin(accounts);
try {
  if (cmd === 'list') {
    const list = admin.admins();
    console.log(list.length ? `Admins: ${list.join(', ')}` : 'Noch keine Admins.');
  } else if ((cmd === 'grant' || cmd === 'revoke') && name) {
    const n = admin.setAdmin(name, cmd === 'grant');
    console.log(cmd === 'grant' ? `✔ ${n} ist jetzt Admin – nach dem nächsten Laden der Seite gibt es im Account-Fenster „Admin“.` : `✔ ${n} ist kein Admin mehr.`);
  } else usage();
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  accounts.close();
}
