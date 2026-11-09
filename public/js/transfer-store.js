import { hashInput, addressInput } from './verification.js';
import { getNetwork } from './networks.js';
const KEY = 'etherreceipt-wallet-transfers-v1';
export function createTransferStore(storage) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  function read() {
    let value;
    try { value = JSON.parse(storage.getItem(KEY) || '[]'); } catch { throw new Error('Transfer recovery storage is unavailable. Enable site storage before sending.'); }
    if (!Array.isArray(value) || value.length > 500) throw new Error('Saved transfer history is invalid. Check wallet activity before sending again.');
    for (const record of value) {
      try {
        addressInput(record.from); addressInput(record.to); getNetwork(record.networkKey);
        if (typeof record.id !== 'string' || !Number.isSafeInteger(record.nonce) || record.nonce < 0 || !['wallet-prompt', 'submitted', 'unknown', 'success', 'failed', 'replaced', 'rejected'].includes(record.state) || !['ETH', 'USDC'].includes(record.asset)) throw new Error();
        if (record.hash) hashInput(record.hash);
        if (!record.transaction || typeof record.transaction.data !== 'string' || typeof record.amountUnits !== 'string' || !/^\d+$/.test(record.amountUnits)) throw new Error();
      } catch { throw new Error('Saved transfer history is invalid. Check wallet activity before sending again.'); }
    }
    return value;
  }
  return {
    records: read,
    unresolved(from, networkKey) { return read().filter(record => record.from.toLowerCase() === from.toLowerCase() && record.networkKey === networkKey && ['wallet-prompt', 'submitted', 'unknown'].includes(record.state)); },
    save(record) {
      const records = read().filter(item => item.id !== record.id);
      records.push(record);
      const pending = records.filter(item => ['wallet-prompt', 'submitted', 'unknown'].includes(item.state));
      const complete = records.filter(item => !pending.includes(item)).slice(-40);
      try { storage.setItem(KEY, JSON.stringify([...complete, ...pending])); }
      catch { throw new Error('Could not save transfer recovery details. Enable site storage or free some space before sending.'); }
      return record;
    },
  };
}
