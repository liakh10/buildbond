/* A fork of Robinhood Chain mainnet inside the ethereumjs VM (RPCStateManager reads state lazily from the public RPC).
   Any address can be impersonated, so tokens are borrowed from the pools that hold them. No real keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, encodeDeployData, parseAbi, getAddress } from 'viem';

export const RPC = 'https://robinhood-rpc.publicnode.com';
const realFetch = globalThis.fetch;
export const stats = { retries: 0, calls: 0 };
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(RPC)) return realFetch(url, opts);
  stats.calls++;
  let last;
  for (let i = 0; i < 8; i++) {
    try { const text = await (await realFetch(url, opts)).text(); const j = JSON.parse(text); if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }); last = JSON.stringify(j.error || j).slice(0, 200); }
    catch (e) { last = String(e.message || e); }
    stats.retries++;
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed: ' + last);
};

class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}

export const E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
export const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
export const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);

export async function fork(dir, abis) {
  const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
  const ALL = [...abis, ...parseAbi(['error Error(string)'])].filter((x, i, a) => x.type !== 'event' || a.findIndex(y => y.type === 'event' && y.name === x.name) === i);
  const head = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()).result;
  const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
  const stateManager = new ForkState({ provider: RPC, blockTag: BigInt(head.number) });
  stateManager._blockTag = 'latest';
  const vm = await VM.create({ common, stateManager });
  const T = { now: BigInt(head.timestamp) + 12n, pass: 0, fail: 0, head };
  const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: T.now, gasLimit: 60_000_000n, baseFeePerGas: 0n } }, { common });

  T.ok = (c, label, extra = '') => { if (c) T.pass++; else { T.fail++; console.log('  FAIL', label, extra); } };
  T.exec = async (from, to, data, value = 0n) => {
    const r = await vm.evm.runCall({ caller: Address.fromString(from), origin: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 60_000_000n, value, block: block() });
    const e = r.execResult; let reason = null;
    if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args && d.args.length ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue).slice(0, 138); } }
    const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: ALL, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
    return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed, created: r.createdAddress ? getAddress(r.createdAddress.toString()) : null };
  };
  T.tx = async (from, to, abi, functionName, args = [], value = 0n) => {
    const r = await T.exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
    if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
    return r;
  };
  T.must = async (from, to, abi, fn, args, label, value = 0n) => { const r = await T.tx(from, to, abi, fn, args, value); T.ok(!r.reverted, label, r.reason || ''); return r; };
  T.reverts = async (from, to, abi, fn, args, expect, label, value = 0n) => { const r = await T.tx(from, to, abi, fn, args, value); T.ok(r.reverted && (!expect || String(r.reason).includes(expect)), label, `reverted=${r.reverted} reason=${r.reason}`); return r; };
  /* a view runs inside a checkpoint so that state-changing "views" (quoters) leave nothing behind */
  T.view = async (to, abi, fn, args = [], from = addr(1)) => {
    await vm.stateManager.checkpoint();
    try { const r = await T.tx(from, to, abi, fn, args); if (r.reverted) throw Error(fn + ' reverted: ' + r.reason); return r.result; }
    finally { await vm.stateManager.revert(); }
  };
  T.giveEth = async (who, wei) => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.balance = wei; await vm.stateManager.putAccount(a, acct); };
  T.ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;
  T.bal = (token, who) => T.view(token, ERC20, 'balanceOf', [who]);
  T.deploy = async (from, a, args = []) => {
    const r = await T.exec(from, null, args.length ? encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) : a.bytecode);
    if (r.reverted) throw Error('deploy failed ' + a.contractName + ' ' + r.reason);
    const who = Address.fromString(from), acct = (await vm.stateManager.getAccount(who)) ?? new Account();
    acct.nonce += 1n; await vm.stateManager.putAccount(who, acct);
    return r.created;
  };
  T.art = art; T.vm = vm;
  T.done = () => { console.log(`\n${T.pass} passed, ${T.fail} failed · rpc retries ${stats.retries} · rpc calls ${stats.calls}`); process.exit(T.fail ? 1 : 0); };
  return T;
}
