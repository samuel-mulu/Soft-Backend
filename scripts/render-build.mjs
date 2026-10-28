/**
 * Render production build. Works with Root Directory empty or "src".
 */
import { execSync } from 'child_process';
import { cpSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function findRepoRoot() {
  const candidates = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'nest-cli.json'))) {
        return dir;
      }
      const up = join(dir, '..');
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('[render-build] Could not find repo root (package.json + nest-cli.json)');
}

function findDistMain(repoRoot) {
  const paths = [
    join(repoRoot, 'dist', 'main.js'),
    join(repoRoot, 'src', 'dist', 'main.js'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

const repoRoot = findRepoRoot();
console.log('[render-build] repoRoot:', repoRoot);
console.log('[render-build] cwd:', process.cwd());

const env = { ...process.env, NPM_CONFIG_PRODUCTION: 'false' };

execSync('npm ci --include=dev', { cwd: repoRoot, stdio: 'inherit', env });
execSync('npx nest build', { cwd: repoRoot, stdio: 'inherit', env });

let mainPath = findDistMain(repoRoot);
if (!mainPath) {
  console.error('[render-build] nest build finished but dist/main.js not found.');
  console.error('[render-build] Checked:', join(repoRoot, 'dist', 'main.js'), join(repoRoot, 'src', 'dist', 'main.js'));
  process.exit(1);
}

console.log('[render-build] Built:', mainPath);

const srcDir = join(repoRoot, 'src');
const deployDist = join(srcDir, 'dist');
if (existsSync(join(srcDir, 'main.ts')) && !mainPath.includes(`${join('src', 'dist')}`)) {
  console.log('[render-build] Copying dist → src/dist (Render Root Directory = src)');
  rmSync(deployDist, { recursive: true, force: true });
  cpSync(join(repoRoot, 'dist'), deployDist, { recursive: true });
  mainPath = join(deployDist, 'main.js');
}

if (!existsSync(mainPath)) {
  console.error('[render-build] Missing entry after copy:', mainPath);
  process.exit(1);
}

console.log('[render-build] OK — use start command: npm run start:prod');
