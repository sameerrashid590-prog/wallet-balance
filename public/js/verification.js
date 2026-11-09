import { assetAmount } from './assets.js';
import { getAddress, isAddress, parseEther, formatEther } from 'ethers';

export function addressInput(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.trim()) || !isAddress(value.trim())) {
    throw new Error('Enter a valid 0x Ethereum public address (40 hexadecimal characters; check mixed-case checksum).');
  }
  return getAddress(value.trim());
}
export function amountInput(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value.trim())) {
    throw new Error('Enter a positive ETH amount using plain decimals, with at most 18 decimal places.');
  }
  const wei = parseEther(value.trim());
  if (wei <= 0n || wei >= 2n ** 256n) throw new Error('Expected ETH must be greater than zero and fit within 256 bits.');
  return wei;
}
export function hashInput(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.trim())) throw new Error('Enter a transaction hash: 0x followed by 64 hexadecimal characters.');
  return value.trim().toLowerCase();
}
export function paymentInput({ recipient, expected, hash, asset = 'ETH' }) {
  return { recipient: addressInput(recipient), expectedWei: assetAmount(expected, asset), hash: hashInput(hash) };
}

// Pure decision function: the demo and live adapter both pass the same shape here.
// Values are BigInt wei. Never parse ETH as a JavaScript Number.
export function verifyPayment(input, { transaction: tx, receipt, recipientCode = null }, { networkName = 'the selected Ethereum network', chainId } = {}) {
  const { recipient, expectedWei, hash } = paymentInput(input);
  const result = (code, title, message, tone = 'warning', extra = {}) => ({ code, title, message, tone, scopeWarning: tx && typeof tx.data === 'string' && tx.data !== '0x' ? 'This transaction contains contract call data and is outside this version’s payment-verification scope.' : null, ...extra });
  if (!tx) {
    if (receipt) throw new Error('RPC returned a receipt without its transaction. Retry the lookup.');
    return result('unknown', 'Transaction not found', 'This RPC does not know this hash on ' + networkName + '. It may be on another network, dropped, or not propagated yet.');
  }
  if (hashInput(tx.hash) !== hash) throw new Error('RPC transaction hash does not match your request.');
  // Pre-EIP-155 legacy transactions have no signed chain ID; inclusion is checked through the chain-verified RPC.
  const legacyWithoutChainId = tx.type === 0 && tx.chainId !== undefined && BigInt(tx.chainId) === 0n;
  if (chainId !== undefined && tx.chainId !== undefined && !legacyWithoutChainId && BigInt(tx.chainId) !== BigInt(chainId)) throw new Error('Transaction chain ID does not match the selected network.');
  addressInput(tx.from);
  if (tx.to !== null) addressInput(tx.to);
  if (typeof tx.value !== 'bigint' || tx.value < 0n) throw new Error('Transaction has an invalid wei amount.');
  if (!receipt) return result('pending', 'Pending / no receipt', 'No mined receipt is available. Payment is not confirmed; it may still be pending, dropped, or temporarily unavailable.');
  if (!Number.isInteger(receipt.blockNumber) || receipt.blockNumber < 0) throw new Error('Receipt has no valid mined block number.');
  hashInput(receipt.blockHash);
  if (hashInput(receipt.hash) !== hash || receipt.blockHash !== tx.blockHash || receipt.blockNumber !== tx.blockNumber) {
    throw new Error('Transaction and receipt disagree about their block. A reorganization may be in progress; retry.');
  }
  if (receipt.status === 0) return result('failed', 'Transfer failed', 'Execution reverted. The attempted ETH amount was not paid; the sender may still have paid gas.', 'danger');
  if (receipt.status !== 1) throw new Error('Receipt execution status is unavailable. Retry with a different RPC.');
  if (typeof tx.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data)) throw new Error('Transaction input data is unavailable or invalid.');
  if (tx.data !== '0x' || tx.to === null || tx.type === 4 || (tx.authorizationList?.length ?? 0) > 0) {
    return result('unsupported', 'Outside this version’s scope', 'Contract call data, contract creation, and delegated-account transactions require separate interpretation. Only plain direct ETH transfers are supported.');
  }
  if (recipientCode === null) throw new Error('Recipient contract-code check is unavailable. Retry the lookup.');
  if (recipientCode !== '0x') return result('unsupported', 'Contract recipient', 'This recipient has code at the receipt block. Contract effects require separate interpretation; this version checks plain direct ETH transfers only.');
  if (tx.to.toLowerCase() !== recipient.toLowerCase()) return result('wrong-recipient', 'Wrong recipient', 'The transaction went to a different address. It does not pay the receiving wallet you entered.', 'danger');
  if (tx.from.toLowerCase() === tx.to.toLowerCase()) return result('self-transfer', 'Self-transfer', 'The sender and recipient are the same address. This is not a payment from a separate wallet.');
  const differenceWei = tx.value - expectedWei;
  if (differenceWei < 0n) return result('underpaid', 'Payment is short', 'Missing ' + formatEther(-differenceWei) + ' ETH from the expected payment.', 'warning', { differenceWei });
  if (differenceWei > 0n) return result('overpaid', 'Payment exceeds expectation', 'Extra ' + formatEther(differenceWei) + ' ETH above the expected payment.', 'info', { differenceWei });
  return result('exact', 'Exact payment matched', 'The mined transaction succeeded, reached this wallet, and matches the expected ETH amount.', 'success', { differenceWei });
}
