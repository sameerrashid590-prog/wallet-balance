import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../server.js';
import { createUpstream, validateRpc, normalizeHistory } from '../lib/upstream.js';
import { DEMO_WALLET } from '../public/js/demo.js';
const HASH = '0x' + 'ab'.repeat(32);
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const rpcResult = result => response({ jsonrpc: '2.0', id: 1, result });
test('RPC allowlist rejects writes, arbitrary reads, batches and malformed params', () => {
  for (const payload of [ { method: 'eth_sendRawTransaction', params: [HASH] }, { method: 'eth_call', params: [] }, { method: 'eth_getBalance', params: [DEMO_WALLET, 'pending'] }, { method: 'eth_getTransactionByHash', params: ['bad'] }, { method: 'eth_chainId', params: {} }, { method: 'eth_getCode', params: [DEMO_WALLET, '0x0001'] } ]) assert.throws(() => validateRpc(payload));
  for (const payload of [{ method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] }, { method: 'eth_getBalance', params: [DEMO_WALLET, 'latest'] }, { method: 'eth_getCode', params: [DEMO_WALLET, '0x1'] }, { method: 'eth_getTransactionReceipt', params: [HASH] }]) assert.doesNotThrow(() => validateRpc(payload));
});
test('RPC chain mismatch stops the data read', async () => {
  let calls = 0;
  const upstream = createUpstream({ networkKey: 'sepolia', fetchImpl: async () => { calls++; return rpcResult('0x1'); } });
  await assert.rejects(upstream.rpc({ method: 'eth_getBalance', params: [DEMO_WALLET, 'latest'] }), /network mismatch/);
  assert.equal(calls, 1);
});
test('verified Sepolia reads and null transaction work', async () => {
  const calls = [];
  const upstream = createUpstream({ networkKey: 'sepolia', fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload.method);
    return rpcResult(payload.method === 'eth_chainId' ? '0xaa36a7' : null);
  } });
  assert.equal(await upstream.rpc({ method: 'eth_getTransactionByHash', params: [HASH] }), null);
  assert.deepEqual(calls, ['eth_chainId', 'eth_getTransactionByHash']);
});
test('HTTP and JSON RPC rate limits have helpful errors', async () => {
  for (const fetchImpl of [async () => new Response('', { status: 429 }), async () => response({ error: { code: -32005, message: 'too many requests' } })]) {
    await assert.rejects(createUpstream({ networkKey: 'sepolia', fetchImpl }).rpc({ method: 'eth_chainId', params: [] }), error => error.status === 429 && /rate limit/.test(error.message));
  }
});
test('timeouts and inaccessible upstreams do not leak credentials', async () => {
  const upstream = createUpstream({ networkKey: 'sepolia', rpcUrl: 'https://example.com/SECRET', fetchImpl: async () => { throw new DOMException('SECRET', 'TimeoutError'); } });
  await assert.rejects(upstream.rpc({ method: 'eth_chainId', params: [] }), error => /timed out/.test(error.message) && !/SECRET/.test(error.message));
});
test('history uses descending first page of 20 and keeps optional keys server-side', async () => {
  let queried;
  const upstream = createUpstream({ networkKey: 'sepolia', apiKey: 'fixture-key', fetchImpl: async url => { queried = new URL(url); return response({ status: '0', message: 'No transactions found', result: [] }); } });
  assert.deepEqual(await upstream.history(DEMO_WALLET), []);
  assert.equal(queried.searchParams.get('sort'), 'desc'); assert.equal(queried.searchParams.get('offset'), '20'); assert.equal(queried.searchParams.get('apikey'), 'fixture-key');
  assert.equal(queried.origin, 'https://api.blockscout.com'); assert.equal(queried.searchParams.get('chain_id'), '11155111');
});
test('explorer failure is not mistaken for empty history', () => {
  assert.throws(() => normalizeHistory({ status: '0', message: 'NOTOK', result: 'rate limit' }, DEMO_WALLET), error => error.status === 429);
  assert.throws(() => normalizeHistory({ status: '0', message: 'NOTOK', result: [] }, DEMO_WALLET), /could not return/);
});
test('history preserves failed and unknown execution status', () => {
  const base = { hash: HASH, from: DEMO_WALLET, to: DEMO_WALLET, value: '5', timeStamp: '1793941200', input: '0x' };
  const txs = normalizeHistory({ status: '1', result: [{ ...base, isError: '1', txreceipt_status: '0' }, base] }, DEMO_WALLET);
  assert.deepEqual(txs.map(t => t.status), ['failed', 'unknown']);
  assert.throws(() => normalizeHistory({ status: '1', result: [{ ...base, hash: '<script>' }] }, DEMO_WALLET));
});
test('normal HTTP entry points, safe serving, independent services and origin guards', async t => {
  const app = createApp({ upstream: {
    rpc: async payload => { validateRpc(payload); return payload.method === 'eth_chainId' ? '0xaa36a7' : '0x0'; },
    history: async () => { const error = new Error('fixture'); throw error; },
  } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const base = 'http://127.0.0.1:' + app.address().port;
  for (const asset of ['/', '/styles.css', '/js/app.js', '/js/demo.js', '/js/api.js', '/js/verification.js', '/js/networks.js', '/js/transfer-input.js', '/js/wallet-session.js', '/js/wallet-transfer.js', '/js/transfer-store.js', '/js/usdc-contracts.js', '/js/transfer-ui.js', '/vendor/ethers.js', '/api/health']) {
    const result = await fetch(base + asset); assert.equal(result.status, 200, asset);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await result.text()).length > 0);
  }
  for (const hidden of ['/.env', '/server.js', '/package.json', '/node_modules/ethers/package.json', '/%2e%2e/.env']) assert.equal((await fetch(base + hidden)).status, 404);
  assert.equal((await fetch(base + '/api/history?address=' + DEMO_WALLET)).status, 500);
  const rpc = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'eth_getBalance', params: [DEMO_WALLET, 'latest'] }) });
  assert.deepEqual(await rpc.json(), { result: '0x0' });
  assert.equal((await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' })).status, 400);
  assert.equal((await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHostStatus, 200);
});

test('keyless history uses the public Sepolia instance without a key', async () => {
  let queried;
  const upstream = createUpstream({ networkKey: 'sepolia', fetchImpl: async url => { queried = new URL(url); return response({ status: '1', result: [] }); } });
  assert.deepEqual(await upstream.history(DEMO_WALLET), []);
  assert.equal(queried.origin, 'https://eth-sepolia.blockscout.com');
  assert.equal(queried.searchParams.has('apikey'), false);
});

const MINED_RECEIPT = { transactionHash: HASH, status: '0x1', blockNumber: '0xb863ad', blockHash: '0x' + 'cd'.repeat(32), logs: [] };
test('transaction reads recover from stale or failed primary RPCs using a chain-checked fallback', async () => {
  for (const primaryResult of ['missing', 'error']) {
    const calls = [];
    const upstream = createUpstream({ networkKey: 'sepolia', rpcUrl: 'https://primary.example', fallbackRpcUrls: ['https://secondary.example'], fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push([url, payload.method]);
      if (payload.method === 'eth_chainId') return rpcResult('0xaa36a7');
      if (url === 'https://primary.example') {
        if (primaryResult === 'error') throw new Error('SECRET provider failure');
        return rpcResult(null);
      }
      return rpcResult(payload.method === 'eth_getTransactionReceipt' ? MINED_RECEIPT : { hash: HASH });
    } });
    assert.deepEqual(await upstream.rpc({ method: 'eth_getTransactionReceipt', params: [HASH] }), MINED_RECEIPT);
    assert.deepEqual(await upstream.rpc({ method: 'eth_getTransactionByHash', params: [HASH] }), { hash: HASH });
    for (const url of ['https://primary.example', 'https://secondary.example']) assert.ok(calls.some(([endpoint, method]) => endpoint === url && method === 'eth_chainId'));
  }
});
test('fallbacks cannot turn wrong-network, unrelated or incomplete receipts into confirmation', async () => {
  for (const invalid of ['chain', 'hash', 'status', 'block']) {
    let fallbackReads = 0;
    const upstream = createUpstream({ networkKey: 'sepolia', rpcUrl: 'https://primary.example', fallbackRpcUrls: ['https://secondary.example'], fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      if (payload.method === 'eth_chainId') return rpcResult(url === 'https://secondary.example' && invalid === 'chain' ? '0x1' : '0xaa36a7');
      if (url === 'https://primary.example') return rpcResult(null);
      fallbackReads++;
      return rpcResult({ ...MINED_RECEIPT, ...(invalid === 'hash' ? { transactionHash: '0x' + 'ef'.repeat(32) } : invalid === 'status' ? { status: null } : invalid === 'block' ? { blockNumber: null } : {}) });
    } });
    assert.equal(await upstream.rpc({ method: 'eth_getTransactionReceipt', params: [HASH] }), null);
    if (invalid === 'chain') assert.equal(fallbackReads, 0);
  }
});
test('a healthy fallback cancels a hung primary without waiting for its timeout', async () => {
  let aborted = false;
  const upstream = createUpstream({ networkKey: 'sepolia', rpcUrl: 'https://primary.example', fallbackRpcUrls: ['https://secondary.example'], fetchImpl: async (url, options) => {
    if (url === 'https://primary.example') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('cancelled', 'AbortError')); }, { once: true }));
    return rpcResult(JSON.parse(options.body).method === 'eth_chainId' ? '0xaa36a7' : MINED_RECEIPT);
  } });
  assert.deepEqual(await upstream.rpc({ method: 'eth_getTransactionReceipt', params: [HASH] }), MINED_RECEIPT);
  assert.equal(aborted, true);
});
test('fallback failure never fabricates a receipt, leaks provider errors or enables writes', async () => {
  let calls = 0;
  const upstream = createUpstream({ networkKey: 'sepolia', rpcUrl: 'https://primary.example/SECRET', fallbackRpcUrls: ['https://secondary.example'], fetchImpl: async () => { calls++; throw new Error('SECRET'); } });
  await assert.rejects(upstream.rpc({ method: 'eth_getTransactionReceipt', params: [HASH] }), e => e.status === 502 && !e.message.includes('SECRET'));
  const before = calls;
  await assert.rejects(upstream.rpc({ method: 'eth_sendRawTransaction', params: [HASH] }), /read-only/);
  assert.equal(calls, before);
});

test('a mined fallback transaction wins over a stale primary pending transaction', async () => {
  const pending = { hash: HASH, blockNumber: null, blockHash: null };
  const mined = { hash: HASH, blockNumber: MINED_RECEIPT.blockNumber, blockHash: MINED_RECEIPT.blockHash };
  for (const fallbackValue of [mined, null]) {
    const upstream = createUpstream({ networkKey: 'sepolia', rpcUrl: 'https://primary.example', fallbackRpcUrls: ['https://secondary.example'], fetchImpl: async (url, options) => rpcResult(JSON.parse(options.body).method === 'eth_chainId' ? '0xaa36a7' : url === 'https://primary.example' ? pending : fallbackValue) });
    assert.deepEqual(await upstream.rpc({ method: 'eth_getTransactionByHash', params: [HASH] }), fallbackValue ? mined : pending);
  }
});
