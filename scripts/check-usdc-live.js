// Real read-only checks. Never prepares, signs or broadcasts a transfer.
import { once } from 'node:events';
import { createApp } from '../server.js';
import { createConfiguredUpstreams } from '../lib/upstream.js';
import { createSender } from '../lib/sender.js';
import { getNetwork } from '../public/js/networks.js';
import { liveBalance, liveHistory, livePayment } from '../public/js/api.js';
import { verifyUsdcPayment } from '../public/js/usdc-verification.js';
import { formatAsset } from '../public/js/assets.js';
const keys = process.argv.length > 2 ? process.argv.slice(2) : ['mainnet', 'sepolia'];
const networks = keys.map(getNetwork);
const account = createSender().status().address;
const sample = '0x000000000000000000000000000000000000dEaD';
const app = createApp({ upstreams: createConfiguredUpstreams() });
app.listen(0, '127.0.0.1'); await once(app, 'listening');
const base = 'http://127.0.0.1:' + app.address().port;
const original = globalThis.fetch;
globalThis.fetch = (url, options) => original(typeof url === 'string' && url.startsWith('/') ? base + url : url, options);
async function check(key, label, action) {
  try { const result = await action(); const summary = Array.isArray(result) ? { count: result.length, newestHash: result[0]?.hash } : result?.receipt ? { hash: result.transaction?.hash, block: result.receipt.blockNumber, confirmations: result.confirmations } : result;
    console.log('PASS USDC ' + key + ' ' + label + ': ' + JSON.stringify(summary)); return result; }
  catch (e) { console.error('FAIL USDC ' + key + ' ' + label + ': ' + e.message); process.exitCode = 1; return null; }
}
try {
  for (const network of networks) {
    await check(network.key, 'contract and real balance', async () => {
      const balance = await liveBalance(account || sample, undefined, network.key, 'USDC');
      return { balance: formatAsset(balance, 'USDC'), wallet: account ? 'configured backend account' : 'public sample address' };
    });
    const history = await check(network.key, 'indexed token history', () => liveHistory(sample, undefined, network.key, 'USDC'));
    let proven = false;
    for (const candidate of (history || []).filter(tx => BigInt(tx.value) > 0n).slice(0, 20)) {
      const data = await check(network.key, 'receipt lookup', () => livePayment(candidate.hash, undefined, network.key, 'USDC'));
      if (!data) break;
      const result = verifyUsdcPayment({ recipient: candidate.to, sender: candidate.from, expected: formatAsset(BigInt(candidate.value), 'USDC'), hash: candidate.hash }, data, network);
      if (result.code === 'unsupported' || result.code === 'wrong-contract') continue;
      if (result.code !== 'exact') { console.error('FAIL USDC proof: ' + result.code); process.exitCode = 1; }
      else { console.log('PASS USDC ' + network.key + ' real Transfer event proof: ' + candidate.hash); proven = true; }
      break;
    }
    if (!proven) console.log('SKIP USDC ' + network.key + ' real payment proof: no directly supported transfer was proven in the recent history sample.');
  }
} finally { globalThis.fetch = original; app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }

