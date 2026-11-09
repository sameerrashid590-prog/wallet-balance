import test from 'node:test';
import assert from 'node:assert/strict';
import { createSigningAuth, createRateLimiter } from '../lib/auth.js';
import { createJournal } from '../lib/journal.js';
import { mkdtempSync, unlinkSync, rmdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClientRateLimiter } from '../lib/rate-limit.js';
import { createApp } from '../server.js';
import { once } from 'node:events';

test('retired signing routes remain disabled even with the old signing password', async () => {
  const app = createApp(); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    for (const route of ['', '/review?reviewId=bad', '/login', '/confirm']) for (const authorization of ['', 'Basic ' + Buffer.from('wallet:fixture-only-password-123456789').toString('base64')]) {
      const response = await fetch(base + '/api/sender' + route, { headers: { authorization } });
      assert.equal(response.status, 410); assert.equal(response.headers.get('www-authenticate'), null);
    }
    assert.equal((await fetch(base + '/data/submissions.jsonl')).status, 404);
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});

test('rate limiter enforces a bounded request window and recovers', () => {
  let now=0; const limit=createRateLimiter({now:()=>now,limit:2,windowMs:1000});
  limit();limit();assert.throws(limit,e=>e.status===429);now=1000;assert.doesNotThrow(limit);
});
test('public API limits repeated lookups per client', async () => {
  const app = createApp({ readLimit: createClientRateLimiter({ limit: 1 }) });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const url = 'http://127.0.0.1:' + app.address().port + '/api/health';
  try { assert.equal((await fetch(url)).status, 200); assert.equal((await fetch(url)).status, 429); }
  finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});

test('durable journal locks a second process, reloads hashes, and fails closed on corruption', () => {
  const dir=mkdtempSync(join(tmpdir(),'etherreceipt-journal-'));
  let journal;
  try {
    journal=createJournal(dir);
    assert.throws(()=>createJournal(dir),/running/);
    const result={hash:'0x'+'ab'.repeat(32),networkKey:'sepolia',broadcastStatus:'unknown'};
    journal.save('12'.repeat(32),result);
    assert.ok(!readFileSync(join(dir,'submissions.jsonl'),'utf8').includes('privateKey'));
    journal.close();journal=createJournal(dir);
    assert.deepEqual(journal.records()[0].result,result);
    journal.close();journal=null;
    appendFileSync(join(dir,'submissions.jsonl'),'incomplete');
    assert.throws(()=>createJournal(dir));
  } finally {
    journal?.close();
    for(const name of ['sender.lock','submissions.jsonl']) {try {unlinkSync(join(dir,name));} catch(e){if(e.code!=='ENOENT')throw e;}}
    rmdirSync(dir);
  }
});


test('saved mined receipts retain their outcome on journal reload and malformed outcomes fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'etherreceipt-mined-'));
  let journal;
  try {
    journal = createJournal(dir);
    const result = { hash: '0x' + 'ab'.repeat(32), networkKey: 'sepolia', broadcastStatus: 'submitted', receiptStatus: 'success', blockNumber: 12083885, blockHash: '0x' + 'cd'.repeat(32) };
    journal.save('12'.repeat(32), result);
    journal.close(); journal = createJournal(dir);
    assert.deepEqual(journal.records()[0].result, result);
    journal.close(); journal = null;
    appendFileSync(join(dir, 'submissions.jsonl'), JSON.stringify({ id: '34'.repeat(32), result: { ...result, blockHash: 'invalid' } }) + '\n');
    assert.throws(() => createJournal(dir), /Invalid saved receipt/);
  } finally {
    journal?.close();
    for (const name of ['sender.lock', 'submissions.jsonl']) { try { unlinkSync(join(dir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    rmdirSync(dir);
  }
});
