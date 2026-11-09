import { getAddress, toQuantity } from 'ethers';
import { getNetwork } from './networks.js';
import { createMetaMaskConnector, METAMASK_CONNECT_ID } from './metamask-connector.js';

const RPC = Object.freeze({ mainnet: 'https://ethereum-rpc.publicnode.com', sepolia: 'https://ethereum-sepolia-rpc.publicnode.com', hoodi: 'https://ethereum-hoodi-rpc.publicnode.com' });
export function walletError(error) {
  if (error?.name === 'AbortError') return 'Wallet connection cancelled. You can connect again when ready.';
  const code = Number(error?.code ?? error?.info?.error?.code ?? error?.error?.code);
  if (code === 4001) return 'You declined the request in your wallet. Nothing was submitted by this request.';
  if (code === -32002) return 'A wallet request is already open. Open your wallet to finish or reject it.';
  if (code === 4900 || code === 4901) return 'Your wallet is disconnected. Reconnect it and check the selected network.';
  if (code === 4100) return 'Wallet access is not authorized. Connect your wallet again.';
  return error?.shortMessage || error?.message || 'The wallet could not complete this request. Check the wallet activity.';
}
export const rejectedByUser = error => Number(error?.code ?? error?.info?.error?.code ?? error?.error?.code) === 4001;

