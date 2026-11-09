import { BrowserProvider, Interface, toQuantity } from 'ethers';
import { transferInput } from './transfer-input.js';
import { USDC_ABI } from './usdc-abi.js';
import { USDC_CONTRACTS } from './usdc-contracts.js';
import { getNetwork } from './networks.js';
import { hashInput } from './verification.js';
const abi = new Interface(USDC_ABI);
const TTL = 120000;
const providerFor = raw => new BrowserProvider(raw, 'any', { cacheTimeout: -1 });

async function inspect(provider, input, from) {
  const { to, value, network } = transferInput(input, from);
  const asset = input.asset || 'ETH';
  const contract = asset === 'USDC' ? USDC_CONTRACTS[network.key] : null;
  if (asset === 'USDC' && !contract) throw new Error('Native USDC is supported on Mainnet and Sepolia.');
  const senderCode = await provider.getCode(from, 'latest');
  if (senderCode !== '0x') throw new Error('Delegated or contract sending accounts need a different transfer flow.');
  if (contract) {
    if (to.toLowerCase() === contract.toLowerCase()) throw new Error('Do not send USDC to its token contract.');
    const [code, decimals, symbol, balance] = await Promise.all([
      provider.getCode(contract, 'latest'),
      provider.call({ to: contract, data: abi.encodeFunctionData('decimals') }),
      provider.call({ to: contract, data: abi.encodeFunctionData('symbol') }),
      provider.call({ to: contract, data: abi.encodeFunctionData('balanceOf', [from]) }),
    ]);
    let valid = false;
    try { valid = /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && abi.decodeFunctionResult('decimals', decimals)[0] === 6n && abi.decodeFunctionResult('symbol', symbol)[0] === 'USDC'; } catch {}
    if (!valid) throw new Error('The native USDC contract could not be verified on this network.');
    if (abi.decodeFunctionResult('balanceOf', balance)[0] < value) throw new Error('Insufficient USDC balance.');
  } else if (await provider.getCode(to, 'latest') !== '0x') throw new Error('Direct ETH sending supports plain receiving accounts only.');
  const transaction = { from, to: contract || to, value: contract ? 0n : value, data: contract ? abi.encodeFunctionData('transfer', [to, value]) : '0x' };
  const [balance, nonce, latestNonce, fees, estimate] = await Promise.all([
    provider.getBalance(from, 'pending'), provider.getTransactionCount(from, 'pending'), provider.getTransactionCount(from, 'latest'), provider.getFeeData(), provider.estimateGas(transaction),
  ]);
  if (nonce !== latestNonce) throw new Error('This wallet already has a pending transaction. Wait for its receipt before sending another payment.');
  if (!Number.isSafeInteger(nonce) || nonce < 0 || typeof estimate !== 'bigint' || estimate <= 0n || estimate > (contract ? 500000n : 100000n)) throw new Error('The wallet returned an unsupported nonce or gas estimate.');
  const feeFields = fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
    ? { type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
    : { type: 0, gasPrice: fees.gasPrice };
  const fee = feeFields.maxFeePerGas ?? feeFields.gasPrice;
  if (typeof fee !== 'bigint' || fee <= 0n) throw new Error('The wallet could not provide a usable gas fee.');
  return { to, value, network, asset, contract, transaction, balance, nonce, feeFields, fee, estimate };
}
export async function prepareWalletTransfer(session, input, { providerFactory = providerFor, now = Date.now } = {}) {
  if (typeof input.networkKey !== 'string') throw new Error('Choose a network explicitly.');
  const account = session.snapshot();
  if (!account.address) throw new Error('Connect your wallet first.');
  const raw = await session.assertContext(input.networkKey, account.address);
  const provider = providerFactory(raw);
  try {
    const data = await inspect(provider, input, account.address);
    const gasLimit = (data.estimate * 120n + 99n) / 100n;
    const maxFee = gasLimit * data.fee;
    if (data.balance < data.transaction.value + maxFee) throw new Error('Not enough ETH for this amount plus the maximum gas fee.');
    await session.assertContext(input.networkKey, account.address);
    if (account.generation !== session.snapshot().generation) throw new Error('The wallet changed. Prepare a new review.');
    const transaction = { from: account.address, to: data.transaction.to, value: toQuantity(data.transaction.value), data: data.transaction.data, chainId: toQuantity(data.network.chainId), nonce: toQuantity(data.nonce), gas: toQuantity(gasLimit), ...Object.fromEntries(Object.entries(data.feeFields).map(([key, value]) => [key, toQuantity(value)])) };
    return Object.freeze({ reviewId: crypto.randomUUID(), expiresAt: now() + TTL, generation: account.generation, networkKey: data.network.key, networkName: data.network.name, chainId: data.network.chainId, from: account.address, to: data.to, asset: data.asset, amountUnits: data.value.toString(), ...(data.asset === 'ETH' ? { amountWei: data.value.toString() } : {}), contractAddress: data.contract, maxFeeWei: maxFee.toString(), maxTotalWei: (data.transaction.value + maxFee).toString(), feePerGasWei: data.fee.toString(), gasLimit: gasLimit.toString(), nonce: data.nonce, transaction: Object.freeze(transaction), input: Object.freeze({ ...input }) });
  } finally { provider.destroy(); }
}
async function sendOnce(session, review, { providerFactory = providerFor, now = Date.now, beforePrompt = () => {}, stillCurrent = () => true } = {}) {
  if (now() >= review.expiresAt) throw new Error('Review expired. Prepare a new review with current fees.');
  const raw = await session.assertContext(review.networkKey, review.from);
  if (review.generation !== session.snapshot().generation || !stillCurrent()) throw new Error('The wallet or transfer details changed. Prepare a new review.');
  const provider = providerFactory(raw);
  try {
    const current = await inspect(provider, review.input, review.from);
    if (current.nonce !== review.nonce) throw new Error('The wallet nonce changed. Check wallet activity and prepare a new review.');
    if (current.fee > BigInt(review.feePerGasWei) || current.estimate > BigInt(review.gasLimit) || (review.transaction.type === '0x2' && current.feeFields.maxPriorityFeePerGas > BigInt(review.transaction.maxPriorityFeePerGas))) throw new Error('Gas fees increased. Prepare a new review; the approved fee cap will not be raised automatically.');
    if (current.balance < BigInt(review.maxTotalWei)) throw new Error('The wallet no longer has enough ETH for the amount and gas cap.');
    await session.assertContext(review.networkKey, review.from);
    if (review.generation !== session.snapshot().generation || !stillCurrent() || now() >= review.expiresAt) throw new Error('Review is no longer current. Prepare it again.');
    beforePrompt(); // Persist only public recovery details before asking the wallet.
    const hash = await raw.request({ method: 'eth_sendTransaction', params: [{ ...review.transaction }] });
    return hashInput(hash);
  } finally { provider.destroy(); }
}
const attempts = new WeakMap();
export function sendWalletTransfer(session, review, options) {
  if (!attempts.has(review)) attempts.set(review, sendOnce(session, review, options));
  return attempts.get(review);
}
export function matchesSubmissionTransaction(record, transaction) {
  const network = getNetwork(record.networkKey);
  if (!transaction || transaction.from?.toLowerCase() !== record.from.toLowerCase() || transaction.nonce !== record.nonce || BigInt(transaction.chainId) !== BigInt(network.chainId)) throw new Error('This transaction does not match the sending account, nonce and network of the wallet request.');
  return transaction.to?.toLowerCase() === record.transaction.to.toLowerCase() && transaction.value === BigInt(record.transaction.value) && transaction.data?.toLowerCase() === record.transaction.data.toLowerCase();
}
