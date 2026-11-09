// Mobile browser checks. Relay and wallet approvals are simulated; no funds move.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.js';
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
const app = createApp(); app.listen(0, '127.0.0.1'); await once(app, 'listening');
const base = 'http://127.0.0.1:' + app.address().port;
const mobile = { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' };
const ACCOUNT = '0x1111111111111111111111111111111111111111';
async function monitor(page) {
  await page.addInitScript(() => { window.__csp = []; window.addEventListener('securitypolicyviolation', e => window.__csp.push({ directive: e.violatedDirective, uri: e.blockedURI })); });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/rpc') return route.fulfill({ json: { result: route.request().postDataJSON().method === 'eth_chainId' ? '0x1' : '0x0' } });
    if (url.pathname === '/api/history') return route.fulfill({ json: { transactions: [] } });
    return route.continue();
  });
}
try {
  const actualContext = await browser.newContext(mobile), actual = await actualContext.newPage(); await monitor(actual);
  const errors = []; actual.on('pageerror', e => errors.push(e.message));
  await actual.routeWebSocket('wss://mm-sdk-relay.api.cx.metamask.io/**', socket => socket.onMessage(message => {
    for (const line of String(message).split('\n').filter(Boolean)) {
      const request = JSON.parse(line); if (!request.id) { socket.send('{}'); continue; }
      const response = request.connect ? { connect: { client: 'test-client', version: '1', ping: 0, pong: false } } : request.subscribe ? { subscribe: { recoverable: true, positioned: true, epoch: 'test', offset: 0 } } : request.history ? { history: { publications: [], epoch: 'test', offset: 0 } } : request.publish ? { publish: {} } : {};
      socket.send(JSON.stringify({ id: request.id, ...response }));
    }
  }));
  await actual.goto(base);
  assert.equal(await actual.evaluate(() => typeof window.ethereum), 'undefined');
  assert.match(await actual.locator('#wallet-select').textContent(), /MetaMask app \/ QR/);
  await actual.evaluate(async () => {
    const { createMetaMaskConnector } = await import('/js/metamask-connector.js');
    window.__sdkLink = null; window.__sdkError = null;
    window.__sdkConnector = createMetaMaskConnector({ openLink(link) { const url = new URL(link); window.__sdkLink = { protocol: url.protocol, containsSession: url.searchParams.has('id') || !!(url.searchParams.get('p') && url.searchParams.get('c')), path: url.pathname, queryKeys: [...url.searchParams.keys()] }; } });
    const button = document.createElement('button'); button.id = 'test-sdk-connect'; button.textContent = 'Test pairing';
    button.addEventListener('click', () => { window.__sdkConnector.connect('sepolia').catch(e => { if (e.name !== 'AbortError') window.__sdkError = e.message; }); }); document.body.append(button);
  });
  await actual.click('#test-sdk-connect');
  await actual.waitForFunction(() => window.__sdkLink || window.__sdkError, null, { timeout: 15000 });
  const boot = await actual.evaluate(() => ({ link: window.__sdkLink, error: window.__sdkError, csp: window.__csp }));
  assert.equal(boot.error, null, JSON.stringify({ boot, errors }));
  assert.equal(boot.link.protocol, 'metamask:'); assert.equal(boot.link.containsSession, true, JSON.stringify(boot)); assert.equal(boot.link.path, '/mwp');
  assert.deepEqual(boot.csp, []); assert.deepEqual(errors, []);
  await actual.evaluate(() => window.__sdkConnector.cancel()); await actualContext.close();
  const context = await browser.newContext(mobile), page = await context.newPage(); await monitor(page);
  await page.route('**/vendor/metamask-connect.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function createEVMClient(options) {
      window.__mobileOptions = options; window.__connectCalls = 0; window.__walletCalls = []; const events = new Map();
      let accounts = JSON.parse(localStorage.getItem('test-mobile-accounts') || '[]');
      const provider = { on(event, fn) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(fn); }, removeListener(event, fn) { events.get(event)?.delete(fn); }, async request(payload) { window.__walletCalls.push(payload.method); if (payload.method === 'eth_chainId') return '0x1'; if (payload.method === 'eth_accounts') return accounts; throw new Error('Unexpected wallet request'); } };
      return { get accounts() { return accounts; }, getProvider: () => provider,
        connect(config) { window.__connectCalls++; window.__requestedChains = config.chainIds; return new Promise((resolve, reject) => { window.__approveMobile = () => { accounts = ['0x1111111111111111111111111111111111111111']; localStorage.setItem('test-mobile-accounts', JSON.stringify(accounts)); resolve({ accounts, chainId: '0x1' }); }; window.__rejectMobile = () => reject(Object.assign(new Error('User rejected'), { code: 4001 })); }); },
        async disconnect() { accounts = []; localStorage.removeItem('test-mobile-accounts'); },
      };
    }
  ` }));
  await page.goto(base); assert.equal(await page.evaluate(() => window.__mobileOptions), undefined);
  await page.click('#wallet-connect-button'); await page.locator('#send-feedback').filter({ hasText: 'Approve the connection in MetaMask' }).waitFor();
  assert.equal(await page.locator('#wallet-cancel-connect-button').isVisible(), true);
  await page.evaluate(() => window.__approveMobile());
  await page.locator('#send-account').filter({ hasText: ACCOUNT }).waitFor(); await page.locator('#send-review-button:enabled').waitFor();
  assert.equal(await page.evaluate(() => window.__connectCalls), 1);
  assert.deepEqual(await page.evaluate(() => window.__walletCalls.filter(method => /sign|send/i.test(method))), []);
  await page.reload(); await page.locator('#send-account').filter({ hasText: ACCOUNT }).waitFor();
  assert.equal(await page.evaluate(() => window.__connectCalls), 0);
  await page.click('#wallet-disconnect-button'); await page.click('#wallet-connect-button');
  await page.locator('#wallet-cancel-connect-button:visible').waitFor(); await page.click('#wallet-cancel-connect-button');
  await page.locator('#send-feedback').filter({ hasText: 'Connection cancelled' }).waitFor();
  await page.evaluate(() => window.__approveMobile()); await page.waitForTimeout(30);
  assert.equal(await page.locator('#send-account').textContent(), 'No wallet connected'); assert.equal(await page.locator('#wallet-connect-button').isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/metamask-mobile.png', fullPage: true }); await context.close();
  console.log('PASS mobile Chrome: actual MetaMask SDK generates a session-bearing app link under CSP; app connects without injection, restores silently, cancels and ignores late approval. Relay/approval simulated. No signatures or transactions.');
} finally { await browser.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
