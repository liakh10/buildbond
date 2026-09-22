/* One coin: the shipped app in a frame, the vault's numbers and buttons, the agent's log, and the vault's history on chain
   with every bill's receipt checked in the browser against the hash the bill carries. */
import { viem, W, CHAIN, $, esc, isAddr, link, short, eth, ethOf, usd, ago, api, shell } from '/ui/shell.js';
import { makeConsole } from '/ui/console.js';

const VA = await fetch('/lib/abi/BondVault.json?v=1').then(r => r.json());
const vault = location.pathname.split('/').pop();
const con = makeConsole({ lines: 'c-lines', select: 'c-run' });
let d = null, wallet = {};
shell(w => { wallet = w; paintActs(); });

async function load() {
  if (!isAddr(vault)) { $('name').textContent = 'Not a vault address'; return; }
  d = await api('/api/state?vault=' + vault).catch(() => null);
  if (!d || d.error || !d.coin) { $('name').textContent = d && d.error ? d.error : 'Could not read this vault'; $('pbody').innerHTML = '<div class="none">Nothing to show.</div>'; return; }
  const c = d.coin, s = c.state, p = d.price;
  document.title = `${c.name} · Buildbond`;
  $('name').textContent = c.name;
  const status = c.live ? '<span class="chip live">building</span>' : s.version > 0 ? `<span class="chip ship">v${s.version} live</span>` : '<span class="chip">funding</span>';
  $('meta').innerHTML = `<span class="chip">$${esc(c.symbol)}</span>${status}<span class="dim mono" style="font-size:12px">launched ${ago(c.launchedAt)} by ${link('address', c.launcher, short(c.launcher))}</span>`;
  const app = s.version > 0 && d.appsBase ? `${d.appsBase}/${c.slug}/` : null;
  $('links').innerHTML = `${app ? `<a class="btn sm acc" href="${app}" target="_blank" rel="noopener">Open the app</a>` : ''}<a class="btn sm" href="https://www.ponsfamily.com/launchpad/${c.coin}" target="_blank" rel="noopener"><img src="/assets/pons.png" alt="" style="filter:invert(1)">Trade $${esc(c.symbol)}</a><a class="btn sm" href="https://dexscreener.com/robinhood/${c.coin}" target="_blank" rel="noopener">Chart</a>`;
  $('brief').textContent = s.brief; $('brief').hidden = false;
  if (app) {
    $('purl').textContent = app; $('popen').href = app; $('popen').hidden = false;
    if (!$('pbody').querySelector('iframe')) $('pbody').innerHTML = `<iframe src="${app}" title="${esc(c.name)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`;
  } else {
    const need = d.rules.BUILD_AT_USD, have = ethOf(s.budget) * p;
    $('pbody').innerHTML = `<div class="none"><div><span class="cap">budget toward the first build</span><b>${usd(have)} <span class="dim" style="font-size:22px">of ${usd(need)}</span></b><div class="gauge" style="width:260px;margin:0 auto"><i style="width:${Math.min(100, have / need * 100).toFixed(1)}%"></i></div><p style="margin-top:14px;max-width:360px">${c.live ? 'The agent is building v1 right now. Its log is below.' : 'The agent starts when the budget reaches the threshold. Trading fees fill it; a top-up counts the same.'}</p></div></div>`;
  }
  const stake = s.stakeSettled ? 'returned' : `${eth(s.stake)} ETH, held until v1`;
  $('stats').innerHTML = [
    ['Budget', `${eth(s.budget)} ETH · ${usd(ethOf(s.budget) * p)}`],
    ['Waiting in the Pons escrow', `${eth(s.waiting)} ETH`],
    ['Fees harvested', `${eth(s.totalHarvested)} ETH`],
    ['Top-ups', `${eth(s.totalToppedUp)} ETH`],
    ['Billed for agent usage', `${eth(s.totalBilled)} ETH`],
    ['Sent to the $BOND burn', `${eth(s.totalToBurn)} ETH`],
    ['Launcher share', `${eth(s.totalToLauncher)} ETH · ${eth(s.launcherOwed)} unclaimed`],
    ['Launch stake', stake],
    ['Versions shipped', String(s.version)]
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><span>${v}</span></div>`).join('');
  paintActs();
  con.runs(vault, d.runs || [], 'No run yet.');
  history();
}

function history() {
  const rows = [...d.history].reverse();
  const fmt = h => {
    const a = h.args;
    switch (h.event) {
      case 'Harvested': return ['Fees harvested', `${eth(a.eth)} ETH`, `budget ${eth(a.toBudget)} · burn ${eth(a.toBurn)} · launcher ${eth(a.toLauncher)}`];
      case 'Billed': return ['Agent usage billed', `${eth(a.amount)} ETH`, `<a href="#" data-r="${a.receipt.slice(2)}">receipt ${a.receipt.slice(2, 14)}…</a>`];
      case 'Shipped': return [`Version ${a.version} shipped`, '', `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\//, ''))}</a> · commit ${a.commit.slice(2, 9)}`];
      case 'ToppedUp': return ['Top-up', `${eth(a.amount)} ETH`, a.from === vault ? 'stake refused by the launcher, added to the budget' : 'from ' + short(a.from)];
      case 'StakeReturned': return ['Stake returned', `${eth(a.amount)} ETH`, a.shipped ? 'v1 shipped' : '30 days without a ship'];
      case 'ShareClaimed': return ['Launcher share paid', `${eth(a.amount)} ETH`, 'to ' + short(a.to)];
      default: return [h.event, '', ''];
    }
  };
  $('hist').innerHTML = rows.length ? rows.map(h => { const [e, amt, det] = fmt(h); return `<tr><td>${h.at ? ago(h.at) : '—'}</td><td>${e}</td><td>${amt}</td><td class="dim">${det}</td><td>${link('tx', h.tx, short(h.tx))}</td></tr>`; }).join('') : '<tr><td colspan="5" class="dim">Nothing on chain yet besides the launch.</td></tr>';
}

