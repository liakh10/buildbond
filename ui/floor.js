/* The front page: the meter, the floor (coins + the live agent log), the three shares, the launch form, the burn ledger. */
import { viem, W, CHAIN, pub, $, esc, link, short, FACTORY, still, eth, ethOf, usd, big, ago, api, shell } from '/ui/shell.js';
import { makeConsole } from '/ui/console.js';

const FA = await fetch('/lib/abi/BondFactory.json?v=1').then(r => r.json());
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const PONS_ABI = viem.parseAbi(['function launchFee() view returns (uint256)']);
const STAKE = 10n ** 16n;
let floor = null, sel = null, wallet = {};
const con = makeConsole({ lines: 'c-lines', select: 'c-run' });

shell(w => { wallet = w; paintGo(); });

/* the hero loop plays only while it is on screen, and never with reduced motion */
const vid = $('heroVid');
if (!still && vid) new IntersectionObserver(([e]) => e.isIntersecting ? vid.play().catch(() => {}) : vid.pause()).observe(vid);
else if (vid) vid.remove();

// ------------------------------------------------------------------ the floor
async function load() {
  floor = await api('/api/state').catch(() => null);
  if (!floor) return;
  const coins = floor.coins || [];
  const sum = f => coins.reduce((a, c) => a + BigInt(c.state ? c.state[f] : 0), 0n);
  const p = floor.price || 0;
  if (!floor.factory) {
    $('coins').innerHTML = '<div class="empty">The factory is not deployed yet. The floor opens with the first launch.</div>';
    $('burnRows').innerHTML = '<tr><td colspan="6" class="dim">No burns yet.</td></tr>';
    ['m-coins', 'm-fees', 'm-billed', 'm-ships', 'm-burn'].forEach(id => $(id).innerHTML = '0');
    return;
  }
  const t = floor.totals;
  $('m-coins').textContent = coins.length;
  $('m-fees').innerHTML = `${eth(sum('totalHarvested'))}<small>ETH</small>`;
  $('m-billed').innerHTML = `${eth(sum('totalBilled'))}<small>ETH</small>`;
  $('m-ships').textContent = coins.reduce((a, c) => a + (c.state ? Number(c.state.version) : 0), 0);
  $('m-burn').innerHTML = `${big(t.burnedBond)}<small>BOND</small>`;
  $('s-budget').innerHTML = `${eth(sum('budget'))} ETH<br><span class="dim">${usd(ethOf(sum('budget')) * p)} in budgets now</span>`;
  $('s-burn').innerHTML = `${eth(t.toBurn)} ETH<br><span class="dim">${big(t.burnedBond)} BOND burned</span>`;
  $('s-launch').innerHTML = `${eth(sum('totalToLauncher'))} ETH<br><span class="dim">to launchers</span>`;
  const r = floor.rules; $('rules').textContent = `first build at $${r.BUILD_AT_USD} of budget · new version at most every ${r.ITERATE_AFTER_H} h · burn at $${r.BURN_AT_USD}`;
  paintCoins();
  if (!sel) { const live = coins.find(c => c.live), shipped = [...coins].reverse().find(c => c.state && c.state.version > 0); pick((live || shipped || coins[coins.length - 1] || {}).vault); }
}
function status(c) {
  if (c.live) return '<span class="chip live">building</span>';
  if (c.state && c.state.version > 0) return `<span class="chip ship">v${c.state.version} live</span>`;
  return '<span class="chip">funding</span>';
}
function paintCoins() {
  const coins = [...(floor.coins || [])].reverse(), p = floor.price || 0, at = floor.rules.BUILD_AT_USD;
  if (!coins.length) { $('coins').innerHTML = '<div class="empty">No coins yet. The first launch opens the floor.</div>'; return; }
  $('coins').innerHTML = coins.map(c => {
    const b = c.state ? ethOf(c.state.budget) * p : 0, pct = c.state && c.state.version > 0 ? 100 : Math.min(100, b / at * 100);
    return `<button class="coin${sel === c.vault ? ' on' : ''}" data-v="${c.vault}">
      <div class="t"><span class="ph">${esc((c.symbol || '?')[0])}</span><div><strong>${esc(c.name)}</strong><div class="sym">$${esc(c.symbol)} · ${ago(c.launchedAt)}</div></div>${status(c)}</div>
      <p class="brief">${esc(c.state ? c.state.brief : '')}</p>
      <div class="gauge" title="budget toward the first build"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="nums"><span>budget ${usd(b)}</span><span>fees ${eth(c.state ? c.state.totalHarvested : 0)} ETH</span></div>
    </button>`;
  }).join('');
}
$('coins').onclick = e => { const b = e.target.closest('.coin'); if (b) pick(b.dataset.v); };

