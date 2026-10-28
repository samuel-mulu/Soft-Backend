/**
 * Production entry — finds dist/main.js whether cwd is repo root or (misconfigured) src/.
 */
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const candidates = [
  join(process.cwd(), 'dist', 'main.js'),
  join(process.cwd(), '..', 'dist', 'main.js'),
  join(process.cwd(), 'dist', 'src', 'main.js'),
];

const entry = candidates.find((p) => existsSync(p));

if (!entry) {
  console.error('[start] Cannot find compiled API entry. Checked:');
  for (const p of candidates) console.error(' ', p, existsSync(p) ? '(exists)' : '(missing)');
  console.error('[start] Fix Render: Root Directory must be EMPTY (not "src"). Build at repo root.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [entry], { stdio: 'inherit' });
process.exit(result.status ?? 1);
