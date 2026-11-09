import { Interface } from 'ethers';
import { USDC_ABI } from './usdc-abi.js';
import { assetAmount, formatAsset } from './assets.js';
import { addressInput, hashInput } from './verification.js';

const abi = new Interface(USDC_ABI);
export function verifyUsdcPayment(input, { transaction: tx, receipt, contractAddress, confirmations = 0 }, { chainId } = {}) {
  const recipient = addressInput(input.recipient);
  const expected = assetAmount(input.expected, 'USDC');
  const hash = hashInput(input.hash);
  const contract = addressInput(contractAddress);
  const result = (code, title, message, tone = 'warning', extra = {}) => ({ code, title, message, tone, ...extra });
  if (!tx) {
    if (receipt) throw new Error('Receipt has no matching transaction. Retry.');
    return result('unknown', 'Transaction not found', 'No transaction found on the selected network.');
  }
  if (hashInput(tx.hash) !== hash || (chainId !== undefined && BigInt(tx.chainId) !== BigInt(chainId))) throw new Error('Transaction hash or chain ID mismatch.');
  const sender = addressInput(tx.from);
  if (!receipt) return result('pending', 'Pending / no receipt', 'Payment has not been confirmed.');
  if (!Number.isInteger(receipt.blockNumber) || receipt.blockNumber < 0 || hashInput(receipt.hash) !== hash || hashInput(receipt.blockHash) !== hashInput(tx.blockHash) || tx.blockNumber !== receipt.blockNumber) throw new Error('Transaction and receipt disagree about the mined block. Retry.');
  if (receipt.status === 0) return result('failed', 'Transfer failed', 'Execution reverted. No USDC payment occurred; ETH gas may have been spent.', 'danger');
  if (receipt.status !== 1) throw new Error('Receipt status is unavailable.');
  if (!tx.to || addressInput(tx.to) !== contract || tx.value !== 0n) return result('wrong-contract', 'Wrong USDC contract', 'This is not a direct transfer through the configured USDC contract.', 'danger');
  let call;
  try { call = abi.parseTransaction({ data: tx.data, value: tx.value }); } catch {}
  if (call?.name !== 'transfer') return result('unsupported', 'Unsupported USDC call', 'Choose a direct USDC transfer(address,uint256) transaction.');
  if (addressInput(call.args[0]) !== recipient) return result('wrong-recipient', 'Wrong recipient', 'The transfer targets a different receiving wallet.', 'danger');
  if (input.sender && sender !== addressInput(input.sender)) return result('wrong-sender', 'Wrong sender', 'The transfer was signed by a different wallet.', 'danger');
  if (sender === recipient) return result('self-transfer', 'Self-transfer', 'Sender and recipient are the same wallet.');
  if (!Array.isArray(receipt.logs)) throw new Error('Receipt logs are unavailable.');
  const matches = [];
  for (const log of receipt.logs) {
    if (log.removed || log.address?.toLowerCase() !== contract.toLowerCase()) continue;
    let event;
    try { event = abi.parseLog(log); } catch { continue; }
    if (event?.name === 'Transfer' && addressInput(event.args.from) === sender && addressInput(event.args.to) === recipient) matches.push(event);
  }
  if (matches.length !== 1 || matches[0].args.value !== call.args[1]) return result('missing-transfer', 'USDC payment not proven', 'The receipt must contain exactly one matching USDC Transfer event from the signer to the intended recipient with the encoded amount.', 'danger');
  const paid = matches[0].args.value;
  const extra = { paidUnits: paid, paymentRecipient: recipient, confirmations, contractAddress: contract };
  const difference = paid - expected;
  if (difference < 0n) return result('underpaid', 'Payment is short', 'Missing ' + formatAsset(-difference, 'USDC') + ' USDC.', 'warning', extra);
  if (difference > 0n) return result('overpaid', 'Payment exceeds expectation', 'Extra ' + formatAsset(difference, 'USDC') + ' USDC.', 'info', extra);
  return result('exact', 'Exact USDC payment matched', 'The successful receipt contains the intended sender, recipient and exact USDC amount.', 'success', extra);
}