/* A receipt is checked here, not trusted: its sha256 must equal the hash the bill carries on chain. */
$('hist').onclick = async e => {
  const a = e.target.closest('[data-r]'); if (!a) return;
  e.preventDefault();
  const r = await api('/api/log?receipt=' + a.dataset.r).catch(() => null);
  if (!r || r.error) { $('rc-v').innerHTML = '<span class="bad">Receipt not found</span>'; $('rc-j').textContent = ''; $('rc').classList.add('on'); return; }
  const text = JSON.stringify(r.receipt);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
  $('rc-v').innerHTML = hash === a.dataset.r ? `<span class="ok">sha256 of this receipt matches the hash in the bill on chain.</span> ${r.receipt.inTokens.toLocaleString()} input and ${r.receipt.outTokens.toLocaleString()} output tokens of ${esc(r.receipt.model)}, $${r.receipt.usd} at $${r.receipt.pricing.inPerM} / $${r.receipt.pricing.outPerM} per million, ETH at $${r.receipt.ethUsd}.` : '<span class="bad">This receipt does not match the hash on chain.</span>';
  $('rc-j').textContent = JSON.stringify(r.receipt, null, 2);
  $('rc').classList.add('on');
};
$('rc-x').onclick = () => $('rc').classList.remove('on');
$('rc').onclick = e => { if (e.target === $('rc')) $('rc').classList.remove('on'); };

// ------------------------------------------------------------------ the buttons
function paintActs() {
  if (!d || !d.coin) return;
  const s = d.coin.state, mine = wallet.address && wallet.address.toLowerCase() === s.launcher.toLowerCase();
  $('claim').hidden = !(mine && BigInt(s.launcherOwed) > 0n);
}
async function act(label, fn) {
  const st = $('ast');
  if (!wallet.address) return $('connect').click();
  try {
    st.textContent = 'Confirm in your wallet…';
    const tx = await fn();
    st.innerHTML = `${label}: sent ${link('tx', tx.hash, short(tx.hash))}…`;
    const rc = await tx.wait();
    if (rc.status !== 'success') throw Error('reverted');
    st.innerHTML = `<span class="ok">${label}: done.</span> ${link('tx', tx.hash, short(tx.hash))}`;
    setTimeout(load, 1500);
  } catch (e) { st.innerHTML = `<span class="bad">${esc(e.shortMessage || e.message)}</span>`; }
}
$('harvest').onclick = () => act('Harvest', () => W.send(CHAIN, { address: vault, abi: VA.abi, functionName: 'harvest' }));
$('claim').onclick = () => act('Claim', () => W.send(CHAIN, { address: vault, abi: VA.abi, functionName: 'claimShare' }));
$('topup').onclick = () => {
  let v; try { v = viem.parseEther($('topv').value.trim() || '0'); } catch { v = 0n; }
  if (v <= 0n) { $('ast').innerHTML = '<span class="bad">Enter an amount of ETH</span>'; return; }
  act('Top-up', () => W.sendTx(CHAIN, { to: vault, value: v }));
};

await load();
setInterval(() => { if (!document.hidden) load(); }, 30000);
