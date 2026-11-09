import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, 'public/vendor'), { recursive: true });
await copyFile(resolve(root, 'node_modules/ethers/dist/ethers.min.js'), resolve(root, 'public/vendor/ethers.js'));
const html = await readFile(resolve(root, 'public/index.html'), 'utf8');
if (!html.includes('wallet-connect-button') || html.includes('/api/sender/login')) throw new Error('Wallet-connected interface is missing.');
console.log('Built public wallet app and local ethers bundle. No environment files or signing data are copied.');
