// npm run release [patch|minor|major]  →  Tests + Klick-Durchlauf, nächster Tag v*, Push → GitHub baut das Image
// → Ditto aktualisiert sich.  "--skip-smoke" überspringt den Klick-Durchlauf (z.B. ohne Edge/Chrome).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const kind = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'patch') as 'patch' | 'minor' | 'major';
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Aufruf: npm run release [patch|minor|major]');
  process.exit(1);
}
// Releases nur von master – ein Tag auf einem Feature-Branch würde ungetesteten Stand als „latest“ ausliefern (Befund L-10)
const current = git('rev-parse', '--abbrev-ref', 'HEAD');
if (current !== 'master' && !process.argv.includes('--any-branch')) {
  console.error(`✖ Releases nur von master (aktuell: ${current}). Bewusst anders? --any-branch`);
  process.exit(1);
}
if (git('status', '--porcelain')) {
  console.error('✖ Es gibt nicht committete Änderungen – erst committen, dann releasen.');
  process.exit(1);
}

// erst prüfen, dann veröffentlichen: Typecheck, Tests und Klick-Durchlauf müssen grün sein
// npm_execpath setzt `npm run` selbst; sonst liegt npm neben node (Windows-Installation)
const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const npm = (script: string) => execFileSync(process.execPath, [npmCli, 'run', script], { stdio: 'inherit' });
try {
  console.log('▶ Typecheck …');
  npm('typecheck');
  console.log('▶ Tests …');
  npm('test');
  if (!process.argv.includes('--skip-smoke')) {
    console.log('▶ Klick-Durchlauf …');
    npm('smoke');
  }
} catch {
  console.error('\n✖ Prüfung fehlgeschlagen – kein Release.');
  process.exit(1);
}

// Tags vom Server holen – sonst würde eine schon vergebene Versionsnummer nochmal erzeugt
try {
  git('fetch', '--tags', '--quiet');
} catch {
  console.warn('⚠ Tags konnten nicht geholt werden (offline?) – nehme die lokalen.');
}
const last = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? 'v0.0.0';
const [maj, min, pat] = last.slice(1).split('.').map(Number);
const next = kind === 'major' ? `v${maj + 1}.0.0` : kind === 'minor' ? `v${maj}.${min + 1}.0` : `v${maj}.${min}.${pat + 1}`;

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`${last} → ${next}  (Branch ${branch})`);
git('tag', '-a', next, '-m', `Release ${next}`);
execFileSync('git', ['push', 'origin', branch], { stdio: 'inherit' });
execFileSync('git', ['push', 'origin', next], { stdio: 'inherit' });
console.log(`\n✔ ${next} gepusht. GitHub baut jetzt das Image (Actions-Tab), Ditto holt es sich innerhalb von ~2 min.`);