async function pick(vault) {
  if (!vault) return;
  sel = vault; paintCoins();
  const c = floor.coins.find(x => x.vault === vault);
  $('c-who').innerHTML = `${esc(c.name)} <span class="dim mono" style="font-weight:400">$${esc(c.symbol)}</span>`;
  const d = await api('/api/state?vault=' + vault).catch(() => null);
  const shipped = c.state && c.state.version > 0 && floor.appsBase ? `${floor.appsBase}/${c.slug}/` : null;
  $('c-foot').innerHTML = `<a href="/a/${vault}">Open the coin page</a>${shipped ? ` · <a href="${shipped}" target="_blank" rel="noopener">Open the app</a>` : ''} · vault ${link('address', vault, short(vault))}`;
  const need = floor.rules.BUILD_AT_USD, have = c.state ? ethOf(c.state.budget) * floor.price : 0;
  con.runs(vault, d && d.runs ? d.runs : [], `No run yet. The agent starts when the budget reaches ${usd(need)}; it holds ${usd(have)}. Trading fees fill it, or anyone can top it up on the coin page.`);
}

// ------------------------------------------------------------------ launch
let fee = null, logoUrl = '';
if (FACTORY) pub.readContract({ address: PONS, abi: PONS_ABI, functionName: 'launchFee' }).then(f => { fee = f; paintBill(); }).catch(() => {});
const buyWei = () => { const v = $('f-buy').value.trim(); if (!v) return 0n; try { return viem.parseEther(v); } catch { return null; } };
function paintBill() {
  const b = buyWei();
  $('b-fee').textContent = fee == null ? '—' : eth(fee) + ' ETH';
  $('b-buy').textContent = b == null ? 'not a number' : eth(b) + ' ETH';
  $('b-tot').textContent = fee == null || b == null ? '—' : eth(fee + STAKE + b) + ' ETH';
  paintGo();
}
function valid() {
  const n = $('f-name').value.trim(), s = $('f-sym').value.trim(), br = $('f-brief').value.trim();
  return n && s && /^[A-Za-z0-9]{1,10}$/.test(s) && new TextEncoder().encode(br).length >= 20 && buyWei() != null;
}
function paintGo() {
  const g = $('go');
  if (!FACTORY) { g.disabled = true; g.textContent = 'Opens when the factory is deployed'; return; }
  if (!wallet.address) { g.disabled = false; g.textContent = 'Connect a wallet to launch'; return; }
  g.disabled = !valid() || fee == null; g.textContent = valid() ? 'Launch on Pons' : 'Fill in the name, ticker and brief';
}
for (const [id, n, max] of [['f-name', 'n-name', 32], ['f-sym', 'n-sym', 10], ['f-brief', 'n-brief', 600]]) $(id).addEventListener('input', () => { $(n).textContent = `${new TextEncoder().encode($(id).value).length}/${max}`; paintGo(); });
$('f-buy').addEventListener('input', paintBill);
$('f-logo').onchange = async () => {
  const f = $('f-logo').files[0]; if (!f) return;
  $('pv').textContent = '…';
  try {
    const img = await createImageBitmap(f), cv = Object.assign(document.createElement('canvas'), { width: 256, height: 256 }), x = cv.getContext('2d');
    const s = Math.min(img.width, img.height); x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    const data = cv.toDataURL('image/webp', 0.86);
    const r = await api('/api/img', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
    if (r.error) throw Error(r.error);
    logoUrl = r.url; $('pv').innerHTML = `<img src="${data}" alt="">`;
  } catch (e) { $('pv').textContent = 'none'; $('l-st').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
};
$('go').onclick = async () => {
  const st = $('l-st');
  if (!wallet.address) return $('connect').click();
  try {
    const name = $('f-name').value.trim(), sym = $('f-sym').value.trim().toUpperCase(), brief = $('f-brief').value.trim(), b = buyWei();
    st.textContent = 'Confirm in your wallet…';
    const tx = await W.send(CHAIN, { address: FACTORY, abi: FA.abi, functionName: 'launch', args: [name, sym, logoUrl, brief, 1n], value: fee + STAKE + b });
    st.innerHTML = `Sent ${link('tx', tx.hash, short(tx.hash))}, waiting for the block…`;
    const rc = await tx.wait();
    if (rc.status !== 'success') throw Error('The launch reverted');
    const ev = rc.logs.map(l => { try { return viem.decodeEventLog({ abi: FA.abi, data: l.data, topics: l.topics }); } catch { return null; } }).find(x => x && x.eventName === 'Launched');
    st.innerHTML = `<span class="ok">Launched.</span> <a href="/a/${ev.args.vault}">Open ${esc(name)}'s page</a>`;
    floor = null; load();
  } catch (e) { st.innerHTML = `<span class="bad">${esc(e.shortMessage || e.message)}</span>`; }
};

// ------------------------------------------------------------------ burns
async function burns() {
  const d = await api('/api/state?burns=1').catch(() => null);
  if (!d || !d.factory) return;
  const rows = d.burns || [];
  $('burnRows').innerHTML = rows.length ? rows.map(b => `<tr><td>${ago(Math.floor(b.at / 1000))}</td><td>${eth(b.eth)}</td><td>${big(b.bond)}</td><td>${b.harvests.length}</td><td class="dim">${b.attestation.slice(0, 14)}…</td><td>${link('tx', b.tx, short(b.tx))}</td></tr>`).join('')
    : `<tr><td colspan="6" class="dim">No burns yet${d.pending.length ? `, ${d.pending.length} harvest${d.pending.length > 1 ? 's' : ''} waiting for the next one` : ''}.</td></tr>`;
}

await load(); burns(); paintBill();
setInterval(() => { if (!document.hidden) load(); }, 30000);
