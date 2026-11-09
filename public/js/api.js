import { BrowserProvider } from 'ethers';
import { DEFAULT_NETWORK, getNetwork } from './networks.js';
import { addressInput, hashInput } from './verification.js';

async function jsonRequest(url, options = {}, signal) {
  try {
    const response = await fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(16000)]) : AbortSignal.timeout(16000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed. Try again shortly.');
    return body;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Lookup cancelled', 'AbortError');
    if (error.name === 'TimeoutError') throw new Error('The service took too long. Please try again.');
    throw error;
  }
}
// ethers handles formatting and blockchain reads; transport goes through our restricted proxy.
function provider(signal, networkKey) {
  getNetwork(networkKey);
  return new BrowserProvider({ request: async ({ method, params }) => {
    const body = await jsonRequest('/api/rpc?network=' + encodeURIComponent(networkKey), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: params ?? [] }) }, signal);
    return body.result;
  } }, undefined, { cacheTimeout: -1 });
}
function readableError(error) {
  return new Error(error.info?.error?.message || error.error?.message || error.shortMessage || error.message || 'RPC lookup failed. Try again.');
}
export async function liveBalance(address, signal, networkKey = DEFAULT_NETWORK, asset = 'ETH') {
  if (asset === 'USDC') return BigInt((await jsonRequest('/api/usdc?network=' + encodeURIComponent(networkKey) + '&address=' + encodeURIComponent(addressInput(address)), {}, signal)).balance);
  const p = provider(signal, networkKey);
  try { return await p.getBalance(addressInput(address)); }
  catch (e) { throw readableError(e); }
  finally { p.destroy(); }
}
export async function livePayment(hash, signal, networkKey = DEFAULT_NETWORK, asset = 'ETH') {
  const p = provider(signal, networkKey);
  try {
    const cleanHash = hashInput(hash);
    const [transaction, receipt] = await Promise.all([p.getTransaction(cleanHash), p.getTransactionReceipt(cleanHash)]);
    let recipientCode = null;
    if (asset === 'ETH' && transaction?.to && receipt?.status === 1 && transaction.data === '0x') {
      recipientCode = await p.getCode(transaction.to, receipt.blockNumber);
    }
    if (asset === 'USDC') {
      const metadata = await jsonRequest('/api/usdc?network=' + encodeURIComponent(networkKey), {}, signal);
      const block = receipt ? await p.getBlockNumber() : 0;
      return { transaction, receipt, contractAddress: metadata.contractAddress, confirmations: receipt ? Math.max(0, block - receipt.blockNumber + 1) : 0 };
    }
    return { transaction, receipt, recipientCode };
  } catch (e) { throw readableError(e); }
  finally { p.destroy(); }
}
export async function liveHistory(address, signal, networkKey = DEFAULT_NETWORK, asset = 'ETH') {
  getNetwork(networkKey);
  return (await jsonRequest('/api/history?network=' + encodeURIComponent(networkKey) + '&asset=' + encodeURIComponent(asset) + '&address=' + encodeURIComponent(addressInput(address)), {}, signal)).transactions;
}
