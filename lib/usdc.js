import { USDC_CONTRACTS } from '../public/js/usdc-contracts.js';
﻿import { Interface, getAddress } from 'ethers';
import { USDC_ABI } from '../public/js/usdc-abi.js';
import { getNetwork } from '../public/js/networks.js';
import { HttpError } from './upstream.js';

export const usdcInterface = new Interface(USDC_ABI);
// Circle native USDC. An arbitrary token claiming the same symbol is rejected.
export { USDC_CONTRACTS } from '../public/js/usdc-contracts.js';
export function usdcAddress(networkKey, env = process.env) {
  getNetwork(networkKey);
  const official = USDC_CONTRACTS[networkKey];
  if (!official) throw new HttpError(400, 'Native USDC is not supported on this network. Select Mainnet or Sepolia.');
  const configured = env[networkKey === 'mainnet' ? 'USDC_CONTRACT_ADDRESS' : 'SEPOLIA_USDC_CONTRACT_ADDRESS'] || official;
  let address;
  try { address = getAddress(configured); } catch { throw new HttpError(503, 'Invalid USDC contract configuration.'); }
  if (address !== official) throw new HttpError(503, 'USDC contract does not match the selected network native USDC deployment. Check .env.');
  return address;
}
export async function checkedUsdc(provider, networkKey, env) {
  const address = usdcAddress(networkKey, env);
  const [code, decimals, symbol] = await Promise.all([
    provider.getCode(address, 'latest'),
    provider.call({ to: address, data: usdcInterface.encodeFunctionData('decimals') }),
    provider.call({ to: address, data: usdcInterface.encodeFunctionData('symbol') }),
  ]);
  let valid = false;
  try { valid = typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && usdcInterface.decodeFunctionResult('decimals', decimals)[0] === 6n && usdcInterface.decodeFunctionResult('symbol', symbol)[0] === 'USDC'; } catch {}
  if (!valid) throw new HttpError(502, 'USDC contract code, decimals or symbol could not be verified.');
  return address;
}
export async function usdcBalance(provider, contract, address) {
  return usdcInterface.decodeFunctionResult('balanceOf', await provider.call({ to: contract, data: usdcInterface.encodeFunctionData('balanceOf', [address]) }))[0];
}

