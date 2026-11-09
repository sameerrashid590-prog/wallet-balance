import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletSession } from '../public/js/wallet-session.js';
const FROM = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
function fixture() {
  const calls = [], handlers = new Map(), stored = new Map();
  const state = { accounts: [FROM], chain: '0x1', reject: false, unknownNetwork: false };
  const provider = { isMetaMask: true, on: (event, handler) => handlers.set(event, handler), removeListener: event => handlers.delete(event), async request(payload) {
    calls.push(payload);
    if (state.reject) throw Object.assign(new Error('declined'), { code: 4001 });
    if (['eth_requestAccounts', 'eth_accounts'].includes(payload.method)) return state.accounts;
    if (payload.method === 'eth_chainId') return state.chain;
    if (payload.method === 'wallet_switchEthereumChain') { if (state.unknownNetwork) { state.unknownNetwork = false; throw Object.assign(new Error('unknown network'), { code: 4902 }); } state.chain = payload.params[0].chainId; return null; }
    if (payload.method === 'wallet_addEthereumChain') return null;
    throw new Error('Unexpected wallet method');
  } };
  const target = new EventTarget(); const changes = [];
  const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const session = createWalletSession({ target, ethereum: () => provider, storage, onChange: value => changes.push(value) });
  return { session, provider, target, state, calls, handlers, stored, changes };
}
test('discovery is passive and connecting requests only public wallet accounts', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  await f.session.connect('injected-0');
  assert.deepEqual(f.calls.map(call => call.method), ['eth_requestAccounts', 'eth_chainId']);
  assert.equal(f.session.snapshot().address, FROM);
  await f.session.assertContext('mainnet', FROM); assert.equal(f.calls.at(-2).method, 'eth_accounts');
  f.session.dispose(); assert.equal(f.handlers.size, 0);
});
test('account and chain events invalidate reviews and locked/disconnected wallets clear the account', async () => {
  const f = fixture(); await f.session.connect(); const generation = f.session.snapshot().generation;
  f.state.accounts = [OTHER]; f.handlers.get('accountsChanged')([OTHER]);
  assert.equal(f.session.snapshot().address, OTHER); assert.ok(f.session.snapshot().generation > generation);
  await assert.rejects(f.session.assertContext('mainnet', FROM), /changed/);
  f.state.chain = '0xaa36a7'; f.handlers.get('chainChanged')(f.state.chain);
  await assert.rejects(f.session.assertContext('mainnet', OTHER), /Switch/);
  f.handlers.get('accountsChanged')([]); assert.equal(f.session.snapshot().address, null);
  f.session.dispose();
});
test('EIP-6963 discovers separate wallets and connects only the selected provider', async () => {
  const f = fixture(); let alternateCalls = 0;
  const provider = { async request({ method }) { alternateCalls++; return method === 'eth_chainId' ? '0x1' : [OTHER]; } };
  const event = new Event('eip6963:announceProvider'); event.detail = { info: { uuid: 'wallet-2', rdns: 'org.example.wallet', name: '<script>wallet</script>' }, provider }; f.target.dispatchEvent(event);
  assert.equal(f.session.wallets().length, 3);
  await f.session.connect('org.example.wallet'); assert.equal(f.session.snapshot().address, OTHER); assert.equal(f.calls.length, 0); assert.equal(alternateCalls, 2); f.session.dispose();
});
test('network switching uses only pinned chains and adds a missing chain before switching', async () => {
  const f = fixture(); await f.session.connect(); f.state.unknownNetwork = true;
  await f.session.switchNetwork('sepolia');
  const added = f.calls.find(call => call.method === 'wallet_addEthereumChain').params[0];
  assert.equal(added.chainId, '0xaa36a7'); assert.deepEqual(added.rpcUrls, ['https://ethereum-sepolia-rpc.publicnode.com']);
  assert.equal(f.session.snapshot().chainId, 11155111);
  await assert.rejects(f.session.switchNetwork('https://evil.example'), /Unsupported/); f.session.dispose();
});
test('restore uses eth_accounts without asking permission again; rejection never retries', async () => {
  const f = fixture(); f.stored.set('etherreceipt-wallet', 'injected-0'); await f.session.restore();
  assert.equal(f.calls[0].method, 'eth_accounts'); assert.ok(!f.calls.some(call => call.method === 'eth_requestAccounts'));
  f.session.disconnect(); f.state.reject = true; const count = f.calls.length;
  await assert.rejects(f.session.connect(), error => error.code === 4001); assert.equal(f.calls.length, count + 1); assert.equal(f.session.snapshot().address, null); f.session.dispose();
});
