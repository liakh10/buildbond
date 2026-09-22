/* The agent's log.
   GET  ?vault=&run=&from=      lines of one run (the live one when run is omitted), for the page to stream
   GET  ?receipt=<hex>          a usage receipt, the preimage of a bill's hash on chain
   POST (Bearer BUILD_SECRET)   { vault, run, lines:[{k,x}] } appends lines while the agent works
                                { vault, run, done:{ ok, inTokens, outTokens, maxPrompt, commit, summary } } closes the run:
                                the usage becomes a receipt, the vault is billed for it, and a passing run ships a version. */
import { json, body } from '../lib/http.js';
import { siteConfig } from '../lib/siteconfig.js';
import { redis } from '../lib/store.js';
import { pub, keeper, send, ethUsd, usageUsd, sha256, isAddr, VAULT_ABI, PRICING, RULES } from '../lib/server.js';

const KINDS = new Set(['THINK', 'READ', 'WRITE', 'CHECK', 'INFO', 'FAIL', 'SHIP', 'BILL']);
const parse = x => typeof x === 'string' ? JSON.parse(x) : x;

export default async function handler(req, res) {
  const R = redis();
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.receipt) {
      const r = /^[0-9a-f]{64}$/.test(q.receipt) ? await R.get('bb:receipt:' + q.receipt) : null;
      return r ? json(res, 200, { hash: q.receipt, receipt: parse(r) }) : json(res, 404, { error: 'no such receipt' });
    }
    if (!isAddr(q.vault)) return json(res, 400, { error: 'vault' });
    const vault = q.vault.toLowerCase();
    const live = await R.get('bb:live:' + vault);
    const run = /^[0-9a-z]{4,12}$/.test(q.run || '') ? q.run : live;
    if (!run) return json(res, 200, { run: null, live: null, lines: [] });
    const from = Math.max(0, Number(q.from) || 0);
    const lines = (await R.lrange(`bb:log:${vault}:${run}`, from, from + 499)).map(parse);
    res.setHeader('cache-control', 'no-store');
    return json(res, 200, { run, live, from, lines });
  }

  if ((req.headers.authorization || '') !== 'Bearer ' + (process.env.BUILD_SECRET || '\0')) return json(res, 401, { error: 'unauthorized' });
  const b = body(req);
  if (!isAddr(b.vault) || !/^[0-9a-z]{4,12}$/.test(b.run || '')) return json(res, 400, { error: 'vault and run' });
  const vault = b.vault.toLowerCase(), key = `bb:log:${vault}:${b.run}`;
  const job = parse(await R.get('bb:job'));
  if (!job || job.vault.toLowerCase() !== vault || job.run !== b.run) return json(res, 409, { error: 'not the running job' });
  const add = (k, x) => R.rpush(key, JSON.stringify({ t: Date.now(), k, x: String(x).slice(0, 4000) }));

  if (Array.isArray(b.lines)) {
    for (const l of b.lines.slice(0, 50)) if (KINDS.has(l.k)) await add(l.k, l.x);
    return json(res, 200, { ok: true });
  }
  if (!b.done) return json(res, 400, { error: 'lines or done' });

  /* closing the run */
  const d = b.done, cfg = await siteConfig(req), k = keeper();
  const usage = { inTokens: Math.max(0, Number(d.inTokens) || 0), outTokens: Math.max(0, Number(d.outTokens) || 0), maxPrompt: Number(d.maxPrompt) || 0 };
  const usd = usageUsd(usage), price = await ethUsd();
  const lines = (await R.lrange(key, 0, -1)).map(parse);
  const st = await pub.readContract({ address: job.vault, abi: VAULT_ABI, functionName: 'state' });
  const room = [BigInt(Math.floor(usd / price * 1e18)), 20000000000000000n, st.budget, 50000000000000000n - st.billedToday].reduce((a, v) => v < a ? v : a);
  const receipt = {
    vault: job.vault, run: b.run, version: job.version, model: PRICING.model, pricing: PRICING, ...usage,
    usd: Number(usd.toFixed(6)), ethUsd: price, wei: room > 0n ? room.toString() : '0',
    log: sha256(JSON.stringify(lines)), commit: d.commit || null, ok: !!d.ok, at: Date.now()
  };
  const hash = sha256(JSON.stringify(receipt));
  await R.set('bb:receipt:' + hash, JSON.stringify(receipt));
  const out = { receipt: hash, usd: receipt.usd };
  try {
    if (!k) throw Error('BUILDBOND_KEEPER_KEY is not set');
    if (room > 1000000000n) {
      out.bill = await send(k, job.vault, VAULT_ABI, 'bill', [room, '0x' + hash]);
      await add('BILL', `billed ${(Number(room) / 1e18).toFixed(6)} ETH for $${usd.toFixed(4)} of model usage · receipt ${hash.slice(0, 12)} · tx ${out.bill}`);
    } else await add('BILL', `usage $${usd.toFixed(4)} is below one gwei of budget room, not billed · receipt ${hash.slice(0, 12)}`);
    if (d.ok && /^[0-9a-f]{40}$/.test(d.commit || '')) {
      const url = `${cfg.appsBase}/${job.slug}/`;
      out.ship = await send(k, job.vault, VAULT_ABI, 'ship', [job.version, '0x' + d.commit.padEnd(64, '0'), url]);
      await add('SHIP', `shipped v${job.version} · ${url} · commit ${d.commit.slice(0, 7)} · tx ${out.ship}`);
      await R.del('bb:fails:' + vault);
    } else {
      await add('FAIL', 'the run did not pass its checks, nothing shipped');
      const n = await R.incr('bb:fails:' + vault); if (n === 1) await R.expire('bb:fails:' + vault, 86400);
    }
  } catch (e) {
    await add('FAIL', 'keeper: ' + String(e.shortMessage || e.message).slice(0, 300));
    out.error = String(e.shortMessage || e.message);
  }
  if (d.summary) await add('INFO', String(d.summary).slice(0, 3000));
  const runs = (await R.lrange('bb:runs:' + vault, 0, 0)).map(parse);
  if (runs[0] && runs[0].run === b.run) {
    await R.lpop('bb:runs:' + vault);
    await R.lpush('bb:runs:' + vault, JSON.stringify({ ...runs[0], status: d.ok && out.ship ? 'shipped' : 'failed', endedAt: Date.now(), usd: receipt.usd, receipt: hash, bill: out.bill || null, ship: out.ship || null }));
  }
  await R.set('bb:lastrun:' + vault, String(Date.now()));
  await R.del('bb:live:' + vault);
  await R.del('bb:job');
  json(res, 200, out);
}
