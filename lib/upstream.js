import { isAddress } from 'ethers';
import { checkedUsdc, usdcBalance, usdcAddress } from './usdc.js';
import { getNetwork, NETWORKS, DEFAULT_NETWORK } from '../public/js/networks.js';
const SERVICES = Object.freeze({
  mainnet: { fallbackRpc: 'https://eth.drpc.org', rpc: 'https://ethereum-rpc.publicnode.com', history: 'https://eth.blockscout.com/api', rpcEnv: 'MAINNET_RPC_URL' },
  sepolia: { fallbackRpc: 'https://rpc.sepolia.ethpandaops.io', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', history: 'https://eth-sepolia.blockscout.com/api', rpcEnv: 'SEPOLIA_RPC_URL' },
  hoodi: { fallbackRpc: 'https://rpc.hoodi.ethpandaops.io', rpc: 'https://ethereum-hoodi-rpc.publicnode.com', history: 'https://eth-hoodi.blockscout.com/api', rpcEnv: 'HOODI_RPC_URL' },
});
export const KEYED_HISTORY_URL = 'https://api.blockscout.com/v2/api';
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && isAddress(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
export function validateRpc({ method, params }) {
  if (!Array.isArray(params)) throw new HttpError(400, 'RPC params must be an array.');
  const noParams = ['eth_chainId', 'eth_blockNumber'].includes(method) && params.length === 0;
  const byHash = ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method) && params.length === 1 && hash(params[0]);
  const balance = method === 'eth_getBalance' && params.length === 2 && address(params[0]) && params[1] === 'latest';
  const code = method === 'eth_getCode' && params.length === 2 && address(params[0]) && (params[1] === 'latest' || /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(params[1]));
  if (!(noParams || byHash || balance || code)) throw new HttpError(400, 'Only the app’s allowlisted, validated read-only RPC methods are permitted.');
}
export function normalizeHistory(body, requestedAddress) {
  if (body.status === '0' && Array.isArray(body.result) && body.result.length === 0 && /no transactions found/i.test(body.message)) return [];
  if (body.status !== '1' || !Array.isArray(body.result)) {
    const rateLimited = /rate|limit|too many/i.test(String(body.message) + String(body.result));
    throw new HttpError(rateLimited ? 429 : 502, rateLimited ? 'Explorer rate limit reached. Wait a moment and retry wallet lookup.' : 'Explorer could not return history. Balance and payment checks can still work.');
  }
  return body.result.slice(0, 20).map(tx => {
    if (!hash(tx.hash) || !address(tx.from) || (tx.to !== '' && tx.to !== null && !address(tx.to)) || !/^\d+$/.test(tx.value) || !/^\d+$/.test(tx.timeStamp) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input)) {
      throw new HttpError(502, 'Explorer returned incomplete transaction data. Try again later.');
    }
    if (![tx.from, tx.to, tx.contractAddress].some(a => a?.toLowerCase() === requestedAddress.toLowerCase())) throw new HttpError(502, 'Explorer returned unrelated transactions.');
    const status = tx.isError === '1' || tx.txreceipt_status === '0' ? 'failed' : tx.txreceipt_status === '1' ? 'success' : 'unknown';
    return { hash: tx.hash, from: tx.from, to: tx.to || null, value: tx.value, timeStamp: tx.timeStamp, status, input: tx.input };
  });
}
export function createUpstream({ networkKey = DEFAULT_NETWORK, rpcUrl, fallbackRpcUrls = [], apiKey = '', timeoutMs = 12000, fetchImpl = fetch, env = process.env } = {}) {
  const network = getNetwork(networkKey);
  const services = SERVICES[network.key];
  rpcUrl ??= services.rpc;
  const configured = new URL(rpcUrl);
  if (!['https:', 'http:'].includes(configured.protocol)) throw new Error('RPC URL must use HTTP or HTTPS.');
  async function request(url, options = {}) {
    try {
      const response = await fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (response.status === 429) throw new HttpError(429, 'Upstream rate limit reached. Wait a moment and retry.');
      if (response.status === 401 || response.status === 403) throw new HttpError(502, 'External service denied access. Check server API credentials, provider access, or explorer migration details in README.');
      if (!response.ok) throw new HttpError(502, 'External service is unavailable. Try again later or use Demo mode.');
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 3_000_000) throw new HttpError(502, 'External service response was too large.');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, error.name === 'TimeoutError' ? 'External service timed out. Retry or use Demo mode.' : 'Cannot reach the external service. Check your connection or use Demo mode.');
    }
  }
  async function rpcCall(method, params, endpoint = rpcUrl, signal) {
    const body = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal });
    if (body.error) {
      const rate = body.error.code === -32005 || /rate|limit|too many/i.test(body.error.message || '');
      throw new HttpError(rate ? 429 : 502, rate ? 'RPC rate limit reached. Wait and retry.' : 'RPC rejected the lookup. Try another RPC URL for the selected Ethereum network.');
    }
    if (body.jsonrpc !== '2.0' || body.id !== 1 || !Object.hasOwn(body, 'result')) throw new HttpError(502, 'Malformed response from RPC service.');
    return body.result;
  }
  return {
    async rpc(payload) {
      validateRpc(payload);
      // Fallbacks are read-only, server-selected and independently chain checked.
      // Query in parallel so an unresponsive RPC cannot hide a mined receipt or
      // add another full timeout before the browser can see the result.
      const byHash = ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(payload.method);
      const endpoints = byHash ? [...new Set([rpcUrl, ...fallbackRpcUrls])] : [rpcUrl];
      let notFound = false;
      let pendingTransaction = null;
      const controllers = endpoints.map(() => new AbortController());
      const lookups = endpoints.map(async (endpoint, index) => {
        const signal = AbortSignal.any([controllers[index].signal, AbortSignal.timeout(timeoutMs)]);
        const chain = await rpcCall('eth_chainId', [], endpoint, signal);
        if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== BigInt(network.chainId)) throw new HttpError(502, 'RPC network mismatch: ' + network.name + ' (chain ID ' + network.chainId + ') is required.');
        const value = payload.method === 'eth_chainId' ? chain : await rpcCall(payload.method, payload.params, endpoint, signal);
        if (byHash && value !== null) {
          const returnedHash = payload.method === 'eth_getTransactionReceipt' ? value.transactionHash : value.hash;
          if (!hash(returnedHash) || returnedHash.toLowerCase() !== payload.params[0].toLowerCase()) throw new HttpError(502, 'RPC returned an unrelated transaction.');
          if (payload.method === 'eth_getTransactionReceipt' && (!hash(value.blockHash) || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value.blockNumber) || !['0x0', '0x1'].includes(value.status))) throw new HttpError(502, 'RPC returned an incomplete mined receipt.');
        }
        if (payload.method === 'eth_getTransactionByHash' && value && (value.blockNumber === null || value.blockHash === null)) {
          pendingTransaction ??= value;
          throw new HttpError(404, 'Transaction is not mined on this RPC yet.');
        }
        if (byHash && value === null) { notFound = true; throw new HttpError(404, 'Transaction not found by this RPC.'); }
        return value;
      });
      try { return await Promise.any(lookups); }
      catch (e) {
        if (pendingTransaction) return pendingTransaction;
        if (notFound) return null;
        throw e.errors[0];
      } finally { for (const controller of controllers) controller.abort(); }
    },
    async usdc(wallet) {
      if (wallet !== null && wallet !== undefined && !address(wallet)) throw new HttpError(400, 'Enter a valid public wallet address.');
      usdcAddress(network.key, env);
      await this.rpc({ method: 'eth_chainId', params: [] });
      const provider = { getCode: (to, block) => rpcCall('eth_getCode', [to, block]), call: tx => rpcCall('eth_call', [tx, 'latest']) };
      const contractAddress = await checkedUsdc(provider, network.key, env);
      return { contractAddress, decimals: 6, symbol: 'USDC', ...(wallet ? { balance: (await usdcBalance(provider, contractAddress, wallet)).toString() } : {}) };
    },
    async history(wallet, asset = 'ETH') {
      if (!['ETH', 'USDC'].includes(asset)) throw new HttpError(400, 'Choose ETH or USDC.');
      const contract = asset === 'USDC' ? usdcAddress(network.key, env) : null;
      if (!address(wallet)) throw new HttpError(400, 'Enter a valid Ethereum public address.');
      const url = new URL(apiKey ? KEYED_HISTORY_URL : services.history);
      url.search = new URLSearchParams({ module: 'account', action: contract ? 'tokentx' : 'txlist', address: wallet, page: '1', offset: '20', sort: 'desc' });
      if (contract) url.searchParams.set('contractaddress', contract);
      if (apiKey) { url.searchParams.set('apikey', apiKey); url.searchParams.set('chain_id', String(network.chainId)); }
      const body = await request(url);
      if (contract && body.status === '1' && Array.isArray(body.result)) {
        return body.result.slice(0, 20).map(tx => {
          if (!hash(tx.hash) || !address(tx.from) || !address(tx.to) || tx.contractAddress?.toLowerCase() !== contract.toLowerCase() || tx.tokenDecimal !== '6' || !/^\d+$/.test(tx.value) || !/^\d+$/.test(tx.timeStamp) || ![tx.from, tx.to].some(a => a.toLowerCase() === wallet.toLowerCase())) throw new HttpError(502, 'Explorer returned invalid or unrelated USDC transfers.');
          return { hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, timeStamp: tx.timeStamp, input: '0x', status: 'indexed', contractAddress: contract, asset: 'USDC' };
        });
      }
      return normalizeHistory(body, wallet);
    },
  };
}

// One isolated upstream per allowlisted network. No browser-provided RPC URLs.
export function createConfiguredUpstreams({ env = process.env, fetchImpl = fetch } = {}) {
  return Object.fromEntries(NETWORKS.map(network => [network.key, createUpstream({
    networkKey: network.key,
    rpcUrl: env[SERVICES[network.key].rpcEnv] || undefined,
    fallbackRpcUrls: [SERVICES[network.key].rpc, SERVICES[network.key].fallbackRpc],
    apiKey: env.BLOCKSCOUT_API_KEY || '',
    timeoutMs: Number(env.REQUEST_TIMEOUT_MS || 12000),
    fetchImpl, env,
  })]));
}

export function configuredRpcUrl(networkKey, env = process.env) {
  getNetwork(networkKey);
  return env[SERVICES[networkKey].rpcEnv] || SERVICES[networkKey].rpc;
}
