/* Server-side chain access for the Buildbond API: reading the floor, the ETH price, and the keeper's wallet. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, http, fallback, parseAbi, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/* BB_DEV_RPC points the API at contracts/devchain.mjs while working locally; production never sets it. */
const RPC = process.env.BB_DEV_RPC ? [process.env.BB_DEV_RPC] : ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
export const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: RPC } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } };
export const pub = createPublicClient({ chain, transport: fallback(RPC.map(u => http(u, { timeout: 20000 }))), batch: { multicall: true } });

const abiOf = n => JSON.parse(fs.readFileSync(new URL(`./abi/${n}.json`, import.meta.url), 'utf8')).abi;
export const FACTORY_ABI = abiOf('BondFactory');
export const VAULT_ABI = abiOf('BondVault');
export const ERC20 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const PONS_ABI = parseAbi(['function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
export const CURVE_ABI = parseAbi(['function realQuoteReserve() view returns (uint256)', 'function graduationThreshold() view returns (uint256)', 'function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)']);
const FEED = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns (uint8)']);
export const LAUNCHED = parseAbiItem('event Launched(address indexed vault, address indexed launcher, address indexed coin, string name, string symbol, string brief)');

/* The rules the keeper follows. They are off chain on purpose: the contract caps what a bill can take, these decide when
   a build is worth starting. Shown on the site as they are. */
export const RULES = {
  BUILD_AT_USD: 10,          /* the first build starts once the budget is worth this much */
  ITERATE_AFTER_H: 12,       /* a new version is considered at most this often, and only with the same budget */
  BURN_AT_USD: 5,            /* the factory burns $BOND once its pool is worth this much */
  HARVEST_MIN_WEI: 200000000000000n,   /* 0.0002 ETH waiting in the escrow before a harvest is worth its gas */
  MAX_RUN_USD: 3,            /* the agent stops a single run past this much model usage */
  MAX_FAILS: 3               /* runs that fail in a row before a coin is left alone for a day */
};

/* Gemini 2.5 Pro list price in USD per million tokens (prompts up to 200k tokens). Output includes thinking tokens. */
export const PRICING = { model: 'gemini-2.5-pro', inPerM: 1.25, outPerM: 10, inPerMLong: 2.5, outPerMLong: 15 };
export function usageUsd(u) {
  const long = (u.maxPrompt || 0) > 200000;
  return (u.inTokens * (long ? PRICING.inPerMLong : PRICING.inPerM) + u.outTokens * (long ? PRICING.outPerMLong : PRICING.outPerM)) / 1e6;
}

let priceCache = { at: 0, v: 0 };
export async function ethUsd() {
  if (Date.now() - priceCache.at < 60000 && priceCache.v) return priceCache.v;
  const [r, d] = await Promise.all([pub.readContract({ address: FEED, abi: FEED_ABI, functionName: 'latestRoundData' }), pub.readContract({ address: FEED, abi: FEED_ABI, functionName: 'decimals' })]);
  const v = Number(r[1]) / 10 ** Number(d);
  priceCache = { at: Date.now(), v };
  return v;
}

export function keeper() {
  const key = process.env.BUILDBOND_KEEPER_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key || '')) return null;
  const account = privateKeyToAccount(key);
  return { account, wallet: createWalletClient({ account, chain, transport: http(RPC[0], { timeout: 30000 }) }) };
}
export async function send(k, address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ account: k.account, address, abi, functionName, args });
  const hash = await k.wallet.writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 45000 });
  if (r.status !== 'success') throw Error(functionName + ' reverted ' + hash);
  return hash;
}

export const slugOf = (symbol, vault) => `${String(symbol).toLowerCase().replace(/[^a-z0-9]/g, '') || 'app'}-${vault.slice(2, 6).toLowerCase()}`;
export const sha256 = s => createHash('sha256').update(s).digest('hex');
export const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v || '');

/* Every coin the factory launched, with its vault's state and its curve, in two multicalls. */
export async function readFloor(factory) {
  const n = Number(await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'count' }));
  const entries = [];
  for (let i = 0; i < n; i += 200) entries.push(...await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'entries', args: [BigInt(i), 200n] }));
  if (!entries.length) return [];
  const calls = entries.flatMap(e => [
    { address: e.vault, abi: VAULT_ABI, functionName: 'state' },
    { address: e.coin, abi: ERC20, functionName: 'name' },
    { address: e.coin, abi: ERC20, functionName: 'symbol' },
    { address: PONS, abi: PONS_ABI, functionName: 'getLaunchedToken', args: [e.coin] }
  ]);
  const r = await pub.multicall({ contracts: calls, allowFailure: true });
  const out = entries.map((e, i) => {
    const [st, name, symbol, lt] = r.slice(i * 4, i * 4 + 4).map(x => x.status === 'success' ? x.result : null);
    return { vault: e.vault, launcher: e.launcher, coin: e.coin, launchedAt: Number(e.launchedAt), name, symbol, state: st, curve: lt ? lt.curve : null, phase: lt ? Number(lt.phase) : null };
  });
  /* fees sit on the curve until a sweep moves them to the escrow; harvest does both, so both count as unswept */
  const FNS = ['realQuoteReserve', 'graduationThreshold', 'creatorTaxBalance', 'quoteFeeBalance'];
  const cr = await pub.multicall({ contracts: out.flatMap(o => o.curve ? FNS.map(functionName => ({ address: o.curve, abi: CURVE_ABI, functionName })) : []), allowFailure: true });
  let j = 0;
  for (const o of out) if (o.curve) {
    const [a, b, c, d] = FNS.map(() => cr[j++]).map(x => x.status === 'success' ? x.result : null);
    o.reserve = a; o.graduation = b; o.unswept = (c || 0n) + (d || 0n);
  }
  return out;
}
