import { createConfiguredUpstreams, HttpError } from './upstream.js';
import { createClientRateLimiter } from './rate-limit.js';
import { SECURITY_HEADERS } from './security-headers.js';
import { DEFAULT_NETWORK, NETWORKS, getNetwork } from '../public/js/networks.js';
export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(status === 429 ? { 'Retry-After': '60' } : {}) });
  res.end(JSON.stringify(value));
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
  if (Number(req.headers['content-length']) > 4096) throw new HttpError(413, 'Request is too large.');
  let value;
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') { try { value = JSON.parse(req.body.toString()); } catch { throw new HttpError(400, 'Send one valid JSON object.'); } }
    else value = req.body;
    if (Buffer.byteLength(JSON.stringify(value) || '') > 4096) throw new HttpError(413, 'Request is too large.');
  } else {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new HttpError(413, 'Request is too large.'); }
    try { value = JSON.parse(body); } catch { throw new HttpError(400, 'Send one valid JSON object.'); }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new HttpError(400, 'Send one valid JSON object.');
  if (Object.keys(value).some(key => !['method', 'params'].includes(key))) throw new HttpError(400, 'Only read-only RPC method and params are accepted.');
  return value;
}
export function createApiHandler({ upstream, upstreams, readLimit = createClientRateLimiter(), env = process.env } = {}) {
  let providers = upstreams;
  function selectProvider(key) {
    try { getNetwork(key); } catch (e) { throw new HttpError(400, e.message); }
    providers ??= upstream ? null : createConfiguredUpstreams({ env });
    return upstream ?? providers[key];
  }
  return async (req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://app.invalid');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-origin requests are not permitted.');
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, 'Invalid request origin.'); }
        if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new HttpError(403, 'Cross-origin requests are not permitted.');
      }
      const client = env.VERCEL === '1' ? String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
      readLimit(client);
      if (url.pathname === '/api/sender' || url.pathname.startsWith('/api/sender/')) throw new HttpError(410, 'Server signing has been removed. Connect your own wallet and approve transactions in that wallet.');
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'EtherReceipt', signing: 'connected-wallet', defaultNetwork: DEFAULT_NETWORK, networks: NETWORKS });
      const networkKey = url.searchParams.get('network') ?? DEFAULT_NETWORK;
      if (url.pathname === '/api/rpc' && req.method === 'POST') return json(res, 200, { result: await selectProvider(networkKey).rpc(await readJson(req)) });
      if (url.pathname === '/api/usdc' && req.method === 'GET') return json(res, 200, await selectProvider(networkKey).usdc(url.searchParams.get('address')));
      if (url.pathname === '/api/history' && req.method === 'GET') return json(res, 200, { transactions: await selectProvider(networkKey).history(url.searchParams.get('address'), url.searchParams.get('asset') ?? 'ETH') });
      if (['/api/health', '/api/rpc', '/api/usdc', '/api/history'].includes(url.pathname)) throw new HttpError(405, 'Method not allowed.');
      throw new HttpError(404, 'API endpoint not found.');
    } catch (e) { json(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'The service could not complete this lookup. Try again shortly.' }); }
  };
}
// The Vercel functions share this read-only entry point. No key store, signer,
// Basic authentication, submission journal or writable filesystem is used.
export const handler = createApiHandler();
