import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Wallet, parseEther, parseUnits } from 'ethers';
import { createSender } from '../lib/sender.js';
import { usdcInterface as abi, USDC_CONTRACTS, usdcAddress } from '../lib/usdc.js';
import { assetAmount, formatAsset } from '../public/js/assets.js';
import { verifyUsdcPayment } from '../public/js/usdc-verification.js';
import { createUpstream } from '../lib/upstream.js';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { liveBalance, liveHistory, livePayment } from '../public/js/api.js';

const KEY = '0x' + '11'.repeat(32); // Public fixture key, mock providers ONLY.
const FROM = new Wallet(KEY).address;
const TO = '0x2222222222222222222222222222222222222222';
const HASH = '0x' + 'ab'.repeat(32), BLOCK = '0x' + 'cd'.repeat(32);
const CONTRACT = USDC_CONTRACTS.sepolia;
const INPUT = { recipient: TO, amount: '12.345678', networkKey: 'sepolia', asset: 'USDC' };
function fixture(overrides = {}) {
  const state = { tokenBalance: 100000000n, ethBalance: parseEther('1'), decimals: 6n, symbol: 'USDC', chain: '0xaa36a7', nonce: 0, latest: 0, gas: 65000n, broadcasts: [], receipt: null, ...overrides.state };
  const records = new Map();
  const journal = overrides.journal || { records: () => [...records.values()], save: (id, result) => records.set(id, { id, result }) };
  const factory = () => ({
    async send(method, params) {
      if (method === 'eth_chainId') return state.chain;
      if (method === 'eth_sendRawTransaction') {
        state.broadcasts.push(Transaction.from(params[0]));
        if (state.lost) throw new Error('mock timeout');
        return state.broadcasts.at(-1).hash;
      }
      throw new Error('Unexpected method');
    },
    async getCode(address) { return address.toLowerCase() === CONTRACT.toLowerCase() ? state.noCode ? '0x' : '0x6000' : '0x'; },
    async call(tx) {
      const parsed = abi.parseTransaction(tx);
      if (parsed.name === 'decimals') return abi.encodeFunctionResult('decimals', [state.decimals]);
      if (parsed.name === 'symbol') return abi.encodeFunctionResult('symbol', [state.symbol]);
      if (parsed.name === 'balanceOf') return abi.encodeFunctionResult('balanceOf', [state.tokenBalance]);
      throw new Error('Unexpected call');
    },
    async getBalance() { return state.ethBalance; },
    async getTransactionCount(address, block) { return block === 'latest' ? state.latest : state.nonce; },
    async getTransactionReceipt() { return state.receipt; },
    async getFeeData() { return { maxFeePerGas: parseUnits('20','gwei'), maxPriorityFeePerGas: parseUnits('1','gwei') }; },
    async estimateGas(tx) { if (state.estimateError) throw Object.assign(new Error('fixture'), { code: 'CALL_EXCEPTION' }); return state.gas; },
    destroy() {},
  });
  const options = { env: { WALLET_PRIVATE_KEY: KEY, ...overrides.env }, providerFactory: factory, journal };
  return { sender: createSender(options), state, journal, options };
}
function payment() {
  const event = abi.encodeEventLog(abi.getEvent('Transfer'), [FROM, TO, 12345678n]);
  return {
    transaction: { hash: HASH, from: FROM, to: CONTRACT, chainId: 11155111n, value: 0n, data: abi.encodeFunctionData('transfer',[TO,12345678n]), blockNumber: 100, blockHash: BLOCK },
    receipt: { hash: HASH, blockNumber: 100, blockHash: BLOCK, status: 1, logs: [{ address: CONTRACT, ...event }] },
    contractAddress: CONTRACT, confirmations: 3,
  };
}
const expected = { recipient: TO, expected: '12.345678', hash: HASH, sender: FROM };
test('USDC exact six-decimal parsing and values beyond Number precision', () => {
  assert.equal(assetAmount('0.000001','USDC'), 1n);
  assert.equal(assetAmount('9007199254740993.123456','USDC'), 9007199254740993123456n);
  assert.equal(formatAsset(12345678n,'USDC'), '12.345678');
  for (const amount of ['0','-1','1e2','NaN','.5','01','1.0000001', 1]) assert.throws(() => assetAmount(amount,'USDC'));
  assert.throws(() => assetAmount('1','DAI'));
});
test('USDC review never broadcasts and signs exact transfer calldata only after confirm', async () => {
  const { sender, state } = fixture();
  const review = await sender.prepare(INPUT);
  assert.equal(state.broadcasts.length,0);
  assert.equal(review.asset,'USDC'); assert.equal(review.to,TO); assert.equal(review.contractAddress,CONTRACT);
  assert.equal(review.amountUnits,'12345678'); assert.equal(review.maxTotalWei,review.maxFeeWei);
  const result = await sender.confirm({ reviewId: review.reviewId });
  assert.equal(result.broadcastStatus,'submitted'); assert.equal(result.amountUnits,'12345678'); assert.equal(result.amountWei,undefined);
  const tx = state.broadcasts[0], parsed = abi.parseTransaction(tx);
  assert.equal(tx.from,FROM); assert.equal(tx.to,CONTRACT); assert.equal(tx.value,0n); assert.equal(tx.chainId,11155111n);
  assert.equal(parsed.name,'transfer'); assert.equal(parsed.args[0],TO); assert.equal(parsed.args[1],12345678n);
  assert.equal(tx.gasLimit,BigInt(review.gasLimit));
  assert.deepEqual(await sender.confirm({ reviewId: review.reviewId }), result);
  assert.equal(state.broadcasts.length,1);
});
test('USDC rejects invalid addresses, precision, spend cap, unsupported network and token-contract recipient', async () => {
  const { sender, state } = fixture();
  for (const input of [{ recipient:'bad' },{ amount:'1.0000001' },{ amount:'101' },{ recipient:CONTRACT },{ networkKey:'hoodi' },{ asset:'DAI' }]) await assert.rejects(sender.prepare({ ...INPUT, ...input }));
  assert.equal(state.broadcasts.length,0);
  assert.throws(()=>usdcAddress('sepolia',{ SEPOLIA_USDC_CONTRACT_ADDRESS: USDC_CONTRACTS.mainnet }), /does not match/);
});
test('insufficient USDC, ETH gas, wrong chain/decimals/symbol/code, and gas failures never broadcast', async () => {
  for (const state of [{ tokenBalance:1n },{ ethBalance:0n },{ chain:'0x1' },{ decimals:18n },{ symbol:'FAKE' },{ noCode:true },{ estimateError:true }]) {
    const f=fixture({ state }); await assert.rejects(f.sender.prepare(INPUT)); assert.equal(f.state.broadcasts.length,0);
  }
});
test('USDC balance and gas are rechecked at confirmation', async () => {
  for (const change of ['tokenBalance','ethBalance','gas','chain','nonce','latest','decimals']) {
    const f=fixture(); const review=await f.sender.prepare(INPUT);
    f.state[change] = { tokenBalance:0n, ethBalance:0n, gas:200000n, chain:'0x1', nonce:1, latest:1, decimals:18n }[change];
    await assert.rejects(f.sender.confirm({ reviewId:review.reviewId })); assert.equal(f.state.broadcasts.length,0);
  }
});
test('pending nonce blocks another payment before preparing', async () => {
  const f=fixture({ state:{ nonce:1,latest:0 } }); await assert.rejects(f.sender.prepare(INPUT),/pending transaction/);
});
test('persisted uncertain submission survives restart and prevents a replacement payment', async () => {
  const f=fixture({ state:{ lost:true } }); const review=await f.sender.prepare(INPUT);
  const result=await f.sender.confirm({ reviewId:review.reviewId });
  assert.equal(result.broadcastStatus,'unknown');
  const restored=createSender(f.options);
  assert.deepEqual(await restored.confirm({ reviewId:review.reviewId }),result);
  await assert.rejects(restored.prepare(INPUT),/unresolved/);
  assert.equal(f.state.broadcasts.length,1);
  f.state.receipt={ hash:result.hash,status:1,blockNumber:100,blockHash:BLOCK };
  assert.ok(await restored.prepare(INPUT));
});
test('journal write failure prevents broadcast', async () => {
  const f=fixture({ journal:{ records:()=>[],save(){ throw new Error('disk full'); } } });
  const review=await f.sender.prepare(INPUT);
  await assert.rejects(f.sender.confirm({ reviewId:review.reviewId }),/persist/);
  assert.equal(f.state.broadcasts.length,0);
});
test('USDC proof requires correct contract, signer, recipient, event and exact amount', () => {
  const verify=(data=payment(),input=expected)=>verifyUsdcPayment(input,data,{ chainId:11155111 });
  assert.equal(verify().code,'exact');
  assert.equal(verify().paidUnits,12345678n);
  assert.equal(verify(payment(),{...expected,expected:'12.345679'}).code,'underpaid');
  assert.equal(verify(payment(),{...expected,expected:'12.345677'}).code,'overpaid');
  assert.equal(verify(payment(),{...expected,sender:TO}).code,'wrong-sender');
  assert.equal(verify(payment(),{...expected,recipient:FROM}).code,'wrong-recipient');
  let data=payment(); data.transaction.to=TO; assert.equal(verify(data).code,'wrong-contract');
  data=payment(); data.receipt.logs=[]; assert.equal(verify(data).code,'missing-transfer');
  data=payment(); data.receipt.logs[0].address=TO; assert.equal(verify(data).code,'missing-transfer');
  data=payment(); data.receipt.logs[0].removed=true; assert.equal(verify(data).code,'missing-transfer');
  data=payment(); data.receipt.logs.push(data.receipt.logs[0]); assert.equal(verify(data).code,'missing-transfer');
  data=payment(); data.receipt.logs[0]={address:CONTRACT,...abi.encodeEventLog(abi.getEvent('Transfer'),[TO,FROM,12345678n])}; assert.equal(verify(data).code,'missing-transfer');
  data=payment(); data.transaction.data=abi.encodeFunctionData('transfer',[TO,1n]); assert.equal(verify(data).code,'missing-transfer');
  data=payment(); data.receipt.status=0; assert.equal(verify(data).code,'failed');
  data=payment(); data.receipt=null; assert.equal(verify(data).code,'pending');
  data=payment(); data.transaction=null; data.receipt=null; assert.equal(verify(data).code,'unknown');
  data=payment(); data.receipt.blockNumber++; assert.throws(()=>verify(data),/block/);
  data=payment(); data.transaction.chainId=1n; assert.throws(()=>verify(data),/chain/);
  data=payment(); data.receipt.status=null; assert.throws(()=>verify(data),/status/);
});
test('USDC real HTTP balance adapter uses restricted server-side calls and token history filters', async () => {
  const calls=[];
  const tx={ hash:HASH,from:FROM,to:TO,contractAddress:CONTRACT,tokenDecimal:'6',value:'12345678',timeStamp:'1700000000' };
  const upstream=createUpstream({ networkKey:'sepolia',env:{},fetchImpl:async(url,options={})=>{
    if(!options.method) { const query=new URL(url); calls.push(query.searchParams.get('action')); assert.equal(query.searchParams.get('contractaddress'),CONTRACT); return new Response(JSON.stringify({status:'1',result:[tx]})); }
    const p=JSON.parse(options.body); calls.push(p.method); let result;
    if(p.method==='eth_chainId') result='0xaa36a7';
    else if(p.method==='eth_getCode') result='0x6000';
    else if(p.method==='eth_call') {
      const name=abi.parseTransaction(p.params[0]).name;
      result=abi.encodeFunctionResult(name,[name==='decimals'?6:name==='symbol'?'USDC':12345678n]);
    } else if(p.method==='eth_getTransactionByHash'||p.method==='eth_getTransactionReceipt') result=null;
    else throw new Error('Unexpected RPC');
    return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
  }});
  const app=createApp({upstream}); app.listen(0,'127.0.0.1'); await once(app,'listening');
  const base='http://127.0.0.1:'+app.address().port, original=globalThis.fetch;
  globalThis.fetch=(url,options)=>original(typeof url==='string'&&url.startsWith('/')?base+url:url,options);
  try {
    assert.equal(await liveBalance(FROM,undefined,'sepolia','USDC'),12345678n);
    const history=await liveHistory(FROM,undefined,'sepolia','USDC');
    assert.equal(history[0].value,'12345678'); assert.equal(history[0].status,'indexed');
    const pending=await livePayment(HASH,undefined,'sepolia','USDC');
    assert.equal(pending.contractAddress,CONTRACT); assert.equal(pending.transaction,null);
    assert.ok(calls.includes('tokentx'));
    assert.ok(!calls.includes('eth_sendRawTransaction'));
  } finally { globalThis.fetch=original; app.closeAllConnections(); await new Promise(r=>app.close(r)); }
});
test('token history rejects unrelated or wrong-decimal token entries', async () => {
  for(const patch of [{contractAddress:TO},{tokenDecimal:'18'},{from:TO,to:TO}]) {
    const upstream=createUpstream({networkKey:'sepolia',env:{},fetchImpl:async()=>new Response(JSON.stringify({status:'1',result:[{hash:HASH,from:FROM,to:TO,contractAddress:CONTRACT,tokenDecimal:'6',value:'1',timeStamp:'1',...patch}]}))});
    await assert.rejects(upstream.history(FROM,'USDC'),/invalid or unrelated/);
  }
});