// EIP-6963 discovery + EIP-1193 requests. This module receives public accounts
// only. Account keys and signing stay inside the visitor's wallet.
export function createWalletSession({ target = globalThis.window, ethereum = () => globalThis.ethereum, storage, mobileFactory = createMetaMaskConnector, onChange = () => {}, onWallets = () => {}, onConnectionStatus = () => {} } = {}) {
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  const wallets = new Map();
  let selected = null, address = null, chainId = null, generation = 0, disposed = false;
  let listeners = [];
  let pendingWallet = null, pendingAttempt = 0;
  const mobile = target ? mobileFactory({ onStatus: onConnectionStatus }) : null;
  const snapshot = () => ({ address, chainId, walletId: selected?.id ?? null, walletName: selected?.name ?? null, generation });
  function remember(id) { try { if (id) storage?.setItem('etherreceipt-wallet', id); else storage?.removeItem('etherreceipt-wallet'); } catch {} }
  function notify() { generation++; if (!disposed) onChange(snapshot()); }
  function register(id, name, provider) {
    if (!provider || typeof provider.request !== 'function') return;
    const duplicate = [...wallets.values()].find(wallet => wallet.provider === provider);
    if (duplicate) return;
    id = String(id).slice(0, 200); name = String(name || 'Browser wallet').slice(0, 80);
    if (wallets.has(id)) return;
    wallets.set(id, { id, name, provider });
    if (!disposed) onWallets([...wallets.values()].map(({ id, name }) => ({ id, name })));
  }
  const announce = event => {
    const detail = event?.detail;
    if (detail?.info?.uuid && detail?.provider) register(detail.info.rdns || detail.info.uuid, detail.info.name, detail.provider);
  };
  function discover() {
    const injected = ethereum();
    for (const [index, provider] of (injected?.providers || (injected ? [injected] : [])).entries()) {
      register('injected-' + index, provider.isMetaMask ? 'MetaMask' : provider.isCoinbaseWallet ? 'Coinbase Wallet' : provider.isRabby ? 'Rabby' : 'Browser wallet', provider);
    }
    target?.dispatchEvent(new Event('eip6963:requestProvider'));
  }
  function detach() { for (const [provider, event, handler] of listeners) provider.removeListener?.(event, handler); listeners = []; }
  function attach(wallet) {
    detach(); selected = wallet;
    const accountsChanged = accounts => {
      try { address = Array.isArray(accounts) && accounts[0] ? getAddress(accounts[0]) : null; } catch { address = null; }
      if (!address) remember(null);
      notify();
    };
    const chainChanged = value => { try { chainId = Number(BigInt(value)); } catch { chainId = null; } notify(); };
    const disconnected = () => { address = null; chainId = null; remember(null); notify(); };
    for (const [event, handler] of [['accountsChanged', accountsChanged], ['chainChanged', chainChanged], ['disconnect', disconnected]]) {
      wallet.provider.on?.(event, handler); listeners.push([wallet.provider, event, handler]);
    }
  }
  async function connect(id, prompt = true, networkKey = 'mainnet') {
    discover();
    const wallet = wallets.get(id) || (!id ? wallets.values().next().value : null);
    if (!wallet) throw new Error('No compatible wallet found. Enable a browser wallet, or open this site in your mobile wallet’s browser.');
    const attempt = ++generation;
    const previous = selected;
    detach(); pendingWallet = wallet; pendingAttempt = attempt;
    try {
      const accounts = wallet.mobile ? await mobile.connect(networkKey, prompt) : await wallet.provider.request({ method: prompt ? 'eth_requestAccounts' : 'eth_accounts' });
      if (disposed || generation !== attempt) throw new DOMException('Wallet connection cancelled or changed.', 'AbortError');
      if (!Array.isArray(accounts) || !accounts[0]) throw new Error('No wallet account was connected.');
      const nextAddress = getAddress(accounts[0]);
      const nextChain = Number(BigInt(await wallet.provider.request({ method: 'eth_chainId' })));
      if (disposed || generation !== attempt) throw new DOMException('Wallet connection cancelled or changed.', 'AbortError');
      attach(wallet); address = nextAddress; chainId = nextChain; remember(wallet.id); notify();
      return snapshot();
    } catch (error) {
      if (!disposed && generation === attempt && previous) attach(previous);
      throw error;
    } finally { if (pendingAttempt === attempt) { pendingWallet = null; pendingAttempt = 0; } }
  }

  target?.addEventListener('eip6963:announceProvider', announce);
  discover();
  if (mobile) {
    wallets.set(METAMASK_CONNECT_ID, { id: METAMASK_CONNECT_ID, name: 'MetaMask app / QR', provider: mobile.provider, mobile: true });
    onWallets([...wallets.values()].map(({ id, name }) => ({ id, name })));
  }
  return {
    snapshot,
    wallets: () => [...wallets.values()].map(({ id, name }) => ({ id, name })),
    discover,
    connect,
    async restore() { let id; try { id = storage?.getItem('etherreceipt-wallet'); } catch {} if (id && wallets.has(id)) { try { return await connect(id, false); } catch {} } return snapshot(); },
    provider() { if (!selected || !address) throw new Error('Connect your wallet first.'); return selected.provider; },
    async assertContext(networkKey, expectedAddress = address) {
      const network = getNetwork(networkKey), provider = this.provider(), current = generation;
      const [accounts, actualChain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
      if (current !== generation || !accounts?.[0] || getAddress(accounts[0]) !== getAddress(expectedAddress)) throw new Error('The connected account changed. Prepare a new review.');
      if (BigInt(actualChain) !== BigInt(network.chainId)) throw new Error('Switch your wallet to ' + network.name + ' before reviewing or sending.');
      return provider;
    },
    async switchNetwork(networkKey) {
      const network = getNetwork(networkKey), provider = this.provider();
      try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toQuantity(network.chainId) }] }); }
      catch (e) {
        if (Number(e?.code) !== 4902) throw e;
        await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: toQuantity(network.chainId), chainName: network.name, nativeCurrency: { name: network.testnet ? 'Test Ether' : 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC[networkKey]], blockExplorerUrls: [network.explorer] }] });
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toQuantity(network.chainId) }] });
      }
      chainId = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
      notify();
      if (chainId !== network.chainId) throw new Error('The wallet did not switch to ' + network.name + '.');
      return snapshot();
    },
    async refresh() {
      if (!selected || pendingWallet) return snapshot();
      const attempt = generation, provider = selected.provider;
      const [accounts, actualChain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
      if (attempt !== generation || disposed) return snapshot();
      const nextAddress = accounts?.[0] ? getAddress(accounts[0]) : null;
      const nextChain = Number(BigInt(actualChain));
      if (nextAddress !== address || nextChain !== chainId) { address = nextAddress; chainId = nextChain; if (!address) remember(null); notify(); }
      return snapshot();
    },
    cancelConnection() { generation++; if (pendingWallet?.mobile) mobile.cancel(); pendingWallet = null; pendingAttempt = 0; if (selected) attach(selected); },
    disconnect() { const remote = selected?.mobile || pendingWallet?.mobile; this.cancelConnection(); detach(); selected = null; address = null; chainId = null; remember(null); notify(); if (remote) return mobile.disconnect(); return Promise.resolve(); },
    dispose() { disposed = true; generation++; detach(); mobile?.dispose(); target?.removeEventListener('eip6963:announceProvider', announce); },
  };
}
