// Deterministic browser wallet simulation. No live wallet, keys or broadcasts.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Interface } from 'ethers';
import { createApp } from '../server.js';
import { USDC_ABI } from '../public/js/usdc-abi.js';
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const FROM = '0x1111111111111111111111111111111111111111', TO = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'ab'.repeat(32), BLOCK = '0x' + 'cd'.repeat(32), CONTRACT = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const abi = new Interface(USDC_ABI);
const encoded = { decimals: abi.encodeFunctionResult('decimals', [6]), symbol: abi.encodeFunctionResult('symbol', ['USDC']), balance: abi.encodeFunctionResult('balanceOf', [123456789n]) };
const app = createApp(); app.listen(0, '127.0.0.1'); await once(app, 'listening');
const base = 'http://127.0.0.1:' + app.address().port;
const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [], apiRequests = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(({ FROM, HASH, BLOCK, CONTRACT, encoded }) => {
  const listeners = new Map(); let chain = '0x1';
  window.__walletRequests = []; window.__sentTx = null;
  window.ethereum = {
    isMetaMask: true,
    on(event, handler) { listeners.set(event, handler); }, removeListener(event) { listeners.delete(event); },
    async request(payload) {
      window.__walletRequests.push(payload);
      if (['eth_accounts', 'eth_requestAccounts'].includes(payload.method)) return [FROM];
      if (payload.method === 'eth_chainId') return chain;
      if (payload.method === 'wallet_switchEthereumChain') { chain = payload.params[0].chainId; listeners.get('chainChanged')?.(chain); return null; }
      if (payload.method === 'eth_getCode') return payload.params[0].toLowerCase() === CONTRACT.toLowerCase() ? '0x6000' : '0x';
      if (payload.method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (payload.method === 'eth_getTransactionCount') return '0x0';
      if (payload.method === 'eth_gasPrice') return '0x4a817c800';
      if (payload.method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
      if (payload.method === 'eth_getBlockByNumber') return { hash: BLOCK, parentHash: '0x' + '00'.repeat(32), number: '0x64', timestamp: '0x654321', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x5208', miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [], baseFeePerGas: '0x3b9aca00' };
      if (payload.method === 'eth_estimateGas') return payload.params[0].data === '0x' ? '0x5208' : '0xfde8';
      if (payload.method === 'eth_call') { const data = payload.params[0].data; return data.startsWith('0x313ce567') ? encoded.decimals : data.startsWith('0x95d89b41') ? encoded.symbol : encoded.balance; }
      if (payload.method === 'eth_sendTransaction') { window.__sentTx = payload.params[0]; return HASH; }
      throw new Error('Unexpected mocked wallet method: ' + payload.method);
    },
  };
}, { FROM, HASH, BLOCK, CONTRACT, encoded });
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()); apiRequests.push(url.pathname);
  if (url.pathname.startsWith('/api/sender')) throw new Error('Legacy server signing request is forbidden.');
  if (url.pathname === '/api/usdc') return route.fulfill({ json: { balance: '123456789', symbol: 'USDC', decimals: 6, contractAddress: CONTRACT } });
  if (url.pathname === '/api/history') return route.fulfill({ json: { transactions: [] } });
  if (url.pathname !== '/api/rpc') return route.continue();
  const payload = route.request().postDataJSON(); const network = url.searchParams.get('network'); let result;
  if (payload.method === 'eth_chainId') result = network === 'sepolia' ? '0xaa36a7' : network === 'hoodi' ? '0x88bb0' : '0x1';
  else if (payload.method === 'eth_blockNumber') result = '0x65';
  else if (payload.method === 'eth_getCode') result = '0x';
  else if (payload.method === 'eth_getBalance') result = '0xde0b6b3a7640000';
  else if (['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(payload.method)) {
    const sent = await page.evaluate(() => window.__sentTx);
    if (!sent) result = null;
    else if (payload.method === 'eth_getTransactionByHash') result = { hash: HASH, type: sent.type, from: FROM, to: sent.to, value: sent.value, input: sent.data, nonce: sent.nonce, gas: sent.gas, gasPrice: sent.maxFeePerGas, maxFeePerGas: sent.maxFeePerGas, maxPriorityFeePerGas: sent.maxPriorityFeePerGas, chainId: sent.chainId, blockHash: BLOCK, blockNumber: '0x64', transactionIndex: '0x0', accessList: [], v: '0x0', r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
    else {
      const event = abi.encodeEventLog(abi.getEvent('Transfer'), [FROM, TO, 1234567n]);
      result = { transactionHash: HASH, blockHash: BLOCK, blockNumber: '0x64', from: FROM, to: sent.to, transactionIndex: '0x0', cumulativeGasUsed: '0xfde8', gasUsed: '0xfde8', effectiveGasPrice: '0x3b9aca00', contractAddress: null, logsBloom: '0x' + '00'.repeat(256), status: '0x1', type: '0x2', logs: [{ address: CONTRACT, ...event, blockNumber: '0x64', blockHash: BLOCK, transactionHash: HASH, transactionIndex: '0x0', logIndex: '0x0', removed: false }] };
    }
  } else throw new Error('Unexpected app RPC: ' + payload.method);
  return route.fulfill({ json: { result } });
});
try {
  await page.goto(base);
  await page.locator('#wallet-connect-button:enabled').waitFor();
  assert.equal(await page.locator('#send-review-button').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__walletRequests.length), 0, 'Loading must not request wallet access');
  await page.click('#wallet-connect-button'); await page.locator('#send-account').filter({ hasText: FROM }).waitFor();
  await page.selectOption('#network-select', 'sepolia'); assert.equal(await page.locator('#send-review-button').isDisabled(), true);
  await page.click('#wallet-switch-button'); await page.locator('#send-review-button:enabled').waitFor();
  await page.selectOption('#asset-select', 'USDC');
  await page.fill('#send-recipient', TO); await page.fill('#send-amount', '1.234567'); await page.click('#send-review-button');
  await page.locator('#send-review:not([hidden])').waitFor();
  assert.match(await page.locator('#send-review-details').textContent(), /1.234567 USDC/);
  assert.equal(await page.evaluate(() => window.__walletRequests.filter(call => call.method === 'eth_sendTransaction').length), 0);
  await page.click('#send-confirm-button');
  await page.locator('#send-feedback').filter({ hasText: /Exact USDC payment matched/ }).waitFor({ timeout: 15000 });
  const sent = await page.evaluate(() => window.__walletRequests.filter(call => call.method === 'eth_sendTransaction'));
  assert.equal(sent.length, 1); assert.equal(sent[0].params[0].from, FROM); assert.equal(sent[0].params[0].to, CONTRACT);
  assert.equal(sent[0].params[0].value, '0x0'); assert.equal(sent[0].params[0].chainId, '0xaa36a7');
  assert.equal(sent[0].params[0].data, abi.encodeFunctionData('transfer', [TO, 1234567n]));
  assert.equal(await page.locator('#send-review-button').isEnabled(), true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/wallet-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/wallet-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile layout must not overflow');
  await page.click('#wallet-disconnect-button'); assert.equal(await page.locator('#send-review-button').isDisabled(), true);
  await page.fill('#wallet-address', FROM); await page.click('#wallet-button'); await page.locator('#balance-result').filter({ hasText: '123.456789' }).waitFor();
  assert.ok(!apiRequests.some(path => path.startsWith('/api/sender'))); assert.deepEqual(errors, []);
  console.log('PASS Chrome: passive discovery, wallet connection, explicit chain switching, immutable USDC review, one simulated wallet approval, exact receipt/event proof, disconnect, public lookups, and desktop/mobile layout. No real signing or broadcast.');
} catch (e) {
  console.error('Browser errors:', JSON.stringify(errors));
  console.error('Transfer message:', await page.locator('#send-feedback').textContent()); throw e;
} finally { await browser.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
