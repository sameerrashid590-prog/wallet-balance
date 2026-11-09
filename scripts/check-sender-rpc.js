// Read-only preflight check. No private key, signing or transaction broadcast.
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { NETWORKS, getNetwork } from '../public/js/networks.js';
import { configuredRpcUrl } from '../lib/upstream.js';
const networks = process.argv.length > 2 ? process.argv.slice(2).map(getNetwork) : NETWORKS;
const from = '0x000000000000000000000000000000000000dEaD';
const to = '0x2222222222222222222222222222222222222222';
for (const network of networks) {
  const request = new FetchRequest(configuredRpcUrl(network.key)); request.timeout = 12000;
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const actual = await provider.send('eth_chainId', []);
    if (BigInt(actual) !== BigInt(network.chainId)) throw new Error('RPC chain ID mismatch');
    const [fees, balance, nonce, code, gas] = await Promise.all([
      provider.getFeeData(), provider.getBalance(from, 'pending'), provider.getTransactionCount(from, 'pending'),
      provider.getCode(to, 'latest'), provider.estimateGas({ from, to, value: 1n, data: '0x' }),
    ]);
    if (code !== '0x' || gas <= 0n || (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) <= 0n) throw new Error('Unusable code/gas/fee data');
    console.log('PASS read-only sender preflight ' + network.key + ': ' + JSON.stringify({ chainId: actual, gasEstimate: gas.toString(), pendingNonce: nonce, pendingBalanceAvailable: balance >= 0n, feeQuoteAvailable: true }));
  } catch { console.error('FAIL read-only sender preflight ' + network.key + ': required RPC read/estimate is unavailable. No transaction was signed or sent.'); process.exitCode = 1; }
  finally { provider.destroy(); }
}
