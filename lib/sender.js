import { Wallet, JsonRpcProvider, FetchRequest, keccak256 } from 'ethers';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, configuredRpcUrl, createConfiguredUpstreams } from './upstream.js';
import { NETWORKS, getNetwork } from '../public/js/networks.js';
import { amountInput } from '../public/js/verification.js';
import { transferInput } from '../public/js/transfer-input.js';
import { assetAmount, formatAsset } from '../public/js/assets.js';
import { checkedUsdc, usdcBalance, usdcInterface } from './usdc.js';

const REVIEW_TTL_MS = 120000;
const error = (status, message) => new HttpError(status, message);
function onlyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw error(400, 'Unexpected transfer fields. Reload the app and try again.');
}
function jsonValue(value) { return JSON.parse(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item)); }

// Local hot-wallet service. Only this module accesses the private key.
// Never return/log the wallet object, raw signed transaction, provider URL, or error object.
export function createSender({ env = process.env, providerFactory, fetchImpl = fetch, now = Date.now, randomToken = () => randomBytes(32).toString('hex'), journal } = {}) {
  const csrfToken = randomToken();
  const reviews = new Map();
  for (const record of journal?.records() ?? []) {
    const resolved = ['success', 'failed'].includes(record.result.receiptStatus);
    reviews.set(record.id, { id: record.id, result: record.result, resolved, state: resolved ? (record.result.receiptStatus === 'success' ? 'mined' : 'failed') : record.result.broadcastStatus === 'submitted' ? 'submitted' : 'unknown', createdAt: now(), expiresAt: 0 });
  }
  let wallet = null;
  let setupError = '';
  let maxValue;
  let maxUsdc;
  try { maxUsdc = assetAmount(env.SEND_MAX_USDC || '100', 'USDC'); } catch { setupError = 'SEND_MAX_USDC must be a positive USDC amount with at most 6 decimals.'; }
  try { maxValue = amountInput(env.SEND_MAX_ETH || '0.1'); }
  catch { setupError = 'SEND_MAX_ETH must be a positive plain-decimal ETH amount.'; }
  if (env.WALLET_PRIVATE_KEY) {
    const supplied = env.WALLET_PRIVATE_KEY.trim();
    const hex = supplied.startsWith('0x') ? supplied.slice(2) : supplied;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      setupError = /^[0-9a-fA-F]*$/.test(hex)
        ? 'WALLET_PRIVATE_KEY has ' + hex.length + ' hexadecimal characters; 64 are required (the optional 0x prefix does not count). Re-copy the complete account key into .env, save, and restart.'
        : 'WALLET_PRIVATE_KEY must contain 64 hexadecimal characters, with or without 0x. Use the account private key, not a public address or seed phrase. Configure .env and restart.';
    } else {
      try { wallet = new Wallet('0x' + hex); }
      catch { setupError = 'WALLET_PRIVATE_KEY is not a valid Ethereum account key. Re-copy it privately into .env, save, and restart.'; }
    }
  }
  const allowedNetworks = NETWORKS.filter(network => network.testnet || env.ENABLE_MAINNET_SEND === 'true').map(network => network.key);
  let submitting = false;
  const makeProvider = providerFactory ?? (networkKey => {
    const request = new FetchRequest(configuredRpcUrl(networkKey, env));
    request.timeout = Number(env.REQUEST_TIMEOUT_MS || 12000);
    return new JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  });
  function configured() {
    if (setupError) throw error(503, setupError);
    if (!wallet) throw error(503, 'Backend signing is not configured. Add WALLET_PRIVATE_KEY to your local .env file and restart the server. Never enter it in the webpage or chat.');
  }
  function requireNetwork(networkKey) {
    if (typeof networkKey !== 'string') throw error(400, 'Choose an explicit Ethereum network for this transfer.');
    let network;
    try { network = getNetwork(networkKey); } catch (e) { throw error(400, e.message); }
    if (!allowedNetworks.includes(network.key)) throw error(403, 'Mainnet sending is disabled. Test on Sepolia or Hoodi first; set ENABLE_MAINNET_SEND=true locally only when you intend to spend real ETH.');
    return network;
  }
  async function chain(provider, network) {
    const actual = await provider.send('eth_chainId', []);
    if (typeof actual !== 'string' || !/^0x[0-9a-fA-F]+$/.test(actual) || BigInt(actual) !== BigInt(network.chainId)) throw error(502, 'Sending RPC network mismatch. Check the RPC URL for ' + network.name + '.');
  }
  async function plainAccounts(provider, to) {
    const [senderCode, receiverCode] = await Promise.all([provider.getCode(wallet.address, 'latest'), provider.getCode(to, 'latest')]);
    if (senderCode !== '0x' || receiverCode !== '0x') throw error(400, 'Sending supports plain accounts only. Contract or delegated accounts require a different transfer flow.');
  }
  function knownFailure(e) {
    if (e instanceof HttpError) return e;
    if (e.code === 'INSUFFICIENT_FUNDS') return error(400, 'Not enough ETH for the amount plus the maximum gas fee.');
    if (e.code === 'CALL_EXCEPTION') return error(400, 'Contract call or gas estimation reverted. Check balances, recipient and any USDC transfer restrictions.');
    if (e.code === 'NONCE_EXPIRED') return error(409, 'The account nonce changed. Check your pending transfers, then create a new review.');
    return error(502, 'The sending RPC could not complete this request. Check its connection, account balance and pending transactions, then retry the review.');
  }
  let receiptUpstreams;
  async function refreshSubmission(review) {
    if (!review.result || review.resolved) return;
    if (review.refreshing) return review.refreshing;
    review.refreshing = (async () => {
      const network = getNetwork(review.result.networkKey);
      let receipt;
      if (providerFactory) {
        const provider = makeProvider(network.key);
        try { await chain(provider, network); receipt = await provider.getTransactionReceipt(review.result.hash); }
        finally { provider.destroy(); }
      } else {
        receiptUpstreams ??= createConfiguredUpstreams({ env, fetchImpl });
        receipt = await receiptUpstreams[network.key].rpc({ method: 'eth_getTransactionReceipt', params: [review.result.hash] });
      }
      if (!receipt) return;
      const hash = receipt.hash ?? receipt.transactionHash;
      const blockNumber = typeof receipt.blockNumber === 'string' && /^0x[0-9a-fA-F]+$/.test(receipt.blockNumber) ? Number(BigInt(receipt.blockNumber)) : receipt.blockNumber;
      const status = receipt.status === '0x1' ? 1 : receipt.status === '0x0' ? 0 : receipt.status;
      if (typeof hash !== 'string' || hash.toLowerCase() !== review.result.hash.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) || !Number.isSafeInteger(blockNumber) || blockNumber < 0 || ![0, 1].includes(status)) throw error(502, 'RPC returned an invalid receipt for the previous submission. Retry its status lookup.');
      const result = { ...review.result, broadcastStatus: 'submitted', receiptStatus: status === 1 ? 'success' : 'failed', blockNumber, blockHash: receipt.blockHash, message: status === 1 ? 'Transaction mined successfully. Verify the payment amount and recipient below.' : 'Transaction execution failed. The payment was not completed; gas may have been spent.' };
      // Persist the receipt BEFORE lifting the gate. A reload or server restart
      // must not turn an already mined payment back into an uncertain submission.
      try { journal?.save(review.id, result); }
      catch { throw error(503, 'Could not save the confirmed receipt. Check the local data directory and retry the status lookup.'); }
      review.result = result;
      review.resolved = true;
      review.state = status === 1 ? 'mined' : 'failed';
    })();
    try { await review.refreshing; }
    finally { review.refreshing = null; }
  }
  async function noUnresolvedBroadcast(networkKey) {
    for (const review of reviews.values()) {
      if (!review.result || review.result.networkKey !== networkKey || review.resolved) continue;
      await refreshSubmission(review);
      if (!review.resolved) throw error(409, 'A previous submission is unresolved: ' + review.result.hash + ' on ' + getNetwork(networkKey).name + '. The checked RPCs have no mined receipt yet. Check its submission status before sending again.');
    }
  }
  function prune() {
    for (const [id, review] of reviews) if (review.createdAt + 600000 < now() && !review.result && review.state !== 'submitting') reviews.delete(id);
    if ([...reviews.values()].filter(review => !review.result).length >= 100) throw error(429, 'Too many transfer reviews. Wait a few minutes before creating another.');
  }
  function publicReview(review) {
    const tx = review.transaction;
    const feePerGas = tx.maxFeePerGas ?? tx.gasPrice;
    const maxFee = tx.gasLimit * feePerGas;
    return {
      reviewId: review.id, expiresAt: review.expiresAt,
      networkKey: review.network.key, networkName: review.network.name, chainId: review.network.chainId,
      from: wallet.address, to: review.recipient, amountUnits: review.amount.toString(), ...(review.asset === 'ETH' ? { amountWei: review.amount.toString() } : {}), asset: review.asset, contractAddress: review.contract ?? null,
      gasLimit: tx.gasLimit.toString(), maxFeeWei: maxFee.toString(), maxTotalWei: (tx.value + maxFee).toString(),
      feePerGasWei: feePerGas.toString(), nonce: tx.nonce,
    };
  }
  return {
    status() {
      return { configured: !!wallet && !setupError, address: wallet?.address ?? null, reason: setupError || (!wallet ? 'Add your dedicated account key locally in .env, then restart. Never paste a key into the webpage or chat.' : ''), allowedNetworks, maxAmountWei: maxValue?.toString() ?? null, maxUsdcUnits: maxUsdc?.toString() ?? null, pendingReviews: [...reviews.values()].filter(review => review.result && !review.resolved && review.result.from?.toLowerCase() === wallet?.address.toLowerCase()).map(review => ({ reviewId: review.id, networkKey: review.result.networkKey })), csrfToken };
    },
    authorize(token) {
      if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(csrfToken) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) throw error(403, 'Invalid transfer session. Reload the app before preparing a transfer.');
    },
    async prepare(body) {
      configured(); onlyFields(body, ['recipient', 'amount', 'networkKey', 'asset']);
      const network = requireNetwork(body.networkKey);
      const asset = body.asset ?? 'ETH';
      let input;
      try { input = transferInput(body, wallet.address); } catch (e) { throw error(400, e.message); }
      const max = asset === 'USDC' ? maxUsdc : maxValue;
      if (input.value > max) throw error(400, 'Amount exceeds the ' + formatAsset(max, asset) + ' ' + asset + ' per-transfer limit.');
      if (submitting) throw error(409, 'A transfer is being submitted. Wait for its result before preparing another.');
      prune();
      const provider = makeProvider(network.key);
      try {
        await chain(provider, network);
        if (asset === 'ETH') await plainAccounts(provider, input.to);
        else if (await provider.getCode(wallet.address, 'latest') !== '0x') throw error(400, 'Delegated sending accounts are not supported.');
        const contract = asset === 'USDC' ? await checkedUsdc(provider, network.key, env) : null;
        if (contract && input.to.toLowerCase() === contract.toLowerCase()) throw error(400, 'Do not send USDC to its token contract.');
        if (contract && await usdcBalance(provider, contract, wallet.address) < input.value) throw error(400, 'Insufficient USDC balance.');
        await noUnresolvedBroadcast(network.key);
        const transaction = { to: contract || input.to, value: contract ? 0n : input.value, data: contract ? usdcInterface.encodeFunctionData('transfer', [input.to, input.value]) : '0x' };
        const [balance, nonce, fees, estimate] = await Promise.all([
          provider.getBalance(wallet.address, 'pending'), provider.getTransactionCount(wallet.address, 'pending'),
          provider.getFeeData(), provider.estimateGas({ from: wallet.address, ...transaction }),
        ]);
        if (typeof estimate !== 'bigint' || estimate <= 0n || estimate > (contract ? 500000n : 100000n)) throw error(400, 'Gas estimate is outside the supported transfer range.');
        const gasLimit = (estimate * 120n + 99n) / 100n;
        const feeFields = fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
          ? { type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
          : { type: 0, gasPrice: fees.gasPrice };
        const feePerGas = feeFields.maxFeePerGas ?? feeFields.gasPrice;
        if (typeof feePerGas !== 'bigint' || feePerGas <= 0n) throw error(502, 'RPC could not provide a usable gas fee.');
        if (balance < transaction.value + gasLimit * feePerGas) throw error(400, 'Not enough ETH for this amount plus the maximum gas fee.');
        const latestNonce = await provider.getTransactionCount(wallet.address, 'latest');
        if (latestNonce !== nonce) throw error(409, 'This account already has a pending transaction. Wait for its receipt before sending again.');
        const review = { id: randomToken(), createdAt: now(), expiresAt: now() + REVIEW_TTL_MS, network, asset, recipient: input.to, amount: input.value, contract, state: 'prepared', transaction: { ...transaction, chainId: network.chainId, nonce, gasLimit, ...feeFields } };
        await chain(provider, network);
        reviews.set(review.id, review);
        return publicReview(review);
      } catch (e) { throw knownFailure(e); }
      finally { provider.destroy(); }
    },
    async getReview(id) {
      configured();
      const review = reviews.get(id);
      if (!review) throw error(404, 'Transfer review not found. If the server restarted after submission, check the sender’s pending transactions before sending again.');
      let lookupError = null;
      try { await refreshSubmission(review); } catch (e) { lookupError = knownFailure(e).message; }
      return { state: review.state, result: review.result ?? null, expired: review.expiresAt <= now(), lookupError };
    },
    cancel(body) {
      configured(); onlyFields(body, ['reviewId']);
      const review = reviews.get(body.reviewId);
      if (!review) throw error(404, 'Transfer review not found. Check pending transactions if the server restarted.');
      if (review.state === 'prepared') review.state = 'cancelled';
      return { state: review.state, result: review.result ?? null };
    },
    async confirm(body) {
      configured(); onlyFields(body, ['reviewId']);
      if (typeof body.reviewId !== 'string' || !/^[0-9a-f]{64}$/.test(body.reviewId)) throw error(400, 'Invalid transfer review.');
      const review = reviews.get(body.reviewId);
      if (!review) throw error(404, 'Transfer review not found. Check pending transactions if the server restarted.');
      if (review.result) return review.result; // Idempotent: same review never signs a new payment.
      if (review.state !== 'prepared') throw error(409, 'This review is already used or being submitted. Check its submission status.');
      if (review.expiresAt <= now()) { review.state = 'expired'; throw error(409, 'Review expired. Review the current fees again.'); }
      requireNetwork(review.network.key);
      if (submitting) throw error(409, 'Another transfer is being submitted. Wait for its result.');
      submitting = true; review.state = 'submitting';
      let provider;
      let hash;
      let broadcastStarted = false;
      try {
        provider = makeProvider(review.network.key);
        await chain(provider, review.network);
        if (review.asset === 'ETH') await plainAccounts(provider, review.recipient);
        else {
          if (await checkedUsdc(provider, review.network.key, env) !== review.contract) throw error(409, 'USDC contract changed.');
          if (await provider.getCode(wallet.address, 'latest') !== '0x') throw error(400, 'Delegated sending accounts are not supported.');
          if (await usdcBalance(provider, review.contract, wallet.address) < review.amount) throw error(400, 'Insufficient USDC balance.');
        }
        await noUnresolvedBroadcast(review.network.key);
        const tx = review.transaction;
        const [nonce, balance, fees, gas] = await Promise.all([
          provider.getTransactionCount(wallet.address, 'pending'), provider.getBalance(wallet.address, 'pending'),
          provider.getFeeData(), provider.estimateGas({ from: wallet.address, ...tx }),
        ]);
        if (nonce !== await provider.getTransactionCount(wallet.address, 'latest')) throw error(409, 'Another transaction is pending. Wait for its receipt.');
        if (nonce !== tx.nonce) throw error(409, 'The sender nonce changed. Check pending transactions and create a new review.');
        const cap = tx.maxFeePerGas ?? tx.gasPrice;
        const currentFee = tx.type === 2 ? fees.maxFeePerGas : fees.gasPrice;
        if (typeof currentFee !== 'bigint' || currentFee <= 0n || currentFee > cap || gas > tx.gasLimit) throw error(409, 'Gas fees or gas usage increased. Review again; the approved maximum will not be raised automatically.');
        if (balance < tx.value + tx.gasLimit * cap) throw error(400, 'The sender no longer has enough ETH for the approved amount and gas cap.');
        await chain(provider, review.network);
        const signed = await wallet.signTransaction(tx);
        hash = keccak256(signed);
        review.result = { hash, networkKey: review.network.key, from: wallet.address, to: review.recipient, amountUnits: review.amount.toString(), ...(review.asset === 'ETH' ? { amountWei: review.amount.toString() } : {}), asset: review.asset, contractAddress: review.contract, broadcastStatus: 'unknown', message: 'Submission outcome is uncertain. Check this exact hash and the sender’s pending transactions; do not create a replacement payment blindly.' };
        try { journal?.save(review.id, review.result); } catch { review.result = null; throw error(503, 'Cannot persist submission tracking. Nothing was broadcast. Check the local data directory.'); }
        broadcastStarted = true;
        const returnedHash = await provider.send('eth_sendRawTransaction', [signed]);
        if (typeof returnedHash !== 'string' || returnedHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Unexpected broadcast response');
        if (!review.resolved) {
          review.result = { ...review.result, broadcastStatus: 'submitted', message: 'Transaction submitted. It is not yet a successful mined payment. Check the receipt.' };
          journal?.save(review.id, review.result);
          review.state = 'submitted';
        }
        return jsonValue(review.result);
      } catch (e) {
        if (broadcastStarted) { if (!review.resolved) review.state = 'unknown'; return jsonValue(review.result); }
        review.state = 'rejected';
        throw knownFailure(e);
      } finally { provider?.destroy(); submitting = false; }
    },
  };
}
