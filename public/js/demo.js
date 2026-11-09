import { parseEther } from 'ethers';
export const DEMO_WALLET = '0x1111111111111111111111111111111111111111';
export const DEMO_SENDER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const blockHash = '0x' + 'ab'.repeat(32);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const definitions = [
  ['exact', 'Exact payment', '0.5', DEMO_WALLET, DEMO_SENDER, 1],
  ['underpaid', 'Underpayment', '0.35', DEMO_WALLET, DEMO_SENDER, 1],
  ['overpaid', 'Overpayment', '0.65', DEMO_WALLET, DEMO_SENDER, 1],
  ['wrong-recipient', 'Wrong recipient', '0.5', OTHER, DEMO_SENDER, 1],
  ['failed', 'Failed transfer', '0.5', DEMO_WALLET, DEMO_SENDER, 0],
  ['pending', 'Pending transfer', '0.5', DEMO_WALLET, DEMO_SENDER, null],
  ['self-transfer', 'Self-transfer', '0.5', DEMO_WALLET, DEMO_WALLET, 1],
  ['unsupported', 'Contract call data', '0.5', DEMO_WALLET, DEMO_SENDER, 1],
  ['unknown', 'Unknown hash', '0', DEMO_WALLET, DEMO_SENDER, null],
];
export const scenarios = definitions.map(([id, label, amount, to, from, status], i) => {
  const transaction = id === 'unknown' ? null : { hash: hash(i + 1), to, from, value: parseEther(amount), data: id === 'unsupported' ? '0x12345678' : '0x', type: 2, blockNumber: status === null ? null : 100 + i, blockHash: status === null ? null : blockHash };
  return { id, label, input: { recipient: DEMO_WALLET, expected: '0.5', hash: hash(i + 1) }, data: { transaction, receipt: status === null ? null : { hash: hash(i + 1), status, blockHash, blockNumber: 100 + i }, recipientCode: '0x' } };
});
export function demoPayment(txHash) {
  return scenarios.find(s => s.input.hash === txHash.toLowerCase())?.data ?? { transaction: null, receipt: null };
}
// A separate, coherent fictional wallet ledger. Scenario choices never alter this snapshot.
// Opening 2 ETH + 0.5 incoming - 0.2 outgoing - 0.0002 outgoing gas
// - 0.0001 failed gas - 0.0001 self-transfer gas = 2.2996 ETH.
export const demoHistory = [
  { hash: hash(104), from: DEMO_WALLET, to: DEMO_WALLET, value: parseEther('0.1').toString(), timeStamp: '1793941200', status: 'success', input: '0x' },
  { hash: hash(103), from: DEMO_WALLET, to: OTHER, value: parseEther('0.3').toString(), timeStamp: '1793937600', status: 'failed', input: '0x' },
  { hash: hash(102), from: DEMO_WALLET, to: OTHER, value: parseEther('0.2').toString(), timeStamp: '1793851200', status: 'success', input: '0x' },
  { hash: hash(101), from: DEMO_SENDER, to: DEMO_WALLET, value: parseEther('0.5').toString(), timeStamp: '1793764800', status: 'success', input: '0x' },
];
export const demoBalance = parseEther('2.2996');
