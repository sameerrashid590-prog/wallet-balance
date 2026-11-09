import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { initializeTransfers } from '../public/js/transfer-ui.js';
import { createTransferStore } from '../public/js/transfer-store.js';
import { USDC_ABI } from '../public/js/usdc-abi.js';
class Element {
  constructor() { this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() {}
}
const FROM = '0x1111111111111111111111111111111111111111', TO = '0x2222222222222222222222222222222222222222', HASH = '0x' + 'ab'.repeat(32), BLOCK = '0x' + 'cd'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
function review(asset = 'ETH') { return { reviewId: crypto.randomUUID(), expiresAt: Date.now() + 120000, generation: 1, networkKey: 'mainnet', networkName: 'Ethereum Mainnet', chainId: 1, from: FROM, to: TO, asset, amountUnits: asset === 'ETH' ? '1000000000000000' : '1234567', maxFeeWei: '1000000000', maxTotalWei: '1000001000000000', nonce: 0, contractAddress: asset === 'USDC' ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' : null, transaction: { from: FROM, to: asset === 'USDC' ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' : TO, value: asset === 'ETH' ? '0x38d7ea4c68000' : '0x0', data: '0x', nonce: '0x0', chainId: '0x1' } }; }
function payment() { return { transaction: { hash: HASH, from: FROM, to: TO, value: 1000000000000000n, data: '0x', chainId: 1n, type: 2, nonce: 0, blockNumber: 100, blockHash: BLOCK }, receipt: { hash: HASH, blockNumber: 100, blockHash: BLOCK, status: 1 }, recipientCode: '0x' }; }
function setup(t, options = {}) {
  const oldDocument = globalThis.document; const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  globalThis.document = { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [] }; t.after(() => { globalThis.document = oldDocument; });
  const saved = options.saved || new Map(); const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => { if (options.storageFailure) throw new Error('storage full'); saved.set(key, value); } };
  const store = createTransferStore(storage);
  let wallet = { address: options.connected === false ? null : FROM, chainId: options.chainId || 1, generation: 1 };
  let context = { mode: 'live', networkKey: 'mainnet', asset: 'ETH' }, callbacks, sends = 0, confirms = 0;
  const session = { snapshot: () => wallet, restore: async () => wallet, dispose() {}, async connect() { wallet = { ...wallet, address: FROM, generation: wallet.generation + 1 }; callbacks.onChange(wallet); }, disconnect() { wallet = { ...wallet, address: null, generation: wallet.generation + 1 }; callbacks.onChange(wallet); }, async switchNetwork() { wallet = { ...wallet, chainId: context.networkKey === 'sepolia' ? 11155111 : 1, generation: wallet.generation + 1 }; callbacks.onChange(wallet); } };
  const controller = initializeTransfers({ context: () => context, useTransfer: () => {}, onConfirmed: () => confirms++, readBalance: async () => 0n, readPayment: options.readPayment || (async () => payment()), store, locks: options.locks || null,
    sessionFactory(config) { callbacks = config; config.onWallets([{ id: 'fixture', name: 'Fixture wallet' }]); return session; },
    prepare: options.prepare || (async (session, input) => ({ ...review(input.asset), generation: wallet.generation })),
    send: async (session, approved, config) => { sends++; if (options.send) return options.send(session, approved, config); config.beforePrompt(); return HASH; },
  });
  t.after(() => controller.dispose()); get('send-recipient').value = TO; get('send-amount').value = '0.001';
  return { get, saved, store, controller, session, sends: () => sends, confirms: () => confirms, change(patch) { context = { ...context, ...patch }; controller.contextChanged(); }, account(address) { wallet = { ...wallet, address, generation: wallet.generation + 1 }; callbacks.onChange(wallet); } };
}
const prepare = fixture => fixture.get('send-form').listeners.submit({ preventDefault() {} });
const confirm = fixture => fixture.get('send-confirm-button').listeners.click();
async function waitFor(fixture, title) { for (let i = 0; i < 60; i++) { if (fixture.get('send-feedback').children[0]?.textContent === title) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.equal(fixture.get('send-feedback').children[0]?.textContent, title); }
test('disconnected state requests wallet connection and a successful connection enables review', async t => {
  const f = setup(t, { connected: false }); await tick();
  assert.equal(f.get('send-review-button').disabled, true); assert.equal(f.get('send-review-button').textContent, 'Connect your wallet first');
  await f.get('wallet-connect-button').listeners.click();
  assert.equal(f.get('send-review-button').disabled, false); assert.equal(f.get('send-account').textContent, FROM); assert.equal(f.sends(), 0);
});
test('wallet network mismatch requires an explicit switch and demo mode disables sending', async t => {
  const f = setup(t, { chainId: 11155111 }); await tick();
  assert.equal(f.get('send-review-button').disabled, true); assert.equal(f.get('wallet-switch-button').hidden, false);
  await f.get('wallet-switch-button').listeners.click(); assert.equal(f.get('send-review-button').disabled, false);
  f.change({ mode: 'demo' }); assert.equal(f.get('wallet-connect-button').disabled, true); assert.equal(f.get('send-review-button').disabled, true);
});
test('prepare is read-only and late reviews are discarded after network or account changes', async t => {
  let resolveReview;
  const f = setup(t, { prepare: () => new Promise(resolve => { resolveReview = resolve; }) }); await tick();
  const pending = prepare(f); assert.equal(f.get('send-review-button').attributes['aria-busy'], 'true');
  f.change({ networkKey: 'sepolia' }); resolveReview(review()); await pending;
  assert.equal(f.get('send-review').hidden, true); assert.equal(f.get('send-confirm-button').disabled, true); assert.equal(f.sends(), 0);
});
test('wallet account changes invalidate a prepared review before a request can be signed', async t => {
  const f = setup(t); await tick(); await prepare(f); f.account(TO); await confirm(f);
  assert.equal(f.sends(), 0); assert.equal(f.get('send-review').hidden, true);
});
test('confirmation saves public recovery details before the wallet request and proves the payment', async t => {
  let savedBeforePrompt = false;
  const f = setup(t, { send: async (session, approved, config) => { config.beforePrompt(); savedBeforePrompt = f.store.unresolved(FROM, 'mainnet').length === 1; return HASH; } });
  await tick(); await prepare(f); assert.equal(f.sends(), 0); await confirm(f);
  assert.equal(savedBeforePrompt, true); await waitFor(f, 'Exact payment matched');
  assert.equal(f.get('send-review-button').disabled, false); assert.equal(f.store.unresolved(FROM, 'mainnet').length, 0); assert.equal(f.confirms(), 1);
  await f.get('send-check-button').listeners.click(); assert.equal(f.confirms(), 1); await confirm(f); assert.equal(f.sends(), 1);
});
test('user rejection releases the review while ambiguous wallet errors keep recovery locked', async t => {
  const f = setup(t, { send: async (session, approved, config) => { config.beforePrompt(); throw Object.assign(new Error('declined'), { code: 4001 }); } });
  await tick(); await prepare(f); await confirm(f); assert.equal(f.get('send-review-button').disabled, false); assert.equal(f.store.unresolved(FROM, 'mainnet').length, 0);
  assert.equal(f.get('send-feedback').children[0].textContent, 'Wallet request declined');
});
test('a lost wallet response persists uncertainty and a pasted transaction hash recovers it', async t => {
  const f = setup(t, { send: async (session, approved, config) => { config.beforePrompt(); throw new Error('response lost'); } });
  await tick(); await prepare(f); await confirm(f);
  assert.equal(f.get('send-review-button').disabled, true); assert.equal(f.store.unresolved(FROM, 'mainnet')[0].hash, null);
  f.get('send-recovery-hash').value = HASH; await f.get('send-recover-button').listeners.click();
  assert.equal(f.get('send-feedback').children[0].textContent, 'Exact payment matched'); assert.equal(f.get('send-review-button').disabled, false); assert.equal(f.sends(), 1);
});
test('reloading recovers only pending submissions for this wallet and network', async t => {
  const saved = new Map(); const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) }; const store = createTransferStore(storage);
  const approved = review(); store.save({ id: approved.reviewId, ...approved, hash: HASH, state: 'submitted' });
  const f = setup(t, { saved }); await waitFor(f, 'Exact payment matched');
  assert.equal(f.sends(), 0); assert.equal(f.get('send-review-button').disabled, false);
});
test('a receipt with another signer or nonce cannot clear an uncertain request', async t => {
  const f = setup(t, { readPayment: async () => { const data = payment(); data.transaction.from = TO; return data; } });
  await tick(); await prepare(f); await confirm(f); await f.get('send-check-button').listeners.click();
  assert.equal(f.get('send-review-button').disabled, true); assert.equal(f.store.unresolved(FROM, 'mainnet').length, 1);
});
test('same-nonce replacement is tracked without falsely claiming the original payment succeeded', async t => {
  const f = setup(t, { readPayment: async () => { const data = payment(); data.transaction.value = 0n; return data; } });
  await tick(); await prepare(f); await confirm(f); await waitFor(f, 'Wallet request was replaced');
  assert.equal(f.get('send-review-button').disabled, false); assert.equal(f.confirms(), 0); assert.equal(f.store.records()[0].state, 'replaced');
});
test('USDC requires its matching Transfer event before reporting success or unlocking', async t => {
  const abi = new Interface(USDC_ABI), approved = review('USDC');
  const calldata = abi.encodeFunctionData('transfer', [TO, 1234567n]); approved.transaction.data = calldata;
  const data = { transaction: { ...payment().transaction, to: approved.contractAddress, value: 0n, data: calldata }, receipt: { ...payment().receipt, logs: [] }, contractAddress: approved.contractAddress, confirmations: 2 };
  const f = setup(t, { prepare: async () => approved, readPayment: async () => data }); await tick(); f.change({ asset: 'USDC' });
  await prepare(f); await confirm(f); await f.get('send-check-button').listeners.click();
  assert.equal(f.get('send-review-button').disabled, true); assert.equal(f.confirms(), 0);
  data.receipt.logs = [{ address: approved.contractAddress, ...abi.encodeEventLog(abi.getEvent('Transfer'), [FROM, TO, 1234567n]) }];
  await f.get('send-check-button').listeners.click(); assert.equal(f.get('send-review-button').disabled, false); assert.equal(f.confirms(), 1);
});
test('blocked storage or another tab lock prevents the wallet prompt', async t => {
  const f = setup(t, { storageFailure: true }); await tick(); await prepare(f); await confirm(f);
  assert.equal(f.store.records().length, 0); assert.equal(f.get('send-feedback').children[0].textContent, 'Could not send transfer');
});
test('one wallet cannot clear another wallet’s pending recovery state', async t => {
  const f = setup(t, { readPayment: async () => ({ transaction: null, receipt: null }) }); await tick(); await prepare(f); await confirm(f);
  f.account(TO); assert.equal(f.get('send-review-button').disabled, false);
  assert.equal(f.store.unresolved(FROM, 'mainnet').length, 1); f.account(FROM); assert.equal(f.get('send-review-button').disabled, true);
});
