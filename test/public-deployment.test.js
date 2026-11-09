import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createApiHandler } from '../lib/public-api.js';
import { SECURITY_HEADERS } from '../lib/security-headers.js';
import { createClientRateLimiter } from '../lib/rate-limit.js';
import { createTransferStore } from '../public/js/transfer-store.js';
const FROM = '0x1111111111111111111111111111111111111111', TO = '0x2222222222222222222222222222222222222222';
test('Vercel parsed request bodies and externally hosted same-origin calls reach only validated read APIs', async () => {
  const calls = [];
  const handler = createApiHandler({ upstream: { rpc: async body => { calls.push(body); return '0x1'; } } });
  const app = http.createServer((req, res) => { req.body = { method: 'eth_chainId', params: [] }; return handler(req, res); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: app.address().port, path: '/api/rpc', method: 'POST', headers: { host: 'payments.example', origin: 'https://payments.example', 'content-type': 'application/json' } }, result => {
        let body = ''; result.on('data', chunk => { body += chunk; }); result.on('end', () => resolve({ status: result.statusCode, headers: result.headers, body: JSON.parse(body) }));
      });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(response.status, 200); assert.deepEqual(response.body, { result: '0x1' }); assert.deepEqual(calls, [{ method: 'eth_chainId', params: [] }]);
    assert.equal(response.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy']);
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});
test('API budgets isolate visitors and expire without blocking everyone after one client reaches its limit', () => {
  let now = 0; const limit = createClientRateLimiter({ now: () => now, limit: 1, maxClients: 2 });
  limit('visitor-a'); assert.throws(() => limit('visitor-a'), e => e.status === 429); assert.doesNotThrow(() => limit('visitor-b'));
  now = 60000; assert.doesNotThrow(() => limit('visitor-a')); assert.doesNotThrow(() => limit('visitor-c'));
});
test('Vercel deployment serves static output and excludes local keys, history and retired signers', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.outputDirectory, 'public'); assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.headers[0].headers.find(item => item.key === 'Content-Security-Policy').value, SECURITY_HEADERS['Content-Security-Policy']);
  const ignored = await readFile(new URL('../.vercelignore', import.meta.url), 'utf8');
  for (const path of ['.env*', 'data/', 'artifacts/', 'lib/sender.js', 'lib/journal.js', 'lib/auth.js']) assert.ok(ignored.split(/\r?\n/).includes(path), path);
  for (const file of ['health', 'rpc', 'usdc', 'history']) assert.equal(typeof (await import('../api/' + file + '.js')).default, 'function');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8'); const api = await readFile(new URL('../lib/public-api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server + api, /createSender|createJournal|WALLET_PRIVATE_KEY|SIGNING_PASSWORD/);
  for (const file of await readdir(new URL('../public/js/', import.meta.url))) {
    const source = await readFile(new URL('../public/js/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /WALLET_PRIVATE_KEY|SIGNING_PASSWORD|eth_signTransaction|eth_signTypedData|personal_sign|wallet_importRawKey/);
  }
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('wallet-connect-button')); assert.doesNotMatch(html, /api\/sender|Unlock sending|BACKEND ACCOUNT/);
});
test('public recovery records remain isolated by account and chain and corrupted storage fails closed', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = createTransferStore(storage);
  const base = { id: 'review-1', from: FROM, to: TO, asset: 'ETH', nonce: 0, networkKey: 'mainnet', amountUnits: '1', transaction: { to: TO, value: '0x1', data: '0x' }, hash: null, state: 'wallet-prompt' };
  store.save(base); store.save({ ...base, id: 'review-2', networkKey: 'sepolia' });
  assert.equal(store.unresolved(FROM, 'mainnet').length, 1); assert.equal(store.unresolved(TO, 'mainnet').length, 0); assert.equal(store.unresolved(FROM, 'sepolia').length, 1);
  store.save({ ...base, state: 'success' }); assert.equal(store.unresolved(FROM, 'mainnet').length, 0);
  for (const value of values.values()) assert.ok(!value.includes('privateKey'));
  values.set('etherreceipt-wallet-transfers-v1', 'invalid'); assert.throws(() => store.records(), /storage is unavailable/);
});
