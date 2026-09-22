/* What the pages read.
   GET                 the floor: every coin with its vault state, live run and last shipped version, plus factory totals
   GET ?vault=0x…      one coin: the same, plus its on-chain history (harvests, bills, ships, top-ups) and its runs
   GET ?burns=1        the burn ledger */
import { json } from '../lib/http.js';
import { siteConfig } from '../lib/siteconfig.js';
import { redis } from '../lib/store.js';
import { pub, readFloor, ethUsd, isAddr, FACTORY_ABI, VAULT_ABI, RULES, PRICING, slugOf } from '../lib/server.js';

const parse = x => typeof x === 'string' ? JSON.parse(x) : x;
const EVENTS = VAULT_ABI.filter(x => x.type === 'event' && ['Harvested', 'Billed', 'Shipped', 'ToppedUp', 'StakeReturned', 'ShareClaimed'].includes(x.name));

export default async function handler(req, res) {
  const cfg = await siteConfig(req), q = req.query || {};
  const base = { factory: cfg.factory, appsBase: cfg.appsBase, rules: { ...RULES, HARVEST_MIN_WEI: RULES.HARVEST_MIN_WEI.toString() }, pricing: PRICING };
  if (!cfg.factory) return json(res, 200, { ...base, coins: [], totals: null });
  let R = null; try { R = redis(); } catch {}

  if (q.burns) {
    const burns = R ? (await R.lrange('bb:burns', 0, 49)).map(parse) : [];
    const pending = R ? (await R.lrange('bb:harvests', 0, -1)).map(parse) : [];
    return json(res, 200, { ...base, burns, pending });
  }

  /* the floor is cached for 12 seconds so a busy page does not hammer the RPC */
  let floor = R ? parse(await R.get('bb:floor')) : null;
  if (!floor) {
    const [coins, price, totals] = await Promise.all([
      readFloor(cfg.factory), ethUsd(),
      pub.multicall({ allowFailure: false, contracts: ['totalReceived', 'totalBurnedEth', 'totalBurnedBond', 'burnPool', 'bondToken', 'builder'].map(fn => ({ address: cfg.factory, abi: FACTORY_ABI, functionName: fn })) })
    ]);
    const live = R && coins.length ? await R.mget(...coins.map(c => 'bb:live:' + c.vault.toLowerCase())) : [];
    const last = R && coins.length ? await Promise.all(coins.map(c => R.lrange('bb:runs:' + c.vault.toLowerCase(), 0, 0))) : [];
    floor = {
      price,
      totals: { toBurn: totals[0], burnedEth: totals[1], burnedBond: totals[2], burnPool: totals[3], bondToken: totals[4], builder: totals[5] },
      coins: coins.map((c, i) => ({ ...c, slug: slugOf(c.symbol || 'app', c.vault), live: live[i] || null, lastRun: last[i] && last[i][0] ? parse(last[i][0]) : null }))
    };
    floor = JSON.parse(JSON.stringify(floor, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    if (R) await R.set('bb:floor', JSON.stringify(floor), { ex: 12 });
  }
  if (!q.vault) return json(res, 200, { ...base, ...floor });

  if (!isAddr(q.vault)) return json(res, 400, { error: 'vault' });
  const coin = floor.coins.find(c => c.vault.toLowerCase() === q.vault.toLowerCase());
  if (!coin) return json(res, 404, { error: 'not a Buildbond vault' });
  const logs = await pub.getLogs({ address: coin.vault, events: EVENTS, fromBlock: 0n, toBlock: 'latest' }).catch(() => []);
  const blocks = [...new Set(logs.map(l => l.blockNumber))].slice(-200);
  const times = Object.fromEntries(await Promise.all(blocks.map(async b => [b.toString(), Number((await pub.getBlock({ blockNumber: b })).timestamp)])));
  const history = logs.map(l => ({ event: l.eventName, args: l.args, tx: l.transactionHash, block: l.blockNumber, at: times[l.blockNumber.toString()] || null }));
  const runs = R ? (await R.lrange('bb:runs:' + coin.vault.toLowerCase(), 0, 29)).map(parse) : [];
  json(res, 200, JSON.parse(JSON.stringify({ ...base, price: floor.price, totals: floor.totals, coin, history, runs }, (k, v) => typeof v === 'bigint' ? v.toString() : v)));
}
