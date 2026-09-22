/* Coin logos. POST a small data URL (png, jpeg or webp, up to 200 KB) and get back a permanent URL for the Pons launch.
   GET ?id= serves it. Stored by content hash, so the URL never changes and never points at something else. */
import { json, body, ipOf } from '../lib/http.js';
import { redis } from '../lib/store.js';
import { sha256 } from '../lib/server.js';

export default async function handler(req, res) {
  const R = redis();
  if (req.method === 'GET') {
    const id = String((req.query || {}).id || '');
    const v = /^[0-9a-f]{32}$/.test(id) ? await R.get('bb:img:' + id) : null;
    if (!v) { res.statusCode = 404; return res.end('not found'); }
    const m = String(v).match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    res.setHeader('content-type', m[1]);
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    return res.end(Buffer.from(m[2], 'base64'));
  }
  const { data } = body(req);
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data || '') || data.length > 280000) return json(res, 400, { error: 'png, jpeg or webp up to 200 KB' });
  const n = await R.incr('bb:imgrate:' + ipOf(req)); if (n === 1) await R.expire('bb:imgrate:' + ipOf(req), 3600);
  if (n > 20) return json(res, 429, { error: 'too many uploads, try later' });
  const id = sha256(data).slice(0, 32);
  await R.set('bb:img:' + id, data);
  const host = String(req.headers['x-forwarded-host'] || req.headers.host);
  json(res, 200, { id, url: (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host + '/api/img?id=' + id });
}
