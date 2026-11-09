// Public metadata only. RPC URLs and optional credentials stay on the server.
export const DEFAULT_NETWORK = 'mainnet';
export const NETWORKS = Object.freeze([
  Object.freeze({ key: 'mainnet', name: 'Ethereum Mainnet', chainId: 1, testnet: false, explorer: 'https://etherscan.io' }),
  Object.freeze({ key: 'sepolia', name: 'Ethereum Sepolia', chainId: 11155111, testnet: true, explorer: 'https://sepolia.etherscan.io' }),
  Object.freeze({ key: 'hoodi', name: 'Ethereum Hoodi', chainId: 560048, testnet: true, explorer: 'https://hoodi.etherscan.io' }),
]);
export function getNetwork(key = DEFAULT_NETWORK) {
  const network = NETWORKS.find(item => item.key === key);
  if (!network) throw new Error('Unsupported network. Choose Ethereum Mainnet, Sepolia, or Hoodi.');
  return network;
}
