import { ZeroAddress } from 'ethers';
import { addressInput } from './verification.js';
import { assetAmount } from './assets.js';
import { getNetwork } from './networks.js';

export function transferInput({ recipient, amount, networkKey, asset = 'ETH' }, sender) {
  const network = getNetwork(networkKey);
  const to = addressInput(recipient);
  const value = assetAmount(amount, asset);
  if (to === ZeroAddress) throw new Error('The zero address cannot receive payments in this app.');
  if (sender && to.toLowerCase() === addressInput(sender).toLowerCase()) throw new Error('Choose a receiver different from the sending account.');
  return { to, value, network };
}
