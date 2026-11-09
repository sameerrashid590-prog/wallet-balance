// Real checks use the same network-specific HTTP API and ethers adapter as the UI.
import { once } from 'node:events';
import { formatEther } from 'ethers';
import { createApp } from '../server.js';
import { createConfiguredUpstreams } from '../lib/upstream.js';
import { NETWORKS, getNetwork } from '../public/js/networks.js';
import { liveBalance, liveHistory, livePayment } from '../public/js/api.js';
import { verifyPayment } from '../public/js/verification.js';
const networks = process.argv.length > 2 ? process.argv.slice(2).map(getNetwork) : NETWORKS;
const app = createApp({ upstreams: createConfiguredUpstreams() });
app.listen(0, '127.0.0.1'); await once(app, 'listening');
const base = 'http://127.0.0.1:' + app.address().port;
const wallet = '0x000000000000000000000000000000000000dEaD';
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, options);
async function check(network, name, action) {
  try { const value = await action(); console.log('PASS live ' + network.key + ' ' + name + ': ' + JSON.stringify(value)); return value; }
  catch (error) { console.error('FAIL live ' + network.key + ' ' + name + ': ' + error.message); process.exitCode = 1; return null; }
}
try {
  for (const network of networks) {
    await check(network, 'chain ID', async () => {
      const response = await fetch(base + '/api/rpc?network=' + network.key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'eth_chainId', params: [] }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.result;
    });
    await check(network, 'ethers balance', async () => formatEther(await liveBalance(wallet, undefined, network.key)) + ' ETH');
    let transactions;
    await check(network, 'normal history', async () => { transactions = await liveHistory(wallet, undefined, network.key); return { count: transactions.length, newestHash: transactions[0]?.hash ?? null }; });
    const direct = tx => tx.status === 'success' && tx.input === '0x' && tx.to;
    const candidate = transactions?.find(tx => direct(tx) && BigInt(tx.value) > 0n) ?? transactions?.find(direct);
    if (candidate) await check(network, 'ethers payment verification', async () => {
      const data = await livePayment(candidate.hash, undefined, network.key);
      const result = verifyPayment({ hash: candidate.hash, recipient: candidate.to, expected: BigInt(candidate.value) === 0n ? '0.000000000000000001' : formatEther(BigInt(candidate.value)) }, data, { networkName: network.name, chainId: network.chainId });
      return { hash: candidate.hash, decision: result.code, executionStatus: data.receipt?.status, message: result.message };
    });
    else console.log('SKIP live ' + network.key + ' payment: no successful plain ETH transaction in the history sample.');
  }
} finally { globalThis.fetch = originalFetch; app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
