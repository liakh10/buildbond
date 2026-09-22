/* Local dev server: static files, the page rewrites and the Vercel functions in api/.
   With BB_DEV_RPC and BUILDBOND_FACTORY set (see contracts/devchain.mjs) the pages and the API read the local chain,
   and BB_MEMORY=1 keeps storage in memory. ?devwallet=launcher|trader puts a development-key wallet into the page. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const DEV_KEYS = { launcher: '0x2da51d69f842b7bb1346fc26fa44b920dadeba2b6ea629dc4e48def54c6b8369', trader: '0xd90ddf59a6de30ba775e4cdca2c283606427d63ada81b310a1b5d7f012eb1cb4' };
const devWallet = key => `<script>(() => { const RPC = ${JSON.stringify(process.env.BB_DEV_RPC)}, KEY = "${key}"; let acct;
  const rpc = (method, params) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) }).then(r => r.json()).then(j => { if (j.error) throw Object.assign(Error(j.error.message), j.error); return j.result; });
  const me = async () => acct || (acct = (await import('https://cdn.jsdelivr.net/npm/viem@2.21.55/accounts/+esm')).privateKeyToAccount(KEY));
  window.ethereum = { isDevWallet: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [(await me()).address];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
    if (method === 'personal_sign') return (await me()).signMessage({ message: { raw: params[0] } });
    if (method === 'eth_sendTransaction') { const t = params[0], a = await me(), nonce = await rpc('eth_getTransactionCount', [a.address, 'pending']), gas = t.gas || await rpc('eth_estimateGas', [t]);
      return rpc('eth_sendRawTransaction', [await a.signTransaction({ chainId: 4663, type: 'eip1559', to: t.to, data: t.data, value: BigInt(t.value || 0), nonce: Number(nonce), gas: BigInt(gas), maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n })]); }
    return rpc(method, params); } };
  try { localStorage.setItem('buildbond:wallet', 'injected'); } catch {} })();</script>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  try {
    if (u.pathname.startsWith('/api/')) {
      const mod = await import(pathToFileURL(path.join(root, 'api', u.pathname.slice(5).replace(/\/$/, '') + '.js')).href);
      req.query = Object.fromEntries(u.searchParams);
      let data = '';
      for await (const c of req) data += c;
      req.body = data;
      return await mod.default(req, res);
    }
    let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
    if (/^\/a\/0x[0-9a-fA-F]{40}$/.test(p)) p = '/app.html';
    if (!path.extname(p)) p += '.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || /\/(contracts|builder)\//.test(f)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    if (p === '/config.js' && process.env.BB_DEV_RPC) return res.end(fs.readFileSync(f, 'utf8') + `\n/* dev */ window.BUILDBOND_FACTORY = "${process.env.BUILDBOND_FACTORY || ''}"; window.DEV_RPC = "${process.env.BB_DEV_RPC}";${process.env.APPS_BASE ? ` window.APPS_BASE = "${process.env.APPS_BASE}";` : ''}\n`);
    const dw = u.searchParams.get('devwallet');
    if (dw && DEV_KEYS[dw] && process.env.BB_DEV_RPC && path.extname(f) === '.html') return res.end(fs.readFileSync(f, 'utf8').replace('<script type="module"', devWallet(DEV_KEYS[dw]) + '<script type="module"'));
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.statusCode = 500; res.end(String(e.stack || e)); }
}).listen(Number(process.env.PORT || 8817), () => console.log('buildbond dev on', process.env.PORT || 8817));
