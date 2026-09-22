/* Shared storage for the apps the agent ships. Apps are static pages on another origin; this gives them one small public
   list store per coin, so a guestbook, a leaderboard or a prediction board can be real and shared.
   GET  ?vault=&key=&limit=          newest first, public
   POST { vault, key, value, address, ts, sig, holders }
        signed by the wallet: "Buildbond app <vault>\nkey: <key>\nvalue: <sha256 of value>\nts: <ts>"
        holders=true refuses writers who hold none of the coin. One write per 3 seconds per wallet, 2 KB per value,
        the newest 500 per key are kept. */
import { verifyMessage } from 'viem';
import { json, body } from '../lib/http.js';
import { siteConfig } from '../lib/siteconfig.js';
import { redis } from '../lib/store.js';
import { pub, readFloor, isAddr, sha256, ERC20 } from '../lib/server.js';

const KEY = /^[a-z0-9_-]{1,32}$/;
const parse = x => typeof x === 'string' ? JSON.parse(x) : x;
const cors = res => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type'); res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS'); };

async function coinOf(req, vault) {
  const R = redis(), hit = await R.get('bb:coinof:' + vault);
  if (hit) return hit;
  const cfg = await siteConfig(req);
  if (!cfg.factory) return null;
  const c = (await readFloor(cfg.factory)).find(x => x.vault.toLowerCase() === vault);
  if (c) await R.set('bb:coinof:' + vault, c.coin, { ex: 86400 });
  return c ? c.coin : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const R = redis();
  if (req.method === 'GET') {
    const q = req.query || {};
    if (!isAddr(q.vault) || !KEY.test(q.key || '')) return json(res, 400, { error: 'vault and key' });
    const n = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const items = (await R.lrange(`bb:kv:${q.vault.toLowerCase()}:${q.key}`, 0, n - 1)).map(parse);
    return json(res, 200, { items });
  }
  const b = body(req);
  const vault = String(b.vault || '').toLowerCase();
  if (!isAddr(vault) || !KEY.test(b.key || '') || !isAddr(b.address)) return json(res, 400, { error: 'vault, key and address' });
  const value = typeof b.value === 'string' ? b.value : JSON.stringify(b.value ?? null);
  if (value.length > 2048) return json(res, 413, { error: 'value over 2 KB' });
  const ts = Number(b.ts);
  if (!ts || Math.abs(Date.now() - ts) > 5 * 60e3) return json(res, 400, { error: 'stale signature, sign again' });
  const message = `Buildbond app ${vault}\nkey: ${b.key}\nvalue: ${sha256(value)}\nts: ${ts}`;
  const good = await verifyMessage({ address: b.address, message, signature: b.sig }).catch(() => false);
  if (!good) return json(res, 401, { error: 'the signature does not match the wallet' });
  const coin = await coinOf(req, vault);
  if (!coin) return json(res, 404, { error: 'not a Buildbond vault' });
  if (!(await R.set(`bb:kvrate:${b.address.toLowerCase()}`, '1', { nx: true, px: 3000 }))) return json(res, 429, { error: 'one write per 3 seconds' });
  const held = await pub.readContract({ address: coin, abi: ERC20, functionName: 'balanceOf', args: [b.address] }).catch(() => 0n);
  if (b.holders && held === 0n) return json(res, 403, { error: 'holders only' });
  let v; try { v = JSON.parse(value); } catch { v = value; }
  const item = { by: b.address, at: Date.now(), holder: held > 0n, value: v };
  const k = `bb:kv:${vault}:${b.key}`;
  await R.lpush(k, JSON.stringify(item));
  await R.ltrim(k, 0, 499);
  json(res, 200, { ok: true, item });
}
