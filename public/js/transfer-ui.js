import { formatEther } from 'ethers';
import { formatAsset } from './assets.js';
import { getNetwork } from './networks.js';
import { hashInput, verifyPayment } from './verification.js';
import { verifyUsdcPayment } from './usdc-verification.js';
import { liveBalance, livePayment } from './api.js';
import { createWalletSession, walletError, rejectedByUser } from './wallet-session.js';
import { prepareWalletTransfer, sendWalletTransfer, matchesSubmissionTransaction } from './wallet-transfer.js';
import { createTransferStore } from './transfer-store.js';
const terminal = state => ['success', 'failed', 'replaced', 'rejected'].includes(state);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
export function initializeTransfers({ context, useTransfer, onConfirmed = () => {}, readPayment = livePayment, readBalance = liveBalance, sessionFactory = createWalletSession, prepare = prepareWalletTransfer, send = sendWalletTransfer, store = createTransferStore(), locks = globalThis.navigator?.locks } = {}) {
  const $ = id => document.getElementById(id);
  let session, wallet = { address: null, chainId: null, generation: 0 }, review = null, active = null;
  let version = 0, connecting = false, preparing = false, submitting = false, checking = false, disposed = false, receiptTimer = null, storageError = '';
  function message(title, text, tone = '') { const box = $('send-feedback'); box.className = 'result ' + tone; box.replaceChildren(node('h3', title), node('p', text)); }
  function hideReview() { review = null; $('send-review').hidden = true; $('send-confirm-button').disabled = true; }
  function pending() {
    if (!wallet.address) return [];
    try { const result = store.unresolved(wallet.address, context().networkKey); storageError = ''; return result; }
    catch (e) { storageError = e.message; return []; }
  }
  function render() {
    const selected = context(), network = getNetwork(selected.networkKey), asset = selected.asset || 'ETH';
    const unresolved = pending().length > 0;
    const busy = connecting || preparing || submitting;
    const matched = wallet.address && wallet.chainId === network.chainId;
    const supported = !(asset === 'USDC' && network.key === 'hoodi');
    const ready = selected.mode === 'live' && matched && supported && !storageError;
    $('send-account').textContent = wallet.address || 'No wallet connected';
    $('send-network-label').textContent = network.name;
    $('send-limit').textContent = 'You approve each transaction in your wallet.';
    $('send-review-button').disabled = !ready || busy || unresolved;
    $('send-review-button').textContent = preparing ? 'Preparing review…' : submitting ? 'Check your wallet…' : !wallet.address ? 'Connect your wallet first' : !matched ? 'Switch wallet network' : unresolved ? 'Check previous submission' : 'Review transfer';
    $('send-review-button').setAttribute('aria-busy', String(preparing || submitting));
    $('send-form').setAttribute('aria-busy', String(preparing || submitting));
    $('send-recipient').disabled = !ready || submitting || unresolved;
    $('send-amount').disabled = !ready || submitting || unresolved;
    $('wallet-connect-button').disabled = busy || selected.mode !== 'live';
    $('wallet-connect-button').textContent = connecting ? 'Connecting…' : wallet.address ? 'Change wallet' : 'Connect wallet';
    $('wallet-disconnect-button').hidden = !wallet.address;
    $('wallet-disconnect-button').disabled = busy;
    $('wallet-select').disabled = busy || selected.mode !== 'live';
    $('wallet-switch-button').hidden = !wallet.address || matched || selected.mode !== 'live';
    $('wallet-switch-button').disabled = busy;
    $('wallet-switch-button').textContent = 'Switch to ' + network.name;
    $('send-help').textContent = selected.mode !== 'live' ? 'Select Live to connect a wallet and send a payment.' : storageError || (!wallet.address ? 'Connect a browser wallet, or open this page in your mobile wallet’s browser. Approve requests only in your wallet.' : !matched ? 'Your wallet is on a different network. Switch it to ' + network.name + '.' : !supported ? 'Native USDC is supported on Mainnet and Sepolia.' : 'The connected wallet signs your transfer. Gas is paid separately in ETH.');
  }
  function scheduleReceipt(delay = 5000) { clearTimeout(receiptTimer); if (!disposed && active && !terminal(active.state)) { receiptTimer = setTimeout(() => checkReceipt(), delay); receiptTimer?.unref?.(); } }
  function showSubmission(record, result) {
    const network = getNetwork(record.networkKey);
    const title = result?.title || (record.state === 'success' ? 'Payment confirmed' : record.state === 'failed' ? 'Transfer failed' : record.state === 'replaced' ? 'Wallet request was replaced' : record.hash ? 'Submitted — awaiting a receipt' : 'Check wallet activity before sending again');
    const text = result?.message || (terminal(record.state) ? 'Review the recorded transaction details below.' : record.hash ? 'The wallet returned this hash. Checking its mined receipt and payment details.' : 'The wallet request may have been submitted. Copy its transaction hash from your wallet to recover it. Do not send the payment again blindly.');
    message(title, text, result?.tone || (record.state === 'success' ? 'success' : record.state === 'failed' ? 'danger' : 'info'));
    const box = $('send-feedback');
    box.append(node('p', network.name + ' · ' + formatAsset(BigInt(record.amountUnits), record.asset) + ' ' + record.asset + ' from ' + record.from + ' to ' + record.to));
    const link = node('a', record.hash || 'Open sender activity on the explorer');
    link.href = network.explorer + (record.hash ? '/tx/' + hashInput(record.hash) : '/address/' + record.from); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'send-hash'; box.append(link);
    $('send-check-button').hidden = !record.hash;
    $('send-use-button').hidden = !record.hash || record.state === 'replaced';
    $('send-recover-button').hidden = terminal(record.state);
    $('send-recovery-fields').hidden = terminal(record.state);
  }
  function syncPending() {
    if (submitting) return;
    const record = pending()[0] || null;
    if (record && record.id !== active?.id) { active = record; $('send-recovery-hash').value = ''; showSubmission(record); if (record.hash) scheduleReceipt(0); }
    else if (record && active) { showSubmission(active); }
    else if (!record && active && !terminal(active.state)) { active = null; clearTimeout(receiptTimer); $('send-check-button').hidden = true; $('send-use-button').hidden = true; $('send-recover-button').hidden = true; $('send-recovery-fields').hidden = true; }
    render();
  }
  async function refreshBalance() {
    const current = version, address = wallet.address, selected = context();
    if (!address || selected.mode !== 'live') { $('send-balance').textContent = ''; return; }
    $('send-balance').textContent = 'Reading balance…';
    try { const balance = await readBalance(address, undefined, selected.networkKey, selected.asset || 'ETH'); if (version === current && wallet.address === address && !disposed) $('send-balance').textContent = 'Balance: ' + formatAsset(balance, selected.asset || 'ETH') + ' ' + (selected.asset || 'ETH'); }
    catch (e) { if (version === current && !disposed) $('send-balance').textContent = 'Balance unavailable: ' + e.message; }
  }
  function invalidate() { version++; if (!submitting) hideReview(); render(); }
  function lockContext(locked) {
    for (const id of ['network-select', 'asset-select']) $(id).disabled = locked || context().mode === 'demo';
    for (const radio of document.querySelectorAll('input[name="mode"]')) radio.disabled = locked;
    $('send-cancel-button').disabled = locked;
  }
  session = sessionFactory({ onChange(next) { wallet = next; invalidate(); syncPending(); refreshBalance(); }, onWallets(wallets) {
    const select = $('wallet-select'), chosen = select.value;
    select.replaceChildren(...wallets.map(wallet => { const option = node('option', wallet.name); option.value = wallet.id; return option; }));
    if (!wallets.length) { const option = node('option', 'No browser wallet detected'); option.value = ''; select.append(option); }
    if (wallets.some(wallet => wallet.id === chosen)) select.value = chosen;
  } });
  wallet = session.snapshot();
  $('wallet-connect-button').addEventListener('click', async () => {
    if (connecting || submitting) return;
    connecting = true; invalidate();
    try { await session.connect($('wallet-select').value || undefined); message('Wallet connected', 'Choose the network, receiver and amount, then review your payment.', 'success'); syncPending(); }
    catch (e) { message('Could not connect wallet', walletError(e), 'warning'); }
    finally { connecting = false; render(); }
  });
  $('wallet-disconnect-button').addEventListener('click', () => { if (submitting) return; session.disconnect(); active = null; clearTimeout(receiptTimer); for (const id of ['send-check-button', 'send-use-button', 'send-recover-button', 'send-recovery-fields']) $(id).hidden = true; message('Wallet disconnected', 'Saved public transaction details stay in this browser for recovery.'); render(); });
  $('wallet-switch-button').addEventListener('click', async () => {
    if (connecting || submitting) return;
    connecting = true; invalidate();
    try { await session.switchNetwork(context().networkKey); syncPending(); }
    catch (e) { message('Could not switch network', walletError(e), 'warning'); }
    finally { connecting = false; render(); }
  });
  for (const id of ['send-recipient', 'send-amount']) $(id).addEventListener('input', () => { if (!submitting) invalidate(); });
  $('send-form').addEventListener('submit', async event => {
    event.preventDefault(); if (preparing || submitting) return;
    invalidate(); if (pending().length) { syncPending(); return; }
    if (storageError) { message('Enable transfer recovery storage', storageError, 'warning'); return; }
    const selected = context(); if (selected.mode !== 'live') return;
    const current = version;
    preparing = true; render(); message('Preparing a transaction review…', 'Checking the connected account, network, balance, pending nonce and gas. Nothing has been signed or sent.');
    try {
      const data = await prepare(session, { recipient: $('send-recipient').value, amount: $('send-amount').value, networkKey: selected.networkKey, asset: selected.asset || 'ETH' });
      if (current !== version || disposed) return;
      review = data;
      const details = $('send-review-details'); details.replaceChildren();
      for (const [label, value] of [['Network', data.networkName + ' / chain ID ' + data.chainId], ['From', data.from], ['Receiver', data.to], ['Amount', formatAsset(BigInt(data.amountUnits), data.asset) + ' ' + data.asset], ['Maximum gas fee', formatEther(BigInt(data.maxFeeWei)) + ' ETH'], ['Maximum ETH debit', formatEther(BigInt(data.maxTotalWei)) + ' ETH'], ['USDC contract', data.contractAddress || 'Not applicable'], ['Nonce', String(data.nonce)], ['Review expires', new Date(data.expiresAt).toLocaleTimeString()]]) { const row = node('div'); row.append(node('dt', label), node('dd', value)); details.append(row); }
      $('send-review').hidden = false; $('send-confirm-button').disabled = false; $('send-confirm-button').textContent = 'Approve ' + (getNetwork(data.networkKey).testnet ? 'test ' : 'real ') + data.asset + ' in wallet';
      $('send-review-note').textContent = 'Check the same recipient, asset, amount and network in your wallet. Only your wallet can sign and submit this transaction.';
      message('Ready to review', 'Review these details, then approve the request in your wallet.'); $('send-review').focus();
    } catch (e) { if (current === version && !disposed) message('Could not prepare transfer', walletError(e), 'danger'); }
    finally { preparing = false; render(); }
  });
  $('send-cancel-button').addEventListener('click', () => { if (!submitting) { invalidate(); message('Review cancelled', 'No wallet approval was requested.'); } });
  $('send-confirm-button').addEventListener('click', async () => {
    if (submitting || !review) return;
    const approved = review, current = version;
    submitting = true; active = null; clearTimeout(receiptTimer); lockContext(true); render();
    let prompted = false;
    let record = { id: approved.reviewId, from: approved.from, to: approved.to, networkKey: approved.networkKey, asset: approved.asset, amountUnits: approved.amountUnits, nonce: approved.nonce, transaction: { ...approved.transaction }, hash: null, state: 'wallet-prompt', createdAt: Date.now() };
    message('Checking before wallet approval…', 'Rechecking the account, nonce, balance and approved fee cap.');
    try {
      const submit = () => send(session, approved, { stillCurrent: () => !disposed && version === current && context().mode === 'live' && context().networkKey === approved.networkKey && (context().asset || 'ETH') === approved.asset,
        beforePrompt() { if (store.unresolved(approved.from, approved.networkKey).length) throw new Error('A previous wallet request needs checking before another payment.'); store.save(record); prompted = true; hideReview(); message('Approve the transfer in your wallet', 'Your wallet will show the transaction. This site never receives your private key or seed phrase.'); }
      });
      const hash = locks?.request ? await locks.request('etherreceipt-send:' + approved.chainId + ':' + approved.from.toLowerCase(), { ifAvailable: true }, lock => { if (!lock) throw new Error('Another tab has a wallet request open. Finish it before sending here.'); return submit(); }) : await submit();
      record = { ...record, hash: hashInput(hash), state: 'submitted' }; store.save(record); active = record; showSubmission(record); $('send-recipient').value = ''; $('send-amount').value = '';
    } catch (e) {
      if (!prompted || rejectedByUser(e)) {
        if (prompted) { try { store.save({ ...record, state: 'rejected' }); } catch {} }
        message(rejectedByUser(e) ? 'Wallet request declined' : 'Could not send transfer', walletError(e), 'warning');
      } else {
        record = { ...record, state: 'unknown' }; try { store.save(record); } catch {}
        active = record; showSubmission(record); $('send-feedback').append(node('p', walletError(e)));
      }
    } finally { hideReview(); submitting = false; lockContext(false); render(); if (active?.hash) scheduleReceipt(0); }
  });
  async function checkReceipt() {
    if (!active || checking || submitting || disposed) return;
    const snapshot = active, suggested = $('send-recovery-hash').value.trim();
    const candidate = suggested || snapshot.hash;
    if (!candidate) { message('Copy the transaction hash from your wallet', 'Use the public 0x transaction hash from the wallet activity, not a private key or seed phrase.', 'warning'); return; }
    checking = true; $('send-check-button').disabled = true; $('send-recover-button').disabled = true;
    try {
      const hash = hashInput(candidate), data = await readPayment(hash, undefined, snapshot.networkKey, snapshot.asset);
      if (active !== snapshot || submitting || disposed) return;
      if (!data.transaction) { showSubmission(snapshot, { title: 'Transaction not found yet', message: 'The checked RPCs do not know this hash yet. Keep checking your wallet activity before sending again.', tone: 'warning' }); return; }
      if (hashInput(data.transaction.hash) !== hash) throw new Error('RPC returned a different transaction hash.');
      const samePayment = matchesSubmissionTransaction(snapshot, data.transaction);
      let result, nextState = 'submitted';
      if (!samePayment) {
        const receipt = data.receipt, tx = data.transaction;
        if (receipt && (hashInput(receipt.hash) !== hash || hashInput(receipt.blockHash) !== hashInput(tx.blockHash) || receipt.blockNumber !== tx.blockNumber || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || ![0, 1].includes(receipt.status))) throw new Error('Replacement transaction and receipt disagree. Retry its lookup.');
        if (receipt) nextState = 'replaced';
        result = { title: receipt ? 'Wallet request was replaced' : 'Replacement transaction pending', message: 'This account and nonce were used for a different transaction. The original payment is not proven. Check its wallet and explorer details before making another payment.', tone: 'warning' };
      } else {
        const input = { recipient: snapshot.to, expected: formatAsset(BigInt(snapshot.amountUnits), snapshot.asset), hash, sender: snapshot.from };
        result = (snapshot.asset === 'USDC' ? verifyUsdcPayment : verifyPayment)(input, data, getNetwork(snapshot.networkKey));
        if (data.receipt && result.code === 'exact') nextState = 'success';
        else if (data.receipt && result.code === 'failed') nextState = 'failed';
      }
      const updated = { ...snapshot, hash, state: nextState, ...(data.receipt ? { blockNumber: data.receipt.blockNumber, blockHash: data.receipt.blockHash } : {}) };
      store.save(updated); active = updated; $('send-recovery-hash').value = ''; showSubmission(updated, result);
      if (terminal(nextState)) { clearTimeout(receiptTimer); render(); refreshBalance(); if (!terminal(snapshot.state) && nextState !== 'replaced') onConfirmed(updated); }
    } catch (e) { if (active === snapshot && !disposed) { showSubmission(snapshot); $('send-feedback').append(node('p', 'Receipt lookup unavailable: ' + walletError(e))); } }
    finally { checking = false; $('send-check-button').disabled = false; $('send-recover-button').disabled = false; scheduleReceipt(); }
  }
  $('send-check-button').addEventListener('click', checkReceipt);
  $('send-recover-button').addEventListener('click', checkReceipt);
  $('send-use-button').addEventListener('click', () => { if (active?.hash && !submitting) useTransfer(active); });
  for (const id of ['send-check-button', 'send-use-button', 'send-recover-button', 'send-recovery-fields']) $(id).hidden = true;
  message('Connect your wallet to send', 'Signing and approval happen in your wallet. Public balance and payment checks work without connecting.'); render();
  session.restore().then(() => { if (!disposed) { wallet = session.snapshot(); render(); syncPending(); refreshBalance(); } }).catch(() => {});
  return { contextChanged() { invalidate(); syncPending(); refreshBalance(); }, dispose() { disposed = true; clearTimeout(receiptTimer); session.dispose(); }, isSubmitting: () => submitting };
}
