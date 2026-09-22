/* A local chain for working on the site, the keeper and the agent before anything is deployed: the mainnet fork from
   fork.mjs with the Buildbond contracts deployed into it, $BOND named, and three coins launched with real trades on their
   Pons curves, served as JSON-RPC on :8547 with eth_getLogs. The keeper, launcher and trader are development keys made for this file; they are empty on mainnet (the well-known
   Hardhat keys are not used: on Robinhood Chain they carry an EIP-7702 delegation that refuses ETH).
   Writes are accepted as signed raw transactions and run in the VM as calls from the recovered sender. Nothing here
   touches mainnet. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Address, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { Block } from '@ethereumjs/block';
import { Common, Hardfork } from '@ethereumjs/common';
import { parseTransaction, recoverTransactionAddress, keccak256, parseAbi, getAddress, toHex, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fork, E, addr } from './fork.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const FA = art('BondFactory'), VA = art('BondVault');
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const PONSF = parseAbi(['function launchFee() view returns (uint256)', 'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const CURVE = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)']);
export const DEV_KEYS = { keeper: '0x78f67ea50a8bbd9beb66bd65241686f2ff5c47a993ee6605a456be77b694a15d', launcher: '0x2da51d69f842b7bb1346fc26fa44b920dadeba2b6ea629dc4e48def54c6b8369', trader: '0xd90ddf59a6de30ba775e4cdca2c283606427d63ada81b310a1b5d7f012eb1cb4' };
const PORT = Number(process.env.PORT || 8547);

const T = await fork(dir, [...FA.abi, ...VA.abi]);
const { view, giveEth, deploy } = T;
const keeper = privateKeyToAccount(DEV_KEYS.keeper).address, launcher = privateKeyToAccount(DEV_KEYS.launcher).address, trader = privateKeyToAccount(DEV_KEYS.trader).address;
const guardian = addr(0xd0), bob = addr(0xb0), carol = addr(0xca);
for (const w of [guardian, keeper, launcher, trader, bob, carol]) await giveEth(w, E(80));

// ------------------------------------------------------------------ one path for every write, so logs are kept
const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
let height = BigInt(T.head.number) + 1n;
const times = new Map();
const block = () => Block.fromBlockData({ header: { number: height, timestamp: T.now, gasLimit: 60_000_000n, baseFeePerGas: 0n } }, { common });
const nonces = new Map(), receipts = new Map(), allLogs = [];
const A = a => Address.fromString(a);
async function call({ from, to, data, value }, commit) {
  const sm = T.vm.stateManager;
  if (!commit) await sm.checkpoint();
  try { return await T.vm.evm.runCall({ caller: A(from || addr(1)), origin: A(from || addr(1)), to: to ? A(to) : undefined, data: hexToBytes(data || '0x'), gasLimit: 50_000_000n, value: BigInt(value || 0), block: block() }); }
  finally { if (!commit) await sm.revert(); }
}
async function commitTx(from, to, data, value, hash) {
  T.now += 2n; height += 1n; times.set(height, T.now);
  const r = await call({ from, to, data, value }, true), e = r.execResult;
  nonces.set(from.toLowerCase(), (nonces.get(from.toLowerCase()) || 0) + 1);
  hash = hash || keccak256(toHex(`${from}${height}${Math.random()}`));
  const logs = e.exceptionError ? [] : (e.logs || []).map(([a, topics, d], i) => ({ address: getAddress(bytesToHex(a)), topics: topics.map(bytesToHex), data: bytesToHex(d), blockNumber: toHex(height), transactionHash: hash, transactionIndex: '0x0', blockHash: keccak256(toHex(height)), logIndex: toHex(i), removed: false }));
  allLogs.push(...logs);
  receipts.set(hash, { transactionHash: hash, blockNumber: toHex(height), blockHash: keccak256(toHex(height)), transactionIndex: '0x0', from, to: to || null, contractAddress: r.createdAddress ? getAddress(r.createdAddress.toString()) : null,
    status: e.exceptionError ? '0x0' : '0x1', gasUsed: toHex(e.executionGasUsed), cumulativeGasUsed: toHex(e.executionGasUsed), effectiveGasPrice: '0x5f5e100', type: '0x2', logsBloom: '0x' + '00'.repeat(256), logs });
  return { hash, reverted: !!e.exceptionError, ret: bytesToHex(e.returnValue), logs };
}
const send = async (from, to, abi, functionName, args = [], value = 0n) => {
  const r = await commitTx(from, to, encodeFunctionData({ abi, functionName, args }), value);
  if (r.reverted) throw Error(`${functionName} reverted ${r.ret.slice(0, 200)}`);
  return r;
};

// ------------------------------------------------------------------ the story
const fee = await view(PONS, PONSF, 'launchFee');
const STAKE = E(0.01);
const IMPL = await deploy(guardian, VA, []), F = await deploy(guardian, FA, [IMPL, keeper]);
const launched = async (who, name, symbol, brief, first) => {
  const r = await send(who, F, FA.abi, 'launch', [name, symbol, '', brief, 1n], fee + STAKE + first);
  const topic = r.logs.find(l => l.address === F);
  const vault = getAddress('0x' + topic.topics[1].slice(26)), coin = getAddress('0x' + topic.topics[3].slice(26));
  return { vault, coin, curve: (await view(PONS, PONSF, 'getLaunchedToken', [coin])).curve };
};
const bond = await launched(guardian, 'Buildbond', 'BOND', 'The platform coin. A quarter of every app coin\'s fees buys it and burns it.', 0n);
await send(guardian, F, FA.abi, 'setBondToken', [bond.coin]);
const tip = await launched(launcher, 'Busker Tips', 'BUSK', 'A tip board for street musicians: each musician gets a page with a QR code, fans leave a message and a tip note, and the board shows the most tipped performers this week. Holders can pin one message a day.', E(0.05));
const radar = await launched(launcher, 'Deadline Radar', 'RADAR', 'Track your deadlines in one place and get a clear daily view of what is due soon, with a shared public board where holders can post team deadlines.', 0n);
const quiet = await launched(trader, 'Quiet Garden', 'QUIET', 'A calm page where people plant one line of text a day into a shared garden that grows as more lines are planted.', 0n);
T.now += 60n;
for (const [w, v] of [[bob, 1.4], [carol, 0.9], [trader, 0.5]]) await send(w, tip.curve, CURVE, 'buy', [E(v), 1n, w], E(v));
await send(bob, radar.curve, CURVE, 'buy', [E(0.08), 1n, bob], E(0.08));
await send(carol, bond.curve, CURVE, 'buy', [E(0.3), 1n, carol], E(0.3));
console.log(JSON.stringify({ factory: F, bond: bond.coin, coins: { tip, radar, quiet }, keeper, launcher, trader }, null, 1));

// ------------------------------------------------------------------ JSON-RPC over the VM
const rpcError = (code, message, data) => Object.assign(Error(message), { code, data });
const num = v => v === undefined || v === 'latest' || v === 'pending' || v === 'safe' || v === 'finalized' ? height : v === 'earliest' ? 0n : BigInt(v);
const methods = {
  eth_chainId: () => '0x1237', net_version: () => '4663',
  eth_blockNumber: () => toHex(height),
  eth_gasPrice: () => '0x5f5e100', eth_maxPriorityFeePerGas: () => '0x0',
  eth_feeHistory: () => ({ oldestBlock: toHex(height), baseFeePerGas: ['0x5f5e100', '0x5f5e100'], gasUsedRatio: [0.1], reward: [['0x0']] }),
  eth_getBlockByNumber: ([n]) => { const b = num(n); return { number: toHex(b), timestamp: toHex(times.get(b) || T.now), baseFeePerGas: '0x5f5e100', gasLimit: toHex(60_000_000), hash: keccak256(toHex(b)), parentHash: keccak256(toHex(b - 1n)), transactions: [] }; },
  eth_getBalance: async ([a]) => toHex((await T.vm.stateManager.getAccount(A(a)))?.balance ?? 0n),
  eth_getCode: async ([a]) => bytesToHex(await T.vm.stateManager.getContractCode(A(a))),
  eth_getTransactionCount: ([a]) => toHex(nonces.get(a.toLowerCase()) || 0),
  eth_estimateGas: async ([t]) => { const r = await call(t, false); if (r.execResult.exceptionError) throw rpcError(3, 'execution reverted', bytesToHex(r.execResult.returnValue)); return toHex(r.execResult.executionGasUsed * 2n + 60000n); },
  eth_call: async ([t]) => { const r = await call(t, false); if (r.execResult.exceptionError) throw rpcError(3, 'execution reverted', bytesToHex(r.execResult.returnValue)); return bytesToHex(r.execResult.returnValue); },
  eth_sendRawTransaction: async ([raw]) => {
    const t = parseTransaction(raw), from = await recoverTransactionAddress({ serializedTransaction: raw });
    return (await commitTx(from, t.to, t.data, t.value, keccak256(raw))).hash;
  },
  eth_getTransactionReceipt: ([h]) => receipts.get(h) || null,
  eth_getTransactionByHash: ([h]) => { const r = receipts.get(h); return r ? { hash: h, blockNumber: r.blockNumber, from: r.from, to: r.to } : null; },
  eth_getLogs: ([f]) => {
    const from = num(f.fromBlock ?? 'earliest'), to = num(f.toBlock);
    const addrs = f.address ? [].concat(f.address).map(a => a.toLowerCase()) : null;
    const t0 = f.topics && f.topics[0] ? [].concat(f.topics[0]).map(t => t.toLowerCase()) : null;
    return allLogs.filter(l => { const b = BigInt(l.blockNumber); return b >= from && b <= to && (!addrs || addrs.includes(l.address.toLowerCase())) && (!t0 || t0.includes(l.topics[0].toLowerCase())); });
  },
  /* development only */
  dev_increaseTime: ([s]) => { T.now += BigInt(s); height += 1n; times.set(height, T.now); return toHex(T.now); },
  dev_buy: async ([coin, eth]) => { const c = (await view(PONS, PONSF, 'getLaunchedToken', [coin])).curve; return (await send(bob, c, CURVE, 'buy', [E(Number(eth)), 1n, bob], E(Number(eth)))).hash; }
};
let queue = Promise.resolve();
http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 204; return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    queue = queue.then(async () => {
      const input = JSON.parse(body), list = Array.isArray(input) ? input : [input], out = [];
      for (const q of list) {
        try { if (!methods[q.method]) throw rpcError(-32601, 'method not found: ' + q.method); out.push({ jsonrpc: '2.0', id: q.id, result: await methods[q.method](q.params || []) }); }
        catch (e) { out.push({ jsonrpc: '2.0', id: q.id, error: { code: e.code || -32000, message: e.message, data: e.data } }); }
      }
      res.end(JSON.stringify(Array.isArray(input) ? out : out[0]));
    }).catch(e => { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); });
  });
}).listen(PORT, () => console.log('devchain on http://localhost:' + PORT));
