import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { scenarios, DEMO_WALLET, demoHistory, demoBalance } from '../public/js/demo.js';
import { verifyPayment, paymentInput, amountInput, addressInput, hashInput } from '../public/js/verification.js';
const exact = scenarios[0];
for (const scenario of scenarios) test('decision: ' + scenario.label, () => {
  assert.equal(verifyPayment(scenario.input, scenario.data).code, scenario.id);
});
function payment(value, expected = '0.5') {
  return verifyPayment({ ...exact.input, expected }, { ...exact.data, transaction: { ...exact.data.transaction, value } });
}
test('one wei under and over are distinguished without rounding', () => {
  const value = parseEther('0.5');
  assert.equal(payment(value - 1n).differenceWei, -1n);
  assert.match(payment(value - 1n).message, /0.000000000000000001 ETH/);
  assert.equal(payment(value + 1n).differenceWei, 1n);
  assert.equal(payment(1n, '0.000000000000000001').code, 'exact');
});
test('amounts beyond Number safe-integer precision remain exact', () => {
  const amount = '9007199254740993.123456789012345678';
  assert.equal(payment(parseEther(amount), amount).code, 'exact');
});
for (const value of ['', '0', '-1', '+1', '1e-3', 'NaN', 'Infinity', '.5', '1.', '01.2', '1,000', '0.0000000000000000001', '1.0000000000000000000', '9'.repeat(90), 0.5]) {
  test('reject invalid expected amount ' + String(value), () => assert.throws(() => amountInput(value)));
}
test('trim plain decimal input', () => assert.equal(amountInput(' 0.5 '), parseEther('0.5')));
for (const value of ['', 'vitalik.eth', '0x1234', '0x' + 'g'.repeat(40), '0x52908400098527886E0F7030069857D2E4169Ee7', null]) {
  test('reject invalid address ' + String(value), () => assert.throws(() => addressInput(value)));
}
for (const value of ['', '0x123', '0x' + 'z'.repeat(64), null]) {
  test('reject invalid hash ' + String(value), () => assert.throws(() => hashInput(value)));
}
test('checksum, lowercase and surrounding whitespace addresses work', () => {
  assert.equal(addressInput(' 0x52908400098527886e0f7030069857d2e4169ee7 '), '0x52908400098527886E0F7030069857D2E4169EE7');
});
test('wrong recipient cannot be accepted by correct amount', () => {
  assert.equal(verifyPayment({ ...exact.input, recipient: '0x4444444444444444444444444444444444444444' }, exact.data).code, 'wrong-recipient');
});
test('zero actual value is underpayment', () => assert.equal(payment(0n).code, 'underpaid'));
test('receipt/transaction disagreement is rejected', () => {
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, receipt: { ...exact.data.receipt, blockHash: '0x' + 'cd'.repeat(32) } }), /disagree/);
});
test('unexpected transaction hash is rejected', () => {
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, transaction: { ...exact.data.transaction, hash: '0x' + '01'.repeat(32) } }), /does not match/);
});
test('missing or invalid receipt execution status is rejected', () => {
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, receipt: { ...exact.data.receipt, status: null } }), /status/);
});
test('recipient code is required for successful plain transfers', () => {
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, recipientCode: null }), /code check/);
  assert.equal(verifyPayment(exact.input, { ...exact.data, recipientCode: '0x6000' }).code, 'unsupported');
});
test('creation and delegated transactions are outside scope', () => {
  for (const change of [{ to: null }, { type: 4 }, { authorizationList: [{}] }]) {
    assert.equal(verifyPayment(exact.input, { ...exact.data, transaction: { ...exact.data.transaction, ...change } }).code, 'unsupported');
  }
});
test('demo ledger balances including failed and self-transfer gas', () => {
  let closing = parseEther('2');
  for (const tx of demoHistory) {
    if (tx.status === 'success') {
      if (tx.to === DEMO_WALLET) closing += BigInt(tx.value);
      if (tx.from === DEMO_WALLET) closing -= BigInt(tx.value);
    }
  }
  closing -= parseEther('0.0004');
  assert.equal(closing, demoBalance);
});
test('input parsing returns integer wei', () => assert.equal(paymentInput(exact.input).expectedWei, 500000000000000000n));

test('pending and failed call-data transactions retain explicit scope warnings', () => {
  const call = scenarios.find(s => s.id === 'unsupported');
  assert.match(verifyPayment(call.input, { ...call.data, receipt: null }).scopeWarning, /outside/);
  assert.match(verifyPayment(call.input, { ...call.data, receipt: { ...call.data.receipt, status: 0 } }).scopeWarning, /outside/);
});
test('invalid mined block metadata cannot produce a match', () => {
  assert.throws(() => verifyPayment(exact.input, { ...exact.data, receipt: { ...exact.data.receipt, blockNumber: null } }), /block number/);
});
