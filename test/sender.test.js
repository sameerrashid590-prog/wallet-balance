import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Transaction, Wallet, parseEther, parseUnits } from 'ethers';
import { createSender } from '../lib/sender.js';
import { createSigningAuth } from '../lib/auth.js';
import { createApp } from '../server.js';
import { transferInput } from '../public/js/transfer-input.js';

// Published, deterministic test key. All providers below are in-memory mocks.
// These tests never contact a blockchain or broadcast a real transaction.
const TEST_KEY = '0x' + '11'.repeat(32);
const TO = '0x2222222222222222222222222222222222222222';
const FROM = new Wallet(TEST_KEY).address;
const INPUT = { recipient: TO, amount: '0.01', networkKey: 'sepolia' };
function fixture(options = {}) {
  const state = { now: 1000, nonce: 0, balance: parseEther('1'), gas: 21000n, code: '0x', chainId: '0xaa36a7', fee: parseUnits('20', 'gwei'), broadcasts: [], ...options.state };
  const sender = createSender({ env: { WALLET_PRIVATE_KEY: TEST_KEY, SEND_MAX_ETH: '0.1', ...options.env }, now: () => state.now, journal: options.journal, providerFactory: key => ({
    async send(method, params) {
      if (method === 'eth_chainId') return state.chainId;
      if (method === 'eth_sendRawTransaction') {
        state.broadcasts.push(Transaction.from(params[0]));
        if (state.onBroadcast) await state.onBroadcast();
        if (state.broadcastError) throw new Error('mock response lost');
        return state.broadcasts.at(-1).hash;
      }
      throw new Error('Unexpected mock method');
    },
    async getTransactionReceipt(hash) { state.receiptLookups = (state.receiptLookups || 0) + 1; if (state.receiptError) throw new Error('RPC unavailable'); return typeof state.receipt === 'function' ? state.receipt(hash) : state.receipt ?? null; },
    async getCode() { return state.code; },
    async getBalance() { return state.balance; },
    async getTransactionCount() { return state.nonce; },
    async getFeeData() { return { maxFeePerGas: state.fee, maxPriorityFeePerGas: parseUnits('1', 'gwei'), gasPrice: state.fee }; },
    async estimateGas() { return state.gas; },
    destroy() {},
  }) });
  return { state, sender };
}
test('backend signing is disabled without a locally configured key', async () => {
  const sender = createSender({ env: {} });
  assert.equal(sender.status().configured, false);
  assert.equal(sender.status().address, null);
  await assert.rejects(sender.prepare(INPUT), /not configured/);
});
test('invalid key/config errors do not expose submitted secrets', async () => {
  const sender = createSender({ env: { WALLET_PRIVATE_KEY: 'DO-NOT-ECHO-THIS' } });
  assert.equal(sender.status().configured, false);
  assert.ok(!JSON.stringify(sender.status()).includes('DO-NOT-ECHO-THIS'));
  await assert.rejects(sender.prepare(INPUT), e => !e.message.includes('DO-NOT-ECHO-THIS'));
});
test('transfer input rejects zero/self addresses and invalid or overprecise amounts', () => {
  for (const recipient of ['bad', '0x' + '00'.repeat(20), FROM]) assert.throws(() => transferInput({ ...INPUT, recipient }, FROM));
  for (const amount of ['0', '-1', '1e-3', '0.0000000000000000001']) assert.throws(() => transferInput({ ...INPUT, amount }, FROM));
  assert.equal(transferInput({ ...INPUT, amount: '0.000000000000000001' }, FROM).value, 1n);
});
test('preparing a review never signs/broadcasts and shows exact fee bounds', async () => {
  const { sender, state } = fixture(); const review = await sender.prepare(INPUT);
  assert.equal(state.broadcasts.length, 0);
  assert.equal(review.from, FROM); assert.equal(review.to, TO); assert.equal(review.chainId, 11155111);
  assert.equal(review.amountWei, parseEther('0.01').toString());
  assert.equal(BigInt(review.maxTotalWei), parseEther('0.01') + BigInt(review.maxFeeWei));
  assert.equal(BigInt(review.maxFeeWei), BigInt(review.gasLimit) * state.fee);
  assert.ok(!JSON.stringify(review).includes(TEST_KEY));
});
test('confirmation signs only the reviewed network, recipient, amount and fee cap', async () => {
  const { sender, state } = fixture(); const review = await sender.prepare(INPUT);
  const result = await sender.confirm({ reviewId: review.reviewId });
  assert.equal(result.broadcastStatus, 'submitted'); assert.equal(state.broadcasts.length, 1);
  const signed = state.broadcasts[0];
  assert.equal(signed.to, TO); assert.equal(signed.from, FROM); assert.equal(signed.value, parseEther('0.01'));
  assert.equal(signed.chainId, 11155111n); assert.equal(signed.gasLimit, BigInt(review.gasLimit));
  assert.equal(signed.maxFeePerGas, BigInt(review.feePerGasWei));
  assert.ok(!JSON.stringify(result).includes(TEST_KEY));
});
test('reusing a confirmation token cannot submit a second payment', async () => {
  const { sender, state } = fixture(); const review = await sender.prepare(INPUT);
  const first = await sender.confirm({ reviewId: review.reviewId });
  const second = await sender.confirm({ reviewId: review.reviewId });
  assert.deepEqual(first, second); assert.equal(state.broadcasts.length, 1);
});
test('a lost broadcast response returns an exact hash and never retries as a new payment', async () => {
  const { sender, state } = fixture({ state: { broadcastError: true } });
  const review = await sender.prepare(INPUT); const first = await sender.confirm({ reviewId: review.reviewId });
  assert.equal(first.broadcastStatus, 'unknown'); assert.match(first.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await sender.confirm({ reviewId: review.reviewId }), first);
  assert.equal(state.broadcasts.length, 1); assert.equal((await sender.getReview(review.reviewId)).state, 'unknown');
});
test('same-token concurrent requests and different reviews do not bypass the signing lock', async () => {
  const { sender, state } = fixture();
  const firstReview = await sender.prepare(INPUT); const otherReview = await sender.prepare(INPUT);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const hasStarted = new Promise(resolve => { started = resolve; });
  state.onBroadcast = async () => { started(); await gate; };
  const pending = sender.confirm({ reviewId: firstReview.reviewId }); await hasStarted;
  const same = await sender.confirm({ reviewId: firstReview.reviewId });
  assert.equal(same.broadcastStatus, 'unknown');
  await assert.rejects(sender.confirm({ reviewId: otherReview.reviewId }), /Another transfer/);
  release(); await pending; assert.equal(state.broadcasts.length, 1);
});
test('expired, cancelled, changed-nonce and increased-fee reviews cannot broadcast', async () => {
  for (const change of ['expire', 'cancel', 'nonce', 'fee', 'gas', 'balance', 'chain', 'code']) {
    const { sender, state } = fixture(); const review = await sender.prepare(INPUT);
    if (change === 'expire') state.now += 120001;
    if (change === 'cancel') sender.cancel({ reviewId: review.reviewId });
    if (change === 'nonce') state.nonce++;
    if (change === 'fee') state.fee *= 2n;
    if (change === 'gas') state.gas = 100000n;
    if (change === 'balance') state.balance = 0n;
    if (change === 'chain') state.chainId = '0x1';
    if (change === 'code') state.code = '0x6000';
    await assert.rejects(sender.confirm({ reviewId: review.reviewId }), undefined, change);
    assert.equal(state.broadcasts.length, 0, change);
  }
});
test('mainnet requires explicit configuration and keeps chain checks', async () => {
  const disabled = fixture(); await assert.rejects(disabled.sender.prepare({ ...INPUT, networkKey: 'mainnet' }), /Mainnet sending is disabled/);
  const enabled = fixture({ env: { ENABLE_MAINNET_SEND: 'true' }, state: { chainId: '0x1' } });
  const review = await enabled.sender.prepare({ ...INPUT, networkKey: 'mainnet' });
  await enabled.sender.confirm({ reviewId: review.reviewId });
  assert.equal(enabled.state.broadcasts[0].chainId, 1n);
});
test('amount limit, insufficient funds, contract accounts, network mismatch and extra fields reject before signing', async () => {
  for (const f of [fixture({ state: { balance: 0n } }), fixture({ state: { code: '0x6000' } }), fixture({ state: { chainId: '0x1' } })]) {
    await assert.rejects(f.sender.prepare(INPUT)); assert.equal(f.state.broadcasts.length, 0);
  }
  const { sender, state } = fixture();
  await assert.rejects(sender.prepare({ ...INPUT, amount: '0.100000000000000001' }), /per-transfer limit/);
  await assert.rejects(sender.prepare({ ...INPUT, privateKey: 'must-not-be-accepted' }), /Unexpected/);
  const review = await sender.prepare(INPUT);
  await assert.rejects(sender.confirm({ reviewId: review.reviewId, amount: '1' }), /Unexpected/);
  assert.equal(state.broadcasts.length, 0);
});
test('CSRF token rejects missing, incorrect and multibyte tokens', () => {
  const { sender } = fixture(); const status = sender.status();
  assert.doesNotThrow(() => sender.authorize(status.csrfToken));
  for (const token of [undefined, '', 'x'.repeat(64), 'é'.repeat(64)]) assert.throws(() => sender.authorize(token), e => e.status === 403);
});
test('public server never invokes an injected legacy signer or exposes the local key', async () => {
  const sender = new Proxy({}, { get() { throw new Error('Legacy signer must not be accessed'); } });
  const app = createApp({ sender, env: { WALLET_PRIVATE_KEY: TEST_KEY } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    for (const route of ['status', 'prepare', 'confirm', 'review?reviewId=test', 'login']) {
      const response = await fetch(base + '/api/sender/' + route, { method: ['prepare', 'confirm'].includes(route) ? 'POST' : 'GET' });
      assert.equal(response.status, 410); assert.ok(!(await response.text()).includes(TEST_KEY));
    }
    assert.equal((await fetch(base + '/.env')).status, 404);
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});

test('sending never silently defaults an omitted network to Mainnet', async () => {
  const { sender, state } = fixture({ env: { ENABLE_MAINNET_SEND: 'true' } });
  await assert.rejects(sender.prepare({ recipient: TO, amount: '0.01' }), /explicit Ethereum network/);
  assert.equal(state.broadcasts.length, 0);
});

test('MetaMask keys with or without 0x configure the same account', () => {
  for (const key of [TEST_KEY, TEST_KEY.slice(2), '  ' + TEST_KEY.slice(2) + '  ']) {
    const sender = createSender({ env: { WALLET_PRIVATE_KEY: key } });
    assert.equal(sender.status().configured, true);
    assert.equal(sender.status().address, FROM);
    assert.equal(JSON.stringify(sender.status()).includes(TEST_KEY.slice(2)), false);
  }
});

test('incomplete private key reports only its character count, never its value', () => {
  const incomplete = '0x' + 'ab'.repeat(31) + 'a';
  const sender = createSender({ env: { WALLET_PRIVATE_KEY: incomplete } });
  assert.equal(sender.status().configured, false);
  assert.match(sender.status().reason, /63 hexadecimal characters/);
  assert.match(sender.status().reason, /64 are required/);
  assert.equal(JSON.stringify(sender.status()).includes(incomplete), false);
});

function memoryJournal() {
  const records = new Map();
  return { fail: false, records: () => [...records.values()], save(id, result) { if (this.fail) throw new Error('disk full'); records.set(id, { id, result: structuredClone(result) }); } };
}
function minedReceipt(hash, status = 1) {
  return { hash, status, blockNumber: 12083885, blockHash: '0x' + 'cd'.repeat(32) };
}
test('mined receipt refresh persists resolution and survives restarting the sender', async () => {
  const journal = memoryJournal();
  const { sender, state } = fixture({ journal });
  const review = await sender.prepare(INPUT);
  const submitted = await sender.confirm({ reviewId: review.reviewId });
  assert.deepEqual(sender.status().pendingReviews, [{ reviewId: review.reviewId, networkKey: 'sepolia' }]);
  await assert.rejects(sender.prepare(INPUT), e => e.status === 409 && e.message.includes(submitted.hash));
  state.receipt = minedReceipt(submitted.hash);
  const updated = await sender.getReview(review.reviewId);
  assert.equal(updated.state, 'mined');
  assert.equal(updated.result.receiptStatus, 'success');
  assert.equal(journal.records()[0].result.blockNumber, 12083885);
  assert.deepEqual(sender.status().pendingReviews, []);
  await sender.prepare(INPUT);
  const restarted = fixture({ journal, state: { receiptError: true } });
  assert.equal((await restarted.sender.getReview(review.reviewId)).state, 'mined');
  await restarted.sender.prepare(INPUT);
  assert.equal(restarted.state.receiptLookups, undefined, 'Persisted mined receipt must not become pending again');
  assert.equal(state.broadcasts.length, 1);
  assert.equal(restarted.state.broadcasts.length, 0);
});
test('prepare automatically reconciles an old mined submission without a browser receipt check', async () => {
  for (const status of [0, 1]) {
    const { sender, state } = fixture();
    const review = await sender.prepare(INPUT);
    const submitted = await sender.confirm({ reviewId: review.reviewId });
    state.receipt = minedReceipt(submitted.hash, status);
    await sender.prepare(INPUT);
    const refreshed = await sender.getReview(review.reviewId);
    assert.equal(refreshed.result.receiptStatus, status === 1 ? 'success' : 'failed');
    assert.equal(state.broadcasts.length, 1);
  }
});
test('pending or unreachable receipts keep the guard and return the recoverable hash', async () => {
  const { sender, state } = fixture();
  const review = await sender.prepare(INPUT);
  const submitted = await sender.confirm({ reviewId: review.reviewId });
  const pending = await sender.getReview(review.reviewId);
  assert.equal(pending.result.hash, submitted.hash);
  assert.equal(pending.state, 'submitted');
  assert.equal(pending.lookupError, null);
  state.receiptError = true;
  const unavailable = await sender.getReview(review.reviewId);
  assert.equal(unavailable.result.hash, submitted.hash);
  assert.match(unavailable.lookupError, /RPC/);
  await assert.rejects(sender.prepare(INPUT));
  assert.equal(state.broadcasts.length, 1);
});
test('invalid receipts and failed persistence cannot clear submission tracking', async () => {
  const journal = memoryJournal();
  const { sender, state } = fixture({ journal });
  const review = await sender.prepare(INPUT);
  const submitted = await sender.confirm({ reviewId: review.reviewId });
  for (const receipt of [minedReceipt('0x' + 'ef'.repeat(32)), { ...minedReceipt(submitted.hash), status: null }, { ...minedReceipt(submitted.hash), blockHash: null }]) {
    state.receipt = receipt;
    await assert.rejects(sender.prepare(INPUT), /invalid receipt/);
    assert.equal(sender.status().pendingReviews.length, 1);
  }
  state.receipt = minedReceipt(submitted.hash);
  journal.fail = true;
  const unavailable = await sender.getReview(review.reviewId);
  assert.match(unavailable.lookupError, /save the confirmed receipt/);
  assert.equal(unavailable.result.receiptStatus, undefined);
  await assert.rejects(sender.prepare(INPUT), /save the confirmed receipt/);
  journal.fail = false;
  await sender.prepare(INPUT);
  assert.equal(sender.status().pendingReviews.length, 0);
  assert.equal(state.broadcasts.length, 1);
});
test('uncertain broadcast becomes mined without re-signing or broadcasting again', async () => {
  const { sender, state } = fixture({ state: { broadcastError: true } });
  const review = await sender.prepare(INPUT);
  const submitted = await sender.confirm({ reviewId: review.reviewId });
  assert.equal(submitted.broadcastStatus, 'unknown');
  state.receipt = minedReceipt(submitted.hash);
  const recovered = await sender.getReview(review.reviewId);
  assert.equal(recovered.result.broadcastStatus, 'submitted');
  assert.equal(recovered.result.receiptStatus, 'success');
  assert.deepEqual(await sender.confirm({ reviewId: review.reviewId }), recovered.result);
  assert.equal(state.broadcasts.length, 1);
});
test('public health reports connected-wallet signing without exposing a server account', async () => {
  const app = createApp({ env: { WALLET_PRIVATE_KEY: TEST_KEY } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    const body = await fetch('http://127.0.0.1:' + app.address().port + '/api/health').then(response => response.json());
    assert.equal(body.signing, 'connected-wallet'); assert.equal(body.address, undefined);
    assert.ok(!JSON.stringify(body).includes(TEST_KEY));
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});

test('production receipt reader reconciles a stale primary using a raw fallback receipt', async () => {
  const journal = memoryJournal();
  const id = '12'.repeat(32), hash = '0x' + 'ab'.repeat(32);
  journal.save(id, { hash, networkKey: 'sepolia', from: FROM, to: TO, amountWei: '1', asset: 'ETH', broadcastStatus: 'submitted' });
  const methods = [];
  const sender = createSender({ env: { WALLET_PRIVATE_KEY: TEST_KEY, SEPOLIA_RPC_URL: 'https://stale.example' }, journal, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body); methods.push(payload.method);
    const result = payload.method === 'eth_chainId' ? '0xaa36a7' : url.includes('ethpandaops') ? { transactionHash: hash, status: '0x1', blockNumber: '0xb863ad', blockHash: '0x' + 'cd'.repeat(32), logs: [] } : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  } });
  const state = await sender.getReview(id);
  assert.equal(state.state, 'mined');
  assert.equal(state.result.receiptStatus, 'success');
  assert.equal(state.result.blockNumber, Number(0xb863ad));
  assert.equal(journal.records()[0].result.receiptStatus, 'success');
  assert.ok(methods.every(method => ['eth_chainId', 'eth_getTransactionReceipt'].includes(method)));
});
test('receipt polling during broadcast cannot be overwritten by a late submission response', async () => {
  const { sender, state } = fixture();
  const review = await sender.prepare(INPUT);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  state.onBroadcast = async () => { started(); await gate; };
  const confirming = sender.confirm({ reviewId: review.reviewId });
  await ready;
  state.receipt = minedReceipt(state.broadcasts[0].hash);
  assert.equal((await sender.getReview(review.reviewId)).state, 'mined');
  release();
  const result = await confirming;
  assert.equal(result.receiptStatus, 'success');
  assert.match(result.message, /mined successfully/);
  assert.equal((await sender.getReview(review.reviewId)).state, 'mined');
  assert.equal(state.broadcasts.length, 1);
});
