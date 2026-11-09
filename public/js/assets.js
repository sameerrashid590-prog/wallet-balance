import { parseUnits, formatUnits } from 'ethers';
export function assetInfo(asset = 'ETH') {
  if (asset !== 'ETH' && asset !== 'USDC') throw new Error('Choose ETH or USDC.');
  return { symbol: asset, decimals: asset === 'USDC' ? 6 : 18 };
}
export function assetAmount(value, asset = 'ETH') {
  const { decimals } = assetInfo(asset);
  if (typeof value !== 'string' || !new RegExp('^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,' + decimals + '})?$').test(value.trim())) throw new Error('Enter a positive ' + asset + ' amount using plain decimals, with at most ' + decimals + ' decimal places.');
  const units = parseUnits(value.trim(), decimals);
  if (units <= 0n || units >= 2n ** 256n) throw new Error('Expected ' + asset + ' must be greater than zero and fit within 256 bits.');
  return units;
}
export const formatAsset = (units, asset = 'ETH') => formatUnits(units, assetInfo(asset).decimals);

