import { formatEther } from 'ethers';
import { assetAmount, assetInfo, formatAsset } from './assets.js';
import { verifyUsdcPayment } from './usdc-verification.js';
import { initializeTransfers } from './transfer-ui.js';
import { DEFAULT_NETWORK, getNetwork } from './networks.js';
import { paymentInput, addressInput, hashInput, verifyPayment } from './verification.js';
import { scenarios, DEMO_WALLET, demoBalance, demoHistory, demoPayment } from './demo.js';
import { liveBalance, liveHistory, livePayment } from './api.js';

const $ = id => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
let mode = 'live';
let selectedAsset = 'ETH';
let lastLiveAsset = 'ETH';
let transfers = null;
let selectedNetworkKey = DEFAULT_NETWORK;
let lastLiveNetwork = DEFAULT_NETWORK;
const selectedNetwork = () => getNetwork(selectedNetworkKey);
const jobs = { payment: { version: 0, controller: null }, wallet: { version: 0, controller: null } };
const paymentFields = [$('recipient'), $('expected'), $('tx-hash'), $('expected-sender')];
function cancel(kind) {
  const job = jobs[kind];
  job.version++;
  job.controller?.abort();
  $(kind === 'payment' ? 'verify-button' : 'wallet-button').disabled = false;
  $(kind === 'payment' ? 'payment-form' : 'wallet-form').setAttribute('aria-busy', 'false');
  $(kind === 'payment' ? 'verify-button' : 'wallet-button').firstChild.textContent = kind === 'payment' ? 'Verify payment' : 'Look up wallet ';
}
function begin(kind) {
  cancel(kind);
  const job = jobs[kind];
  const version = job.version;
  job.controller = new AbortController();
  const button = $(kind === 'payment' ? 'verify-button' : 'wallet-button');
  button.disabled = true;
  button.firstChild.textContent = kind === 'payment' ? 'Checking payment…' : 'Looking up…';
  $(kind === 'payment' ? 'payment-form' : 'wallet-form').setAttribute('aria-busy', 'true');
  return { signal: job.controller.signal, current: () => job.version === version, finish: () => {
    if (job.version === version) cancel(kind);
  } };
}
function loading(node, text) {
  const line = el('div', undefined, 'loading');
  const spinner = el('span', undefined, 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  line.append(spinner, el('span', text));
  node.replaceChildren(line);
}
function placeholder() {
  const box = $('payment-result');
  box.className = 'result';
  const wrap = el('div', undefined, 'result-placeholder');
  const icon = el('span', '↗', 'result-icon');
  icon.setAttribute('aria-hidden', 'true');
  const copy = el('div');
  copy.append(el('h3', 'A little certainty starts here.'), el('p', 'Enter your payment details, then run a check.'));
  wrap.append(icon, copy);
  box.replaceChildren(wrap);
}
function short(value) { return value ? value.slice(0, 6) + '…' + value.slice(-4) : 'Contract creation'; }
function explorerLink(hash, text) {
  hash = hashInput(hash);
  if (mode === 'demo') return el('span', text + ' · fictional', 'tx-hash');
  const link = el('a', text + ' ↗', 'tx-hash');
  link.href = selectedNetwork().explorer + '/tx/' + hash;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', 'View transaction ' + hash + ' on ' + selectedNetwork().name + ' Etherscan (new tab)');
  return link;
}
function showPayment(result, data, input) {
  const box = $('payment-result');
  box.className = 'result ' + result.tone;
  box.replaceChildren(el('div', mode === 'demo' ? 'DEMO RESULT / FICTIONAL TRANSACTION' : selectedNetwork().name.toUpperCase() + ' / LIVE LOOKUP RESULT', 'result-tag'), el('h3', result.title), el('p', result.message));
  if (result.scopeWarning) box.append(el('p', result.scopeWarning, 'scope-warning'));
  const details = el('dl', undefined, 'result-details');
  const row = (label, value) => { const div = el('div'); div.append(el('dt', label), el('dd', value)); details.append(div); };
  row('Network', selectedNetwork().name + ' / chain ID ' + selectedNetwork().chainId);
  row('Expected', input.expected + ' ' + selectedAsset);
  const tx = data.transaction;
  if (tx) {
    row('Sender', tx.from);
    row('Recipient', selectedAsset === 'USDC' ? result.paymentRecipient || 'Not proven' : tx.to || 'Contract creation');
    if (selectedAsset === 'USDC') { row('USDC contract', data.contractAddress); row('Confirmations', String(data.confirmations)); }
    row(data.receipt?.status === 0 ? 'Attempted' : !data.receipt ? 'Submitted' : 'Tx value', selectedAsset === 'USDC' ? (result.paidUnits !== undefined ? formatAsset(result.paidUnits, 'USDC') + ' USDC' : 'USDC payment not proven') : formatEther(tx.value) + ' ETH');
    row('Execution', !data.receipt ? 'No receipt' : data.receipt.status === 1 ? 'Succeeded' : 'Failed');
    if (data.receipt) row('Block', String(data.receipt.blockNumber));
  }
  const linkRow = el('div'); const dd = el('dd'); dd.append(explorerLink(input.hash, short(input.hash)));
  linkRow.append(el('dt', 'Transaction'), dd); details.append(linkRow); box.append(details);
  box.append(el('p', 'A mined match is not finality: a chain reorganization can change it. The sender address does not verify a person’s identity.', 'reorg'));
}
$('payment-form').addEventListener('submit', async event => {
  event.preventDefault(); cancel('payment');
  const input = { recipient: $('recipient').value, expected: $('expected').value, hash: $('tx-hash').value, asset: selectedAsset, sender: $('expected-sender').value.trim() || undefined };
  for (const field of paymentFields) field.removeAttribute('aria-invalid');
  try { paymentInput(input); if (input.sender) addressInput(input.sender); }
  catch (error) {
    for (const [field, validate] of [[$('recipient'), addressInput], [$('expected'), value => assetAmount(value, selectedAsset)], [$('expected-sender'), value => { if (value.trim()) addressInput(value); }], [$('tx-hash'), hashInput]]) {
      try { validate(field.value); } catch { field.setAttribute('aria-invalid', 'true'); }
    }
    $('payment-result').className = 'result danger';
    $('payment-result').replaceChildren(el('h3', 'Check your payment details'), el('p', error.message));
    paymentFields.find(field => field.getAttribute('aria-invalid') === 'true')?.focus(); return;
  }
  const job = begin('payment');
  loading($('payment-result'), mode === 'demo' ? 'Checking fictional transaction…' : 'Reading ' + selectedNetwork().name + ' transaction and receipt…');
  try {
    const data = mode === 'demo' ? demoPayment(input.hash.trim()) : await livePayment(input.hash, job.signal, selectedNetworkKey, selectedAsset);
    if (job.current()) showPayment((selectedAsset === 'USDC' ? verifyUsdcPayment : verifyPayment)(input, data, { networkName: selectedNetwork().name, chainId: selectedNetwork().chainId }), data, input);
  } catch (error) {
    if (job.current()) {
      $('payment-result').className = 'result danger';
      $('payment-result').replaceChildren(el('h3', 'Payment lookup unavailable'), el('p', error.message));
    }
  } finally { job.finish(); }
});
for (const field of paymentFields) field.addEventListener('input', () => { cancel('payment'); field.removeAttribute('aria-invalid'); placeholder(); });
function loadScenario() {
  cancel('payment');
  const scenario = scenarios.find(s => s.id === $('scenario').value);
  $('recipient').value = scenario.input.recipient;
  $('expected').value = scenario.input.expected;
  $('tx-hash').value = scenario.input.hash;
  for (const field of paymentFields) field.removeAttribute('aria-invalid');
  placeholder();
}
for (const s of scenarios) { const option = el('option', s.label); option.value = s.id; $('scenario').append(option); }
$('scenario').addEventListener('change', loadScenario);

function renderBalance(wei) {
  const value = el('div', formatAsset(wei, selectedAsset), 'balance-value'); value.append(el('span', selectedAsset));
  $('balance-result').replaceChildren(value);
}
function renderHistory(transactions, wallet) {
  $('history-count').textContent = String(transactions.length);
  if (!transactions.length) {
    $('history-result').replaceChildren(el('div', mode === 'demo' ? 'No fictional history for this address. Use the prefilled demo wallet for the sample ledger.' : 'No asset transactions found for this address on ' + selectedNetwork().name + '.', 'empty-state')); return;
  }
  const list = el('ol', undefined, 'tx-list');
  for (const tx of transactions) {
    const isFrom = tx.from.toLowerCase() === wallet.toLowerCase();
    const isTo = tx.to?.toLowerCase() === wallet.toLowerCase();
    const direction = isFrom && isTo ? 'Self-transfer' : isFrom ? 'Outgoing' : isTo ? 'Incoming' : 'Contract creation';
    const item = el('li', undefined, 'tx-row');
    const icon = el('span', direction === 'Self-transfer' ? '↻' : isFrom ? '↗' : '↙', 'tx-icon' + (isFrom ? ' outgoing' : ''));
    icon.setAttribute('aria-hidden', 'true');
    const main = el('div', undefined, 'tx-main');
    main.append(el('span', direction, 'tx-name'));
    const date = new Date(Number(tx.timeStamp) * 1000);
    const dateText = Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
    const peer = direction === 'Self-transfer' ? 'Same wallet' : (isFrom ? 'To ' : 'From ') + short(isFrom ? tx.to : tx.from);
    main.append(el('div', dateText + ' · ' + peer, 'tx-meta'), explorerLink(tx.hash, short(tx.hash)));
    if (tx.input !== '0x') main.append(el('div', 'Contract call data', 'tx-meta'));
    const value = el('div', formatAsset(BigInt(tx.value), selectedAsset) + ' ' + selectedAsset, 'tx-amount');
    if (tx.status === 'failed') value.append(el('span', 'Attempted amount', 'attempted'));
    if (tx.status === 'unknown') value.append(el('span', 'Unconfirmed outcome', 'attempted'));
    value.append(el('span', tx.status === 'failed' ? 'Failed' : tx.status === 'success' ? 'Succeeded' : tx.status === 'indexed' ? 'Indexed transfer' : 'Status unavailable', 'tx-status ' + tx.status));
    item.append(icon, main, value); list.append(item);
  }
  $('history-result').replaceChildren(list);
}
function resetWallet() {
  cancel('wallet'); $('wallet-error').replaceChildren(); $('history-count').textContent = '0';
  $('balance-result').replaceChildren(el('div', '—', 'balance-value'));
  $('history-result').replaceChildren(el('div', 'Look up a public address to see its activity.', 'empty-state'));
}
async function lookupWallet(event) {
  event?.preventDefault(); cancel('wallet');
  let wallet;
  $('wallet-address').removeAttribute('aria-invalid'); $('wallet-error').replaceChildren();
  try { wallet = addressInput($('wallet-address').value); }
  catch (error) {
    resetWallet(); $('wallet-address').setAttribute('aria-invalid', 'true');
    $('wallet-error').append(el('p', error.message, 'error')); $('wallet-address').focus(); return;
  }
  const job = begin('wallet');
  loading($('balance-result'), 'Loading balance…'); loading($('history-result'), 'Loading asset transactions…');
  $('history-count').textContent = '…';
  const isDemoWallet = wallet.toLowerCase() === DEMO_WALLET.toLowerCase();
  // Each request updates its own region. One failure never hides the other result.
  await Promise.allSettled([
    (async () => {
      try {
        const balance = mode === 'demo' ? (isDemoWallet ? demoBalance : 0n) : await liveBalance(wallet, job.signal, selectedNetworkKey, selectedAsset);
        if (job.current()) renderBalance(balance);
      } catch (error) { if (job.current()) $('balance-result').replaceChildren(el('p', 'Balance unavailable: ' + error.message, 'error')); }
    })(),
    (async () => {
      try {
        const history = mode === 'demo' ? (isDemoWallet ? demoHistory : []) : await liveHistory(wallet, job.signal, selectedNetworkKey, selectedAsset);
        if (job.current()) renderHistory(history, wallet);
      } catch (error) {
        if (job.current()) { $('history-count').textContent = '—'; $('history-result').replaceChildren(el('p', 'History unavailable: ' + error.message, 'error')); }
      }
    })(),
  ]);
  job.finish();
}
$('wallet-form').addEventListener('submit', lookupWallet);
$('wallet-address').addEventListener('input', () => { resetWallet(); $('wallet-address').removeAttribute('aria-invalid'); });
function syncNetworkUI() {
  const network = selectedNetwork();
  $('asset-select').value = selectedAsset;
  $('asset-select').disabled = mode === 'demo';
  for (const unit of document.querySelectorAll('[data-asset-unit]')) unit.textContent = selectedAsset;
  $('expected-sender-field').hidden = selectedAsset !== 'USDC';
  $('amount-help').textContent = 'Up to ' + assetInfo(selectedAsset).decimals + ' decimal places. Gas fees are separate in ETH.';
  $('send-amount-help').textContent = 'Gas fees are paid separately in ETH. Up to ' + assetInfo(selectedAsset).decimals + ' decimal places.';
  $('network-select').value = network.key;
  $('network-select').disabled = mode === 'demo';
  $('network-current').textContent = network.name;
  $('network-chain-id').textContent = '/ ' + network.chainId;
  $('balance-network-name').textContent = network.name + (network.testnet ? ' / test ' : ' / real ') + selectedAsset;
  $('mode-caption').textContent = mode === 'demo' ? 'Fictional data. Real verification logic.' : 'Live Ethereum tools.';
  $('balance-source').textContent = mode === 'demo' ? 'DEMO SNAPSHOT' : 'LIVE RPC';
  const banner = $('mode-banner');
  banner.className = 'mode-banner' + (mode === 'demo' ? '' : ' live');
  banner.replaceChildren(el('span', mode === 'demo' ? '◈' : '◉', 'banner-icon'));
  const text = el('p');
  text.append(el('strong', mode === 'demo' ? 'You’re in Demo mode. ' : network.name + ' selected. '), document.createTextNode(mode === 'demo' ? 'Fictional Sepolia examples. No internet or wallet needed.' : (network.testnet ? 'Testnet ' + selectedAsset + ' only. ' : 'Mainnet uses real ' + selectedAsset + '. ') + 'Balance and payment checks are public reads. Sending requires a separate review and confirmation.'));
  banner.append(text);
  transfers?.contextChanged();
}
function setMode(nextMode) {
  if (transfers?.isSubmitting()) return;
  if (nextMode === 'demo' && mode !== 'demo') lastLiveNetwork = selectedNetworkKey;
  if (nextMode === 'demo' && mode !== 'demo') lastLiveAsset = selectedAsset;
  mode = nextMode;
  selectedAsset = mode === 'demo' ? 'ETH' : lastLiveAsset;
  selectedNetworkKey = mode === 'demo' ? 'sepolia' : lastLiveNetwork;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
  cancel('payment'); resetWallet(); placeholder();
  const demo = mode === 'demo';
  $('demo-controls').hidden = !demo;
  syncNetworkUI();
  for (const field of paymentFields) { field.value = ''; field.removeAttribute('aria-invalid'); }
  $('wallet-address').value = demo ? DEMO_WALLET : '';
  $('wallet-address').removeAttribute('aria-invalid');
  if (demo) { loadScenario(); lookupWallet(); }
}
$('network-select').addEventListener('change', () => {
  if (mode !== 'live' || transfers?.isSubmitting()) return;
  selectedNetworkKey = getNetwork($('network-select').value).key;
  lastLiveNetwork = selectedNetworkKey;
  cancel('payment'); resetWallet(); placeholder();
  $('tx-hash').value = '';
  for (const field of paymentFields) field.removeAttribute('aria-invalid');
  syncNetworkUI();
});
$('asset-select').addEventListener('change', () => {
  if (mode !== 'live' || transfers?.isSubmitting()) return;
  selectedAsset = assetInfo($('asset-select').value).symbol;
  lastLiveAsset = selectedAsset;
  cancel('payment'); resetWallet(); placeholder();
  syncNetworkUI();
  if ($('wallet-address').value.trim()) lookupWallet();
});
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener('change', () => setMode(radio.value));
setMode('live');

transfers = initializeTransfers({
  context: () => ({ mode, networkKey: selectedNetworkKey, asset: selectedAsset }),
  onConfirmed: data => { if (mode === 'live' && data.networkKey === selectedNetworkKey && (data.asset || 'ETH') === selectedAsset) { $('wallet-address').value = data.from; lookupWallet(); } },
  useTransfer: data => {
    lastLiveAsset = data.asset || 'ETH';
    lastLiveNetwork = data.networkKey;
    setMode('live');
    $('recipient').value = data.to;
    $('expected').value = formatAsset(BigInt(data.amountUnits ?? data.amountWei), data.asset || 'ETH');
    $('tx-hash').value = data.hash;
    $('expected-sender').value = data.asset === 'USDC' ? data.from : '';
    $('wallet-address').value = data.from;
    $('payment-form').requestSubmit(); lookupWallet();
  },
});
