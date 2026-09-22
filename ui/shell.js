/* What every page shares: config into the DOM, the links, the wallet button, the header, and the contract as a bond coupon. */
import * as viem from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';
import * as W from '/lib/wallet.js';
import { explorer } from '/lib/chains.js';
export { viem, W };
export const CHAIN = 4663, pub = W.pubs[CHAIN];
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v || '');
export const link = (kind, v, txt) => `<a href="${explorer(CHAIN, kind, v)}" target="_blank" rel="noopener">${txt || v}</a>`;
export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const S = window.SITE; export const CA = (S.CA || 'SOON').trim(), HAS = isAddr(CA), FACTORY = isAddr(window.BUILDBOND_FACTORY) ? window.BUILDBOND_FACTORY : null;
export const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const fmt = (n, d = 2) => n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const sig = n => n == null || !isFinite(n) ? '—' : n === 0 ? '0' : n >= 1000 ? fmt(n, 0) : n >= 100 ? fmt(n, 1) : n >= 1 ? fmt(n, 3).replace(/\.?0+$/, '') : n >= 0.00001 ? Number(n.toFixed(n >= 0.001 ? 4 : 6)).toString() : n.toExponential(1);
export const ethOf = v => Number(viem.formatEther(BigInt(v || 0)));
export const eth = v => sig(ethOf(v));
export const usd = n => n == null || !isFinite(n) ? '—' : '$' + (n >= 100 ? fmt(n, 0) : fmt(n, 2));
export const big = v => { const x = ethOf(v); return x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : sig(x); };
export const ago = ts => { const s = Math.floor(Date.now() / 1000) - ts; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
export const clock = ms => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
export async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }
export const flash = (el, text, back, ms = 1400) => { el.textContent = text; setTimeout(() => el.textContent = back, ms); };
export const api = (p, o) => fetch(p, o).then(r => r.json());

export function shell(onWallet) {
  document.querySelectorAll('[data-name]').forEach(e => e.textContent = S.NAME);
  document.querySelectorAll('[data-ticker]').forEach(e => e.textContent = S.TICKER);
  document.querySelectorAll('[data-link="x"]').forEach(a => a.href = S.X_URL || 'https://x.com/soon');
  document.querySelectorAll('[data-link="pons"]').forEach(a => a.href = HAS ? window.PONS_HOME + '/' + CA : window.PONS_HOME);
  document.querySelectorAll('[data-link="dex"]').forEach(a => a.href = HAS ? window.DEX_HOME + '/' + CA : window.DEX_HOME);
  const bar = document.querySelector('.bar'), onS = () => bar.classList.toggle('solid', scrollY > 30 || document.body.classList.contains('flat'));
  addEventListener('scroll', onS, { passive: true }); onS();
  const paint = () => { const w = W.state(); $('connect').textContent = w.address ? short(w.address) : 'Connect wallet'; onWallet && onWallet(w); };
  $('connect').onclick = async () => {
    if (W.state().address) { W.disconnect(); return; }
    const list = W.wallets();
    if (list.length <= 1) return W.connect(list[0] && list[0].id).then(paint).catch(e => alert(e.shortMessage || e.message));
    $('wl').innerHTML = list.map(w => `<button data-id="${w.id}">${w.icon ? `<img src="${w.icon}" alt="">` : ''}${esc(w.name)}</button>`).join(''); $('md').classList.add('on');
  };
  $('wl').onclick = e => { const b = e.target.closest('button'); if (!b) return; $('md').classList.remove('on'); W.connect(b.dataset.id).then(paint).catch(err => alert(err.shortMessage || err.message)); };
  $('md').onclick = e => { if (e.target === $('md')) $('md').classList.remove('on'); };
  W.onChange(paint); W.restore().then(paint);
  coupon();
  /* reveal by position on scroll, not IntersectionObserver: content must never stay hidden where IO does not fire */
  const reveal = () => document.querySelectorAll('.rv:not(.shown)').forEach(e => { if (e.getBoundingClientRect().top < innerHeight * 0.94) e.classList.add('shown'); });
  addEventListener('scroll', reveal, { passive: true }); addEventListener('resize', reveal); reveal(); setTimeout(reveal, 400);
}
/* The $BOND contract as a bond coupon: perforated edge, guilloché rosette, the address as the serial. */
function coupon() {
  const c = $('coupon'); if (!c) return;
  const t = $('ca-t'), b = $('ca-c');
  t.textContent = HAS ? CA : 'soon'; t.classList.toggle('soon', !HAS); c.classList.toggle('real', HAS);
  c.onclick = async e => { if (e.target.closest('a')) return; flash(b, HAS ? ((await copy(CA)) ? 'Copied' : 'Copy failed') : 'Not yet', 'Copy'); };
  const g = c.querySelector('.guil');
  if (g) { let d = ''; for (let k = 0; k < 18; k++) { const a = k / 18 * Math.PI; d += `<ellipse cx="150" cy="150" rx="140" ry="46" transform="rotate(${a * 180 / Math.PI} 150 150)"/>`; } g.innerHTML = `<g fill="none" stroke="#2a5a41" stroke-width=".8">${d}<circle cx="150" cy="150" r="140"/><circle cx="150" cy="150" r="46"/></g>`; }
}
