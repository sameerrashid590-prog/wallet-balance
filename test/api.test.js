import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { HttpError } from '../lib/upstream.js';
import { liveBalance } from '../public/js/api.js';

test('ethers adapter preserves helpful server errors on failed live reads', async () => {
  const message = 'Cannot reach the external service. Check your connection and retry.';
  const app = createApp({ upstream: { rpc: async () => { throw new HttpError(502, message); } } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const originalFetch = globalThis.fetch;
  const base = 'http://127.0.0.1:' + app.address().port;
  globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, options);
  try {
    await assert.rejects(liveBalance('0x1111111111111111111111111111111111111111'), error => error.message === message);
  } finally {
    globalThis.fetch = originalFetch;
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
  }
});
