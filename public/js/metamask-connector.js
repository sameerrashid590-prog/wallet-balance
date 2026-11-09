import { NETWORKS, getNetwork } from './networks.js';
export const METAMASK_CONNECT_ID = 'metamask-connect';
const PUBLIC_RPC = Object.freeze({ mainnet: 'https://ethereum-rpc.publicnode.com', sepolia: 'https://ethereum-sepolia-rpc.publicnode.com', hoodi: 'https://ethereum-hoodi-rpc.publicnode.com' });
const loadSdk = () => import('../vendor/metamask-connect.js');
export function metamaskBrowserUrl(location = globalThis.location) {
  if (!location?.href) return null;
  const url = new URL(location.href);
  if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  // Navigate to this app only; omit query/hash data from the fallback link.
  return 'https://link.metamask.io/dapp/' + url.host + url.pathname;
}
// The official SDK owns the encrypted mobile channel. This adapter exposes the
// same EIP-1193 interface as injected wallets; no wallet private key is received.
export function createMetaMaskConnector({ loadClient = loadSdk, location = globalThis.location, openLink, onStatus = () => {} } = {}) {
  let client = null, initialization = null, generation = 0, disposed = false;
  const listeners = new Map(), forwards = [];
  let pendingAbort = null;
  function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(abortError());
      signal.addEventListener('abort', cancelled, { once: true });
      promise.then(value => { signal.removeEventListener('abort', cancelled); resolve(value); }, error => { signal.removeEventListener('abort', cancelled); reject(error); });
    });
  }
  function emit(event, ...args) { for (const listener of listeners.get(event) || []) listener(...args); }
  const abortError = () => new DOMException('Wallet connection cancelled.', 'AbortError');
  async function initialize() {
    if (disposed) throw abortError();
    if (!initialization) {
      onStatus('loading');
      initialization = (async () => {
        const { createEVMClient } = await loadClient();
        if (disposed) throw abortError();
        const origin = location?.origin || new URL(location.href).origin;
        const instance = await createEVMClient({
          dapp: { name: 'EtherReceipt', url: origin, iconUrl: origin + '/wallet-icon.svg' },
          api: { supportedNetworks: Object.fromEntries(NETWORKS.map(network => ['0x' + network.chainId.toString(16), PUBLIC_RPC[network.key]])) },
          ui: { headless: false, preferExtension: true, showInstallModal: false },
          mobile: { useDeeplink: true, ...(openLink ? { preferredOpenLink: openLink } : {}) },
          analytics: { enabled: false },
          skipAutoAnnounce: true,
          debug: false,
        });
        if (disposed) { await instance.disconnect().catch(() => {}); throw abortError(); }
        client = instance;
        const provider = client.getProvider();
        for (const event of ['accountsChanged', 'chainChanged', 'disconnect', 'connect', 'message']) {
          const handler = (...args) => emit(event, ...args);
          provider.on(event, handler); forwards.push([provider, event, handler]);
        }
        return instance;
      })().catch(error => { initialization = null; throw error; });
    }
    return initialization;
  }
  const provider = {
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); return this; },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); return this; },
    async request(payload) {
      const instance = await initialize();
      // A passive restore must never open MetaMask or ask for permissions.
      if (payload.method === 'eth_accounts') return [...instance.accounts];
      if (payload.method === 'eth_requestAccounts') return connector.connect('mainnet', true);
      return instance.getProvider().request(payload);
    },
  };
  const connector = {
    provider,
    async connect(networkKey = 'mainnet', prompt = true) {
      pendingAbort?.abort();
      const controller = new AbortController(); pendingAbort = controller;
      const attempt = ++generation;
      const loading = initialize();
      void loading.then(instance => { if (controller.signal.aborted && prompt) void instance.disconnect().catch(() => {}); }, () => {});
      try {
        const instance = await abortable(loading, controller.signal);
        if (attempt !== generation || disposed) throw abortError();
        if (!prompt) return [...instance.accounts];
        const selected = getNetwork(networkKey);
        const chainIds = [selected, ...NETWORKS.filter(network => network.key !== selected.key)].map(network => '0x' + network.chainId.toString(16));
        onStatus('waiting');
        const approval = instance.connect({ chainIds });
        void approval.then(() => { if (attempt !== generation || disposed) void instance.disconnect().catch(() => {}); }, () => {});
        const result = await abortable(approval, controller.signal);
        if (attempt !== generation || disposed) throw abortError();
        onStatus('connected');
        return result.accounts;
      } finally { if (pendingAbort === controller) pendingAbort = null; }
    },
    cancel() { generation++; pendingAbort?.abort(); onStatus('cancelled'); if (client) void client.disconnect().catch(() => {}); },
    disconnect() { generation++; pendingAbort?.abort(); if (client) return client.disconnect(); return Promise.resolve(); },
    dispose() { disposed = true; generation++; pendingAbort?.abort(); for (const [provider, event, handler] of forwards) provider.removeListener(event, handler); listeners.clear(); },
  };
  return connector;
}
