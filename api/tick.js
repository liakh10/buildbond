/* The keeper, called by the GitHub workflow every ten minutes with CRON_SECRET. In order:
   1. harvest every vault with fees waiting in the Pons escrow (anyone may, the keeper pays the gas);
   2. burn the factory's pool into $BOND once it is worth RULES.BURN_AT_USD, with an attestation of the harvests it spends;
   3. hand out at most one build job: the first build once a budget is worth RULES.BUILD_AT_USD, later versions at most
      every RULES.ITERATE_AFTER_H hours on the same condition. The workflow runs the agent and reports back to /api/log. */
import { decodeEventLog } from 'viem';
import { json } from '../lib/http.js';
import { siteConfig } from '../lib/siteconfig.js';
import { redis } from '../lib/store.js';
import { pub, keeper, send, readFloor, ethUsd, RULES, FACTORY_ABI, VAULT_ABI, slugOf, sha256 } from '../lib/server.js';

const JOB_TTL = 45 * 60;

export default async function handler(req, res) {
  if ((req.headers.authorization || '') !== 'Bearer ' + (process.env.CRON_SECRET || '\0')) return json(res, 401, { error: 'unauthorized' });
  const cfg = await siteConfig(req);
  if (!cfg.factory) return json(res, 200, { idle: 'no factory yet', job: null });
  const k = keeper();
  if (!k) return json(res, 200, { idle: 'BUILDBOND_KEEPER_KEY is not set', job: null });
  const R = redis(), did = [], errors = [];
  let floor = await readFloor(cfg.factory);
  const price = await ethUsd();

  // 1. harvest
  for (const c of floor) {
    if (!c.state || c.state.waiting + (c.unswept || 0n) < RULES.HARVEST_MIN_WEI) continue;
    try {
      const hash = await send(k, c.vault, VAULT_ABI, 'harvest', []);
      const r = await pub.getTransactionReceipt({ hash });
      const ev = r.logs.map(l => { try { return decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find(x => x && x.eventName === 'Harvested');
      const eth = ev ? ev.args.eth.toString() : '0';
      await R.rpush('bb:harvests', JSON.stringify({ vault: c.vault, symbol: c.symbol, tx: hash, eth, at: Date.now() }));
      did.push({ harvest: c.symbol, tx: hash });
    } catch (e) { errors.push('harvest ' + c.symbol + ': ' + String(e.shortMessage || e.message).slice(0, 160)); }
  }

  // 2. burn
  try {
    const [bond, pool] = await Promise.all([
      pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'bondToken' }),
      pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'burnPool' })
    ]);
    if (bond !== '0x0000000000000000000000000000000000000000' && Number(pool) / 1e18 * price >= RULES.BURN_AT_USD) {
      const spent = (await R.lrange('bb:harvests', 0, -1)).map(x => typeof x === 'string' ? JSON.parse(x) : x);
      const attestation = '0x' + sha256(JSON.stringify(spent.map(h => h.tx)));
      /* the expected output is simulated first; the burn accepts 3% less */
      const { result } = await pub.simulateContract({ account: k.account, address: cfg.factory, abi: FACTORY_ABI, functionName: 'burn', args: [pool, 1n, attestation] });
      const hash = await send(k, cfg.factory, FACTORY_ABI, 'burn', [pool, result * 97n / 100n, attestation]);
      await R.lpush('bb:burns', JSON.stringify({ tx: hash, eth: pool.toString(), bond: result.toString(), attestation, harvests: spent, at: Date.now() }));
      await R.del('bb:harvests');
      did.push({ burn: pool.toString(), tx: hash });
    }
  } catch (e) { errors.push('burn: ' + String(e.shortMessage || e.message).slice(0, 160)); }

  // 3. one build job, against budgets as they are after this tick's harvests
  if (did.some(d => d.harvest)) floor = await readFloor(cfg.factory);
  let job = null;
  const running = await R.get('bb:job');
  if (running) job = null;
  else {
    const now = Date.now();
    const candidates = [];
    for (const c of floor) {
      if (!c.state) continue;
      const budgetUsd = Number(c.state.budget) / 1e18 * price;
      if (budgetUsd < RULES.BUILD_AT_USD) continue;
      if (Number(await R.get('bb:fails:' + c.vault.toLowerCase()) || 0) >= RULES.MAX_FAILS) continue;
      const last = Number(await R.get('bb:lastrun:' + c.vault.toLowerCase()) || 0);
      if (c.state.version > 0 && now - last < RULES.ITERATE_AFTER_H * 3600e3) continue;
      candidates.push({ c, budgetUsd, last });
    }
    /* first builds before iterations, then whoever waited longest */
    candidates.sort((a, b) => (a.c.state.version > 0) - (b.c.state.version > 0) || a.last - b.last);
    if (candidates.length) {
      const { c, budgetUsd } = candidates[0];
      const run = Date.now().toString(36);
      job = {
        vault: c.vault, coin: c.coin, name: c.name, symbol: c.symbol, brief: c.state.brief, run,
        version: c.state.version + 1, slug: slugOf(c.symbol, c.vault), site: cfg.origin,
        maxUsd: Math.min(RULES.MAX_RUN_USD, budgetUsd * 0.8), startedAt: Date.now()
      };
      const ok = await R.set('bb:job', JSON.stringify(job), { nx: true, ex: JOB_TTL });
      if (!ok) job = null;
      else {
        await R.set('bb:live:' + c.vault.toLowerCase(), run, { ex: JOB_TTL });
        await R.lpush('bb:runs:' + c.vault.toLowerCase(), JSON.stringify({ run, version: job.version, status: 'building', startedAt: job.startedAt }));
        await R.rpush(`bb:log:${c.vault.toLowerCase()}:${run}`, JSON.stringify({ t: Date.now(), k: 'INFO', x: `run ${run} starts v${job.version} with a $${budgetUsd.toFixed(2)} budget, this run may spend up to $${job.maxUsd.toFixed(2)}` }));
      }
    }
  }
  json(res, 200, { did, errors, job, running: running ? JSON.parse(running) : null, price });
}
