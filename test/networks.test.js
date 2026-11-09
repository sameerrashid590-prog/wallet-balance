import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { NETWORKS, DEFAULT_NETWORK, getNetwork } from '../public/js/networks.js';
import { createUpstream, createConfiguredUpstreams } from '../lib/upstream.js';
import { createApp } from '../server.js';
import { liveBalance, liveHistory, livePayment } from '../public/js/api.js';
import { scenarios, DEMO_WALLET } from '../public/js/demo.js';
import { verifyPayment } from '../public/js/verification.js';
const rpcResponse = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
const historyHosts = { mainnet: 'eth.blockscout.com', sepolia: 'eth-sepolia.blockscout.com', hoodi: 'eth-hoodi.blockscout.com' };
test('registry contains Ethereum Mainnet, Sepolia and Hoodi only; mainnet is default', () => {
  assert.equal(DEFAULT_NETWORK, 'mainnet');
  assert.deepEqual(NETWORKS.map(n => n.chainId), [1, 11155111, 560048]);
  assert.equal(getNetwork().testnet, false);
  for (const bad of ['bitcoin', 'base', 'https://evil.example', '__proto__', 'constructor', '']) assert.throws(() => getNetwork(bad));
});
for (const network of NETWORKS) {
  test(network.name + ': chain ID must match before forwarding reads', async () => {
    const calls = [];
    const upstream = createUpstream({ networkKey: network.key, fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body); calls.push(payload.method);
      return rpcResponse(payload.method === 'eth_chainId' ? '0x' + network.chainId.toString(16) : '0x0');
    } });
    assert.equal(await upstream.rpc({ method: 'eth_getBalance', params: [DEMO_WALLET, 'latest'] }), '0x0');
    assert.deepEqual(calls, ['eth_chainId', 'eth_getBalance']);
    const wrong = createUpstream({ networkKey: network.key, fetchImpl: async () => rpcResponse('0x' + (network.chainId + 1).toString(16)) });
    await assert.rejects(wrong.rpc({ method: 'eth_getBalance', params: [DEMO_WALLET, 'latest'] }), /network mismatch/);
  });
  test(network.name + ': history selects its own explorer and keyed chain ID', async () => {
    for (const apiKey of ['', 'mock-key']) {
      let url;
      const upstream = createUpstream({ networkKey: network.key, apiKey, fetchImpl: async value => { url = new URL(value); return new Response(JSON.stringify({ status: '1', result: [] })); } });
      await upstream.history(DEMO_WALLET);
      assert.equal(url.hostname, apiKey ? 'api.blockscout.com' : historyHosts[network.key]);
      assert.equal(url.searchParams.get('offset'), '20');
      if (apiKey) assert.equal(url.searchParams.get('chain_id'), String(network.chainId));
    }
  });
}
test('server configuration isolates RPC credentials by network', async () => {
  const urls = [];
  const upstreams = createConfiguredUpstreams({ env: { MAINNET_RPC_URL: 'https://example.com/main', SEPOLIA_RPC_URL: 'https://example.com/sep', HOODI_RPC_URL: 'https://example.com/hood' }, fetchImpl: async (url, options) => {
    urls.push(url); const chain = url.endsWith('main') ? 1 : url.endsWith('sep') ? 11155111 : 560048;
    return rpcResponse('0x' + chain.toString(16));
  } });
  for (const network of NETWORKS) await upstreams[network.key].rpc({ method: 'eth_chainId', params: [] });
  assert.deepEqual(urls, ['https://example.com/main', 'https://example.com/sep', 'https://example.com/hood']);
});
test('UI API adapter routes independent balances/history through selected-network HTTP endpoints', async () => {
  const calls = [];
  const upstreams = Object.fromEntries(NETWORKS.map(network => [network.key, createUpstream({ networkKey: network.key, fetchImpl: async (url, options) => {
    if (!options.method) { calls.push(network.key + ':history'); return new Response(JSON.stringify({ status: '1', result: [] })); }
    const payload = JSON.parse(options.body); calls.push(network.key + ':' + payload.method);
    return rpcResponse(['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(payload.method) ? null : '0x' + network.chainId.toString(16));
  } })]));
  const app = createApp({ upstreams }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, options);
  try {
    for (const network of NETWORKS) {
      assert.equal(await liveBalance(DEMO_WALLET, undefined, network.key), BigInt(network.chainId));
      assert.deepEqual(await liveHistory(DEMO_WALLET, undefined, network.key), []);
      assert.deepEqual(await livePayment('0x' + 'aa'.repeat(32), undefined, network.key), { transaction: null, receipt: null, recipientCode: null });
      assert.ok(calls.includes(network.key + ':eth_getTransactionByHash'));
      assert.ok(calls.includes(network.key + ':eth_getTransactionReceipt'));
      assert.ok(calls.includes(network.key + ':eth_getBalance'));
      assert.ok(calls.includes(network.key + ':history'));
    }
    for (const key of ['base', 'https://evil.example', '__proto__']) {
      const r = await fetch(base + '/api/rpc?network=' + encodeURIComponent(key), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'eth_chainId', params: [] }) });
      assert.equal(r.status, 400);
    }
    const health = await fetch(base + '/api/health').then(r => r.json());
    assert.equal(health.defaultNetwork, 'mainnet');
    assert.deepEqual(health.networks.map(n => n.chainId), [1, 11155111, 560048]);
    assert.equal(JSON.stringify(health).includes('RPC_URL'), false);
  } finally { globalThis.fetch = originalFetch; app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});
test('payment verifier rejects a transaction from a different selected chain', () => {
  const exact = scenarios[0];
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, transaction: { ...exact.data.transaction, chainId: 11155111n } }, { networkName: 'Ethereum Mainnet', chainId: 1 }), /chain ID/);
  const missing = verifyPayment(exact.input, { transaction: null, receipt: null }, { networkName: 'Ethereum Hoodi', chainId: 560048 });
  assert.match(missing.message, /Ethereum Hoodi/);
  assert.doesNotMatch(missing.message, /Sepolia/);
});

test('legacy transactions without a signed chain ID use RPC chain verification', () => {
  const exact = scenarios[0];
  assert.equal(verifyPayment(exact.input, { ...exact.data, transaction: { ...exact.data.transaction, type: 0, chainId: 0n } }, { networkName: 'Ethereum Mainnet', chainId: 1 }).code, 'exact');
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, transaction: { ...exact.data.transaction, type: 2, chainId: 0n } }, { networkName: 'Ethereum Mainnet', chainId: 1 }), /chain ID/);
});
