import { mkdirSync, openSync, readFileSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Public submission metadata only, flushed BEFORE broadcasting. Fail closed on corruption.
export function createJournal(directory) {
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, 'sender.lock');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch {
    let pid;
    try { pid = Number(readFileSync(lock, 'utf8')); } catch { throw new Error('Sender journal is locked.'); }
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid sender lock.');
    try { process.kill(pid, 0); throw new Error('Another sender process is running.'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    unlinkSync(lock);
    fd = openSync(lock, 'wx', 0o600);
  }
  writeSync(fd, String(process.pid)); closeSync(fd);
  const path = join(directory, 'submissions.jsonl');
  const records = new Map();
  try {
    let content = '';
    try { content = readFileSync(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const line of content.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (!/^[0-9a-f]{64}$/.test(record.id) || !/^0x[0-9a-fA-F]{64}$/.test(record.result?.hash) || !['mainnet', 'sepolia', 'hoodi'].includes(record.result?.networkKey)) throw new Error('Invalid journal record.');
      if (record.result.receiptStatus !== undefined && (!['success', 'failed'].includes(record.result.receiptStatus) || !Number.isSafeInteger(record.result.blockNumber) || record.result.blockNumber < 0 || !/^0x[0-9a-fA-F]{64}$/.test(record.result.blockHash))) throw new Error('Invalid saved receipt.');
      records.set(record.id, record);
    }
  } catch (e) { unlinkSync(lock); throw e; }
  return {
    records: () => [...records.values()],
    save(id, result) {
      const record = { id, result };
      const handle = openSync(path, 'a', 0o600);
      try { writeSync(handle, JSON.stringify(record) + '\n'); fsyncSync(handle); }
      finally { closeSync(handle); }
      records.set(id, record);
    },
    close() { try { unlinkSync(lock); } catch {} },
  };
}

