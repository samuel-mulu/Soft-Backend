/**
 * Render build when Root Directory is empty OR mistakenly set to "src".
 * Run as: node ../scripts/render-build.mjs (from src) OR npm run build:render (from repo root)
 */
import { execSync } from 'child_process';
import { cpSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('[render-build] repoRoot:', repoRoot);

execSync('npm ci', { cwd: repoRoot, stdio: 'inherit' });
execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });

const builtMain = join(repoRoot, 'dist', 'main.js');
if (!existsSync(builtMain)) {
  console.error('[render-build] Missing', builtMain);
  process.exit(1);
}

/** If Render Root Directory is "src", only src/ is deployed — mirror dist there */
const srcDir = join(repoRoot, 'src');
const nestSource = existsSync(join(srcDir, 'main.ts')) || existsSync(join(srcDir, 'app.module.ts'));
if (nestSource) {
  const dest = join(srcDir, 'dist');
  console.log('[render-build] Copying dist → src/dist (for Root Directory = src on Render)');
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(repoRoot, 'dist'), dest, { recursive: true });
}

console.log('[render-build] OK — dist/main.js at repo root; src/dist if needed');
