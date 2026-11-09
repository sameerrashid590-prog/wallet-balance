import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createApiHandler, json } from './lib/public-api.js';
import { SECURITY_HEADERS } from './lib/security-headers.js';
const ROOT = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/styles.css', ['public/styles.css', 'text/css']],
  ...['app', 'api', 'verification', 'demo', 'networks', 'transfer-input', 'transfer-ui', 'assets', 'usdc-abi', 'usdc-verification', 'usdc-contracts', 'wallet-session', 'wallet-transfer', 'transfer-store'].map(name => ['/js/' + name + '.js', ['public/js/' + name + '.js', 'text/javascript']]),
  ['/vendor/ethers.js', ['node_modules/ethers/dist/ethers.min.js', 'text/javascript']],
]);
export function createApp(options = {}) {
  const api = createApiHandler(options);
  return http.createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const pathname = new URL(req.url, 'http://app.invalid').pathname;
      if (pathname.startsWith('/api/')) return api(req, res);
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      const asset = assets.get(pathname);
      if (!asset) return json(res, 404, { error: 'Page or endpoint not found.' });
      const data = await readFile(resolve(ROOT, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch { json(res, 500, { error: 'Could not load this file. Check the installation.' }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000), timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 12000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) { console.error('PORT must be 1–65535; REQUEST_TIMEOUT_MS must be 1000–15000.'); process.exit(1); }
  const server = createApp();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port is in use. Set another PORT in .env.' : 'Could not start server.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('EtherReceipt → http://localhost:' + port + ' (connected-wallet signing)'));
}
