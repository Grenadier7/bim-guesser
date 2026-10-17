// npm run release [patch|minor|major]  →  nächster Tag v*, Push → GitHub baut das Image → Ditto aktualisiert sich
import { execFileSync } from 'node:child_process';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const kind = (process.argv[2] ?? 'patch') as 'patch' | 'minor' | 'major';
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Aufruf: npm run release [patch|minor|major]');
  process.exit(1);
}
if (git('status', '--porcelain')) {
  console.error('✖ Es gibt nicht committete Änderungen – erst committen, dann releasen.');
  process.exit(1);
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
