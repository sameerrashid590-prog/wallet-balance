import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, parseEther, parseUnits } from 'ethers';
import { prepareWalletTransfer, sendWalletTransfer, matchesSubmissionTransaction } from '../public/js/wallet-transfer.js';
import { USDC_ABI } from '../public/js/usdc-abi.js';
import { USDC_CONTRACTS } from '../public/js/usdc-contracts.js';
const FROM = '0x1111111111111111111111111111111111111111', TO = '0x2222222222222222222222222222222222222222', HASH = '0x' + 'ab'.repeat(32);
const abi = new Interface(USDC_ABI);
const INPUT = { recipient: TO, amount: '0.01', networkKey: 'sepolia', asset: 'ETH' };
function fixture() {
  const state = { generation: 1, address: FROM, chainId: 11155111, nonce: 0, latest: 0, eth: parseEther('1'), usdc: 100000000n, fee: parseUnits('20', 'gwei'), gas: 21000n, symbol: 'USDC', decimals: 6n, senderCode: '0x', recipientCode: '0x', tokenCode: '0x6000', requests: [], now: 1000 };
  const raw = { async request(payload) { state.requests.push(payload); if (state.error) throw state.error; return HASH; } };
  const session = { snapshot: () => ({ address: state.address, generation: state.generation }), async assertContext(key, address) { if (key !== 'sepolia' || state.chainId !== 11155111) throw new Error('wrong network'); if (address !== state.address) throw new Error('account changed'); return raw; } };
  const options = { now: () => state.now, providerFactory: () => ({
    async getCode(address) { return address === FROM ? state.senderCode : address === USDC_CONTRACTS.sepolia ? state.tokenCode : state.recipientCode; },
    async call(tx) { const name = abi.parseTransaction(tx).name; return abi.encodeFunctionResult(name, [name === 'decimals' ? state.decimals : name === 'symbol' ? state.symbol : state.usdc]); },
    async getBalance() { return state.eth; }, async getTransactionCount(address, block) { return block === 'latest' ? state.latest : state.nonce; },
    async getFeeData() { return { maxFeePerGas: state.fee, maxPriorityFeePerGas: parseUnits('1', 'gwei'), gasPrice: state.fee }; }, async estimateGas() { return state.gas; }, destroy() {},
  }) };
  return { state, session, options };
}
test('wallet review is read-only and freezes exact chain, receiver, amount, nonce and fee cap', async () => {
  const { state, session, options } = fixture();
  const review = await prepareWalletTransfer(session, INPUT, options);
  assert.equal(state.requests.length, 0); assert.ok(Object.isFrozen(review)); assert.ok(Object.isFrozen(review.transaction));
  assert.equal(review.transaction.from, FROM); assert.equal(review.transaction.to, TO);
  assert.equal(BigInt(review.transaction.value), parseEther('0.01')); assert.equal(BigInt(review.transaction.chainId), 11155111n);
  assert.equal(BigInt(review.maxFeeWei), BigInt(review.transaction.gas) * BigInt(review.transaction.maxFeePerGas));
  assert.equal(review.transaction.nonce, '0x0');
});
test('only explicit confirmation asks the wallet once; repeated/concurrent calls reuse the same result', async () => {
  const { state, session, options } = fixture();
  const review = await prepareWalletTransfer(session, INPUT, options);
  let prompts = 0;
  const config = { ...options, beforePrompt() { prompts++; assert.equal(state.requests.length, 0); } };
  const first = sendWalletTransfer(session, review, config), second = sendWalletTransfer(session, review, config);
  assert.strictEqual(first, second); assert.equal(await first, HASH);
  assert.equal(state.requests.length, 1); assert.equal(prompts, 1);
  assert.equal(state.requests[0].method, 'eth_sendTransaction'); assert.deepEqual(state.requests[0].params, [{ ...review.transaction }]);
  assert.equal(await sendWalletTransfer(session, review, config), HASH); assert.equal(state.requests.length, 1);
});
test('USDC uses pinned native contract and transfer calldata, never approvals or arbitrary tokens', async () => {
  const { state, session, options } = fixture(); state.gas = 65000n;
  const review = await prepareWalletTransfer(session, { ...INPUT, asset: 'USDC', amount: '12.345678' }, options);
  assert.equal(review.amountUnits, '12345678'); assert.equal(review.transaction.to, USDC_CONTRACTS.sepolia);
  assert.equal(BigInt(review.transaction.value), 0n);
  const parsed = abi.parseTransaction({ data: review.transaction.data });
  assert.equal(parsed.name, 'transfer'); assert.equal(parsed.args[0], TO); assert.equal(parsed.args[1], 12345678n);
  await sendWalletTransfer(session, review, options);
  assert.equal(state.requests[0].method, 'eth_sendTransaction');
});
test('changed account, chain, nonce, balances, fees, code, expiry or review cannot reach the wallet prompt', async () => {
  for (const change of ['account', 'chain', 'generation', 'nonce', 'pending', 'balance', 'fee', 'gas', 'code', 'expired', 'context']) {
    const { state, session, options } = fixture(); const review = await prepareWalletTransfer(session, INPUT, options);
    if (change === 'account') state.address = TO;
    if (change === 'chain') state.chainId = 1;
    if (change === 'generation') state.generation++;
    if (change === 'nonce') state.nonce = state.latest = 1;
    if (change === 'pending') state.nonce = 1;
    if (change === 'balance') state.eth = 0n;
    if (change === 'fee') state.fee *= 2n;
    if (change === 'gas') state.gas = 100000n;
    if (change === 'code') state.senderCode = '0x6000';
    if (change === 'expired') state.now = review.expiresAt;
    let prompts = 0;
    await assert.rejects(sendWalletTransfer(session, review, { ...options, stillCurrent: () => change !== 'context', beforePrompt() { prompts++; } }), undefined, change);
    assert.equal(prompts, 0, change); assert.equal(state.requests.length, 0, change);
  }
});
test('USDC balance and contract identity are rechecked before approval', async () => {
  for (const change of ['balance', 'symbol', 'decimals', 'code']) {
    const { state, session, options } = fixture(); const review = await prepareWalletTransfer(session, { ...INPUT, asset: 'USDC', amount: '1' }, options);
    if (change === 'balance') state.usdc = 0n;
    if (change === 'symbol') state.symbol = 'FAKE';
    if (change === 'decimals') state.decimals = 18n;
    if (change === 'code') state.tokenCode = '0x';
    await assert.rejects(sendWalletTransfer(session, review, options)); assert.equal(state.requests.length, 0);
  }
});
test('invalid inputs, self/zero recipients, unsupported token network and insufficient gas do not sign', async () => {
  const { state, session, options } = fixture();
  for (const input of [{ ...INPUT, recipient: FROM }, { ...INPUT, recipient: '0x' + '00'.repeat(20) }, { ...INPUT, amount: '1e3' }, { ...INPUT, networkKey: undefined }, { ...INPUT, asset: 'USDC', recipient: USDC_CONTRACTS.sepolia }, { ...INPUT, asset: 'USDC', amount: '1.0000001' }]) await assert.rejects(prepareWalletTransfer(session, input, options));
  state.eth = 0n; await assert.rejects(prepareWalletTransfer(session, INPUT, options), /Not enough ETH/);
  assert.equal(state.requests.length, 0);
});
test('failed recovery persistence aborts before wallet approval and ambiguous wallet errors are never retried', async () => {
  const first = fixture(); const review = await prepareWalletTransfer(first.session, INPUT, first.options);
  await assert.rejects(sendWalletTransfer(first.session, review, { ...first.options, beforePrompt() { throw new Error('storage full'); } }), /storage full/);
  assert.equal(first.state.requests.length, 0);
  const second = fixture(); const other = await prepareWalletTransfer(second.session, INPUT, second.options); second.state.error = new Error('response lost');
  await assert.rejects(sendWalletTransfer(second.session, other, second.options), /response lost/);
  await assert.rejects(sendWalletTransfer(second.session, other, second.options), /response lost/);
  assert.equal(second.state.requests.length, 1);
});
test('recovery accepts only the same account, nonce and chain and detects altered payment calldata', () => {
  const record = { from: FROM, nonce: 2, networkKey: 'sepolia', transaction: { to: TO, value: '0x1', data: '0x' } };
  const transaction = { from: FROM, nonce: 2, chainId: 11155111n, to: TO, value: 1n, data: '0x' };
  assert.equal(matchesSubmissionTransaction(record, transaction), true);
  assert.equal(matchesSubmissionTransaction(record, { ...transaction, value: 2n }), false);
  for (const patch of [{ from: TO }, { nonce: 3 }, { chainId: 1n }]) assert.throws(() => matchesSubmissionTransaction(record, { ...transaction, ...patch }));
});
