import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaMaskConnector, metamaskBrowserUrl, METAMASK_CONNECT_ID } from '../public/js/metamask-connector.js';
import { createWalletSession } from '../public/js/wallet-session.js';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
function fixture({ restored = false, deferred = false } = {}) {
  const state = { loads: 0, options: null, connects: [], requests: [], disconnects: 0, accounts: restored ? [ACCOUNT] : [], chain: '0x1', resolve: null };
  const handlers = new Map();
  const emit = (name, ...args) => { for (const handler of handlers.get(name) || []) handler(...args); };
  const provider = { on(event, handler) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); }, removeListener(event, handler) { handlers.get(event)?.delete(handler); }, async request(payload) { state.requests.push(payload); if (payload.method === 'eth_chainId') return state.chain; if (payload.method === 'eth_accounts') return state.accounts; if (payload.method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32); throw new Error('Unexpected provider request'); } };
  const client = { get accounts() { return state.accounts; }, getProvider: () => provider, async connect(options) { state.connects.push(options); if (deferred) await new Promise(resolve => { state.resolve = resolve; }); state.accounts = [ACCOUNT]; state.chain = options.chainIds[0]; emit('accountsChanged', state.accounts); return { accounts: state.accounts, chainId: state.chain }; }, async disconnect() { state.disconnects++; state.accounts = []; emit('disconnect'); } };
  const loadClient = async () => { state.loads++; return { createEVMClient: async options => { state.options = options; return client; } }; };
  const statuses = []; const connector = createMetaMaskConnector({ loadClient, location: { href: 'https://payments.example/invoice?private=omit#fragment', origin: 'https://payments.example' }, onStatus: status => statuses.push(status) });
  return { state, client, connector, emit, statuses };
}
test('mobile connector is lazy and configures only supported chains, safe metadata and disabled analytics', async () => {
  const f = fixture(); assert.equal(f.state.loads, 0);
  assert.deepEqual(await f.connector.connect('sepolia'), [ACCOUNT]);
  assert.equal(f.state.loads, 1); assert.equal(f.state.options.dapp.url, 'https://payments.example');
  assert.equal(f.state.options.analytics.enabled, false); assert.equal(f.state.options.skipAutoAnnounce, true);
  assert.equal(f.state.options.mobile.useDeeplink, true); assert.equal(f.state.options.ui.showInstallModal, false);
  assert.deepEqual(f.state.connects[0].chainIds, ['0xaa36a7', '0x1', '0x88bb0']);
  assert.deepEqual(Object.keys(f.state.options.api.supportedNetworks), ['0x1', '0xaa36a7', '0x88bb0']);
  assert.ok(!f.state.options.dapp.url.includes('private')); f.connector.dispose();
});
test('restoring a MetaMask app session never opens a connection or signature prompt', async () => {
  const f = fixture({ restored: true }); assert.deepEqual(await f.connector.connect('mainnet', false), [ACCOUNT]);
  assert.equal(f.state.connects.length, 0); assert.deepEqual(await f.connector.provider.request({ method: 'eth_accounts' }), [ACCOUNT]);
  assert.equal(f.state.connects.length, 0); f.connector.dispose();
});
test('mobile provider forwards account/network events and reviewed requests through the same SDK session', async () => {
  const f = fixture(); await f.connector.connect('mainnet'); let changed = null;
  f.connector.provider.on('accountsChanged', accounts => { changed = accounts; }); f.emit('accountsChanged', [ACCOUNT]); assert.deepEqual(changed, [ACCOUNT]);
  const request = { method: 'eth_sendTransaction', params: [{ from: ACCOUNT, to: ACCOUNT, value: '0x0' }] };
  assert.match(await f.connector.provider.request(request), /^0x[0-9a-f]{64}$/); assert.deepEqual(f.state.requests.at(-1), request);
  await f.connector.disconnect(); assert.equal(f.state.disconnects, 1); f.connector.dispose();
});
test('cancelling mobile pairing rejects late approval and clears a late SDK session', async () => {
  const f = fixture({ deferred: true }); const pending = f.connector.connect('mainnet');
  while (!f.state.resolve) await new Promise(resolve => setImmediate(resolve));
  f.connector.cancel(); f.state.resolve(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(f.state.accounts, []); assert.ok(f.state.disconnects >= 1); f.connector.dispose();
});
test('mobile Chrome with no injected wallet can connect and restore through the app connector', async () => {
  const f = fixture(); let created = 0; const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const session = createWalletSession({ target: new EventTarget(), ethereum: () => undefined, storage, mobileFactory: () => { created++; return f.connector; } });
  assert.deepEqual(session.wallets(), [{ id: METAMASK_CONNECT_ID, name: 'MetaMask app / QR' }]); assert.equal(f.state.loads, 0);
  await session.connect(METAMASK_CONNECT_ID, true, 'sepolia'); assert.equal(session.snapshot().address, ACCOUNT); assert.equal(session.snapshot().chainId, 11155111);
  await session.assertContext('sepolia', ACCOUNT); assert.equal(values.get('etherreceipt-wallet'), METAMASK_CONNECT_ID);
  const before = session.snapshot().generation; await session.refresh(); assert.equal(session.snapshot().generation, before, 'Returning to Chrome with unchanged state must keep the review valid');
  assert.equal(created, 1); assert.equal(f.state.connects.length, 1); await session.disconnect(); session.dispose();
});
test('a cancelled connection cannot reattach an account after returning from the app', async () => {
  const f = fixture({ deferred: true }); const session = createWalletSession({ target: new EventTarget(), ethereum: () => undefined, storage: null, mobileFactory: () => f.connector });
  const pending = session.connect(METAMASK_CONNECT_ID);
  while (!f.state.resolve) await new Promise(resolve => setImmediate(resolve));
  session.cancelConnection(); f.state.resolve(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(session.snapshot().address, null); session.dispose();
});
test('fallback app-browser link targets this HTTPS site and omits query/fragment data', () => {
  assert.equal(metamaskBrowserUrl({ href: 'https://payments.example/path?token=secret#fragment' }), 'https://link.metamask.io/dapp/payments.example/path');
  for (const href of ['http://payments.example', 'https://localhost/', 'file:///tmp/app']) assert.equal(metamaskBrowserUrl({ href }), null);
});

test('cancel does not wait for a mobile app response before rejecting the pending request', async () => {
  const f = fixture({ deferred: true }); const pending = f.connector.connect('mainnet');
  while (!f.state.resolve) await new Promise(resolve => setImmediate(resolve));
  f.connector.cancel();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.deepEqual(f.state.accounts, []);
  f.state.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.state.accounts, []); f.connector.dispose();
});
