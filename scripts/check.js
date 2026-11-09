import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function walk(folder) {
  const entries = await readdir(resolve(root, folder), { withFileTypes: true });
  for (const entry of entries) {
    const file = folder + '/' + entry.name;
    if (entry.isDirectory()) await walk(file);
    else if (file.endsWith('.js')) {
      const check = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
      if (check.error || check.status !== 0) { console.error(check.stderr || check.error?.message); process.exit(1); }
    }
  }
}
for (const folder of ['public/js', 'lib', 'api', 'test', 'scripts']) await walk(folder);
const serverCheck = spawnSync(process.execPath, ['--check', 'server.js'], { cwd: root, encoding: 'utf8' });
if (serverCheck.error || serverCheck.status !== 0) { console.error(serverCheck.stderr); process.exit(1); }
console.log('JavaScript syntax checks passed.');
const tests = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
process.exit(tests.status ?? 1);
