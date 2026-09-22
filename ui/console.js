/* The agent's log, streamed: one run at a time, polled every two seconds while the run is live. */
import { $, esc, clock, api } from '/ui/shell.js';

export function makeConsole({ lines, select }) {
  let vault = null, run = null, from = 0, poll = null;
  const stop = () => { if (poll) clearTimeout(poll); poll = null; };
  async function more(first) {
    const d = await api(`/api/log?vault=${vault}&run=${run}&from=${from}`).catch(() => null);
    if (!d || d.run !== run) return;
    const box = $(lines), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.insertAdjacentHTML('beforeend', d.lines.map(l => `<div class="ln ${l.k}${first ? '' : ' new'}"><span class="ts">${clock(l.t)}</span><span class="k">${l.k}</span><span class="x">${esc(l.x)}</span></div>`).join(''));
    from += d.lines.length;
    if (first || atEnd) box.scrollTop = box.scrollHeight;
    if (d.live === run) poll = setTimeout(() => more(false), 2000);
  }
  async function open(v, r) { stop(); vault = v; run = r; from = 0; $(lines).innerHTML = ''; await more(true); }
  function runs(v, list, idle) {
    stop(); vault = v;
    $(select).innerHTML = list.length ? list.map(r => `<option value="${r.run}">v${r.version} · ${r.status}</option>`).join('') : '<option>no runs yet</option>';
    $(select).disabled = !list.length;
    $(select).onchange = () => open(vault, $(select).value);
    if (!list.length) { $(lines).innerHTML = `<div class="idle">${idle}</div>`; return; }
    open(v, list[0].run);
  }
  return { runs, open, stop };
}
