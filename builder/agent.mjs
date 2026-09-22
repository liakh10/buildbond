/* The Buildbond agent. Runs one job handed out by /api/tick: builds or improves the coin's app in <pages>/<slug>/ with
   Gemini, checks it in headless Chrome, commits it to the gh-pages branch and reports the run to /api/log, which bills
   the vault for the model usage and records the shipped version on chain.

     node builder/agent.mjs <job.json> <pages dir>            run the job
     node builder/agent.mjs --abort <job.json> <pages dir>    report a crashed run as failed, with the usage so far

   env: GEMINI_API_KEY (or ~/.config/gemini/api_key), BUILD_SECRET, GEMINI_MODEL (default gemini-2.5-pro),
        DRY=1 prints the log instead of posting it and does not commit. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check } from './check.mjs';

const args = process.argv.slice(2), abort = args[0] === '--abort';
if (abort) args.shift();
const [jobFile, pagesArg] = args;
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const PAGES = path.resolve(pagesArg || 'pages');
const DIR = path.join(PAGES, job.slug);
const USAGE_FILE = path.join(os.tmpdir(), `bb-usage-${job.run}.json`);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const DRY = process.env.DRY === '1';
const KEY = process.env.GEMINI_API_KEY || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.config/gemini/api_key'), 'utf8').trim(); } catch { return ''; } })();
const PRICE = { in: 1.25, out: 10 };                 /* must match lib/server.js PRICING, which is what bills */
const MAX_STEPS = 45;

// ------------------------------------------------------------------ the log
let queue = [], flushing = null;
const log = (k, x) => { const line = { k, x: String(x) }; if (DRY) console.log(k.padEnd(6), String(x).slice(0, 600)); else queue.push(line); };
async function flush() {
  if (DRY || !queue.length) return;
  const lines = queue.splice(0, 50);
  await fetch(job.site + '/api/log', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.BUILD_SECRET }, body: JSON.stringify({ vault: job.vault, run: job.run, lines }) }).catch(() => {});
  if (queue.length) return flush();
}
const ticker = setInterval(() => { if (!flushing) flushing = flush().finally(() => { flushing = null; }); }, 1200);
async function report(done) {
  clearInterval(ticker); await flushing; await flush();
  if (DRY) return console.log('DONE', JSON.stringify(done));
  const r = await fetch(job.site + '/api/log', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.BUILD_SECRET }, body: JSON.stringify({ vault: job.vault, run: job.run, done }) }).then(r => r.json()).catch(e => ({ error: e.message }));
  console.log('report', JSON.stringify(r));
}

// ------------------------------------------------------------------ usage
const usage = fs.existsSync(USAGE_FILE) ? JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) : { inTokens: 0, outTokens: 0, maxPrompt: 0 };
const usd = () => (usage.inTokens * PRICE.in + usage.outTokens * PRICE.out) / 1e6;
const saveUsage = () => fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));

if (abort) {
  log('FAIL', 'the build machine stopped before the run finished');
  await report({ ok: false, ...usage, summary: 'run aborted' });
  process.exit(0);
}

// ------------------------------------------------------------------ the app folder
const ALLOWED = /^[a-z0-9][a-z0-9._/-]{0,80}\.(html|css|js|json|svg|md|txt)$/i;
const inside = p => {
  const clean = String(p || '').replace(/^\.?\/+/, '');
  if (!ALLOWED.test(clean) || clean.includes('..') || clean.split('/').some(s => s.startsWith('_'))) throw Error(`not allowed: "${p}". Use a relative path like index.html, app.js, style.css or assets/logo.svg`);
  return path.join(DIR, clean);
};
const files = () => {
  if (!fs.existsSync(DIR)) return [];
  const out = [];
  const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else out.push({ path: path.relative(DIR, p), bytes: fs.statSync(p).size }); } };
  walk(DIR); return out.filter(f => !f.path.startsWith('_'));
};
const totalBytes = () => files().reduce((a, f) => a + f.bytes, 0);

const SDK = `<script src="${job.site}/sdk.js" data-vault="${job.vault}" data-coin="${job.coin}" data-symbol="${job.symbol}"></script>`;
const existing = files();

const SYSTEM = `You are the Buildbond agent. A memecoin on Robinhood Chain funds you with its trading fees, and your job is to build the app its launcher described, then keep improving it. You work alone, with tools, on a static folder that is published as-is to GitHub Pages.

The coin: ${job.name} ($${job.symbol}), contract ${job.coin}. The launcher's brief:
"""${job.brief}"""

This run is version ${job.version}.${existing.length ? ' The folder already holds the previous version: read it first, keep what works, fix what is weak, and add one meaningful improvement. Record what changed in CHANGELOG.md.' : ' The folder is empty: build version 1 from the brief.'}

Hard rules:
- Static files only: index.html plus your own .css, .js, .svg, .json, .md. No build step, no npm, no frameworks that need compiling. Plain modern JavaScript. Libraries only from https://cdn.jsdelivr.net or https://cdnjs.cloudflare.com if truly needed.
- index.html must include this exact tag before your own scripts: ${SDK}
  It gives window.Bond: Bond.connect() (wallet, switches to Robinhood Chain), Bond.address, Bond.balance(addr?) (BigInt, 18 decimals), Bond.isHolder(addr?), Bond.list(key, limit?) (a shared public list, newest first: [{by, at, holder, value}]), Bond.push(key, value, {holders}) (adds to it, the wallet signs; keys match ^[a-z0-9_-]{1,32}$, values up to 2 KB, one write per 3 s per wallet), Bond.buyUrl, Bond.on('account', fn).
  Use Bond.list / Bond.push whenever the app needs data shared between people. Use localStorage only for one person's own settings.
- The app is free to use. Holding the coin may unlock extra features you design (check with Bond.isHolder after the user connects), with a clear "Buy $${job.symbol}" link to Bond.buyUrl for people who do not hold it.
- Never invent numbers, users, reviews, prices or activity. If there is no data yet, show an honest empty state. No lorem ipsum, no placeholder text.
- No API keys, no calls to services that need keys, no tracking, no ads. Public keyless APIs are allowed if the app needs them; handle their failure gracefully.
- It must work and look good on a 375px phone and on desktop, with no horizontal scrolling. Give it a real visual identity that fits the brief: a considered palette, type from Google Fonts, spacing, states for loading, empty and error. Accessible labels on controls.
- Keep the whole folder under 400 KB. Write complete files; write_file replaces the whole file.

How to work: plan briefly, write the files, then call check. check opens the app in Chrome on desktop and phone and reports errors; fix every problem it reports and check again. When check passes and the app does what the brief asks, call finish with a short plain summary of what the app does and what changed. Be efficient: every step costs the coin's budget.`;

const TOOLS = [{ functionDeclarations: [
  { name: 'list_files', description: 'List the files in the app folder with their sizes.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'read_file', description: 'Read one file of the app.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or replace one file of the app with the full content.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['path', 'content'] } },
  { name: 'delete_file', description: 'Delete one file of the app.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } },
  { name: 'check', description: 'Open the app in headless Chrome at 1280x800 and 375x812 and report errors, overflow and emptiness. Must pass before finish.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'finish', description: 'End the run. Only after check passes.', parameters: { type: 'OBJECT', properties: { summary: { type: 'STRING' } }, required: ['summary'] } }
] }];

/* GEMINI_MOCK=1 replaces the model with a fixed script, to test the log, the check, the commit, the bill and the ship
   without a key. It never runs in the workflow. */
let mockStep = 0;
function mock() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${job.name}</title><link rel="stylesheet" href="style.css"></head><body><main><h1>${job.name}</h1><p>Mock build of the brief, used only to test the pipeline end to end.</p><button id="c">Connect wallet</button><ul id="list"><li>No entries yet</li></ul></main>${SDK}<script src="app.js"></script></body></html>`;
  const steps = [
    [{ text: 'Mock plan: one page, a connect button and the shared list.' }, { functionCall: { name: 'list_files', args: {} } }],
    [{ functionCall: { name: 'write_file', args: { path: 'index.html', content: html } } }, { functionCall: { name: 'write_file', args: { path: 'style.css', content: 'body{font:16px system-ui;margin:0;padding:24px;background:#111;color:#eee}main{max-width:640px;margin:auto}button{padding:10px 14px}' } } }, { functionCall: { name: 'write_file', args: { path: 'app.js', content: "document.getElementById('c').onclick = () => Bond.connect().catch(e => alert(e.message));" } } }],
    [{ functionCall: { name: 'check', args: {} } }],
    [{ functionCall: { name: 'finish', args: { summary: 'Mock v' + job.version + ': a page with a wallet button and an empty shared list.' } } }]
  ];
  const parts = steps[Math.min(mockStep++, steps.length - 1)];
  return { candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 9000 + 3000 * mockStep, candidatesTokenCount: 1500, thoughtsTokenCount: 500 } };
}

async function gemini(contents) {
  if (process.env.GEMINI_MOCK === '1') return mock();
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: TOOLS, generationConfig: { temperature: 0.5, maxOutputTokens: 32000, thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } } })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.candidates) return j;
    const msg = (j.error && j.error.message) || r.status;
    if (r.status === 429 || r.status >= 500) { log('INFO', `model busy (${msg}), retrying`); await new Promise(s => setTimeout(s, 4000 * (i + 1))); continue; }
    throw Error('model error: ' + msg);
  }
  throw Error('model unavailable after 4 tries');
}

let lastCheck = null;
async function tool(name, a) {
  switch (name) {
    case 'list_files': { const f = files(); log('READ', `list files: ${f.length ? f.map(x => x.path).join(', ') : 'empty'}`); return { files: f }; }
    case 'read_file': { const p = inside(a.path); log('READ', `read ${a.path}`); if (!fs.existsSync(p)) return { error: 'no such file' }; return { content: fs.readFileSync(p, 'utf8') }; }
    case 'write_file': {
      const p = inside(a.path), c = String(a.content ?? '');
      if (totalBytes() - (fs.existsSync(p) ? fs.statSync(p).size : 0) + Buffer.byteLength(c) > 400 * 1024) return { error: 'the folder would pass 400 KB' };
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c);
      log('WRITE', `write ${a.path} · ${c.split('\n').length} lines, ${(Buffer.byteLength(c) / 1024).toFixed(1)} KB`);
      return { ok: true };
    }
    case 'delete_file': { const p = inside(a.path); if (fs.existsSync(p)) fs.unlinkSync(p); log('WRITE', `delete ${a.path}`); return { ok: true }; }
    case 'check': {
      const html = fs.existsSync(path.join(DIR, 'index.html')) ? fs.readFileSync(path.join(DIR, 'index.html'), 'utf8') : '';
      if (html && !html.includes(`data-vault="${job.vault}"`)) { log('CHECK', 'FAIL · index.html is missing the Buildbond SDK tag'); return { report: 'FAIL\n✗ index.html must include exactly: ' + SDK }; }
      lastCheck = await check(DIR);
      log('CHECK', lastCheck.report.split('\n').slice(0, 8).join(' · '));
      return { report: lastCheck.report };
    }
    default: return { error: 'unknown tool' };
  }
}

// ------------------------------------------------------------------ the run
let ok = false, summary = '', nudges = 0;
try {
  if (!KEY && process.env.GEMINI_MOCK !== '1') throw Error('GEMINI_API_KEY is not set');
  fs.mkdirSync(DIR, { recursive: true });
  log('INFO', `agent ${MODEL} · ${existing.length ? (job.version > 1 ? `improving v${job.version - 1} (${existing.length} files)` : `retrying v1 over ${existing.length} files from an unshipped run`) : 'empty folder, building v1'} · run budget $${job.maxUsd.toFixed(2)}`);
  const contents = [{ role: 'user', parts: [{ text: existing.length ? `Start version ${job.version}. The current files: ${existing.map(f => f.path).join(', ')}.` : 'Start version 1.' }] }];
  for (let step = 0; step < MAX_STEPS && !ok; step++) {
    if (usd() >= job.maxUsd) { log('INFO', `run budget reached at $${usd().toFixed(3)}, stopping`); break; }
    const res = await gemini(contents);
    const u = res.usageMetadata || {};
    usage.inTokens += u.promptTokenCount || 0; usage.outTokens += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
    usage.maxPrompt = Math.max(usage.maxPrompt, u.promptTokenCount || 0); saveUsage();
    const content = res.candidates[0].content || { role: 'model', parts: [] };
    contents.push(content);
    const parts = content.parts || [];
    for (const p of parts) if (p.text && p.text.trim()) log('THINK', p.text.trim().slice(0, 1500));
    log('INFO', `usage $${usd().toFixed(3)} of $${job.maxUsd.toFixed(2)}`);
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) {
      if (++nudges > 2) { log('INFO', 'the model stopped calling tools'); break; }
      contents.push({ role: 'user', parts: [{ text: 'Continue with a tool call. Call check, then finish when it passes.' }] });
      continue;
    }
    const answers = [];
    for (const { functionCall: fc } of calls) {
      let out;
      if (fc.name === 'finish') {
        if (!lastCheck || !lastCheck.ok) { await tool('check', {}); }
        if (lastCheck && lastCheck.ok) { ok = true; summary = String(fc.args && fc.args.summary || ''); out = { ok: true }; }
        else out = { error: 'check does not pass yet:\n' + (lastCheck ? lastCheck.report : 'no check') };
      } else {
        try { out = await tool(fc.name, fc.args || {}); } catch (e) { out = { error: e.message }; log('FAIL', `${fc.name}: ${e.message}`); }
        if (fc.name === 'write_file' || fc.name === 'delete_file') lastCheck = null;
      }
      answers.push({ functionResponse: { name: fc.name, response: out } });
    }
    contents.push({ role: 'user', parts: answers });
  }
} catch (e) { log('FAIL', e.message); }

// ------------------------------------------------------------------ publish
let commit = null;
if (ok) {
  const cl = path.join(DIR, 'CHANGELOG.md');
  if (!fs.existsSync(cl)) fs.writeFileSync(cl, `# ${job.name}\n`);
  fs.appendFileSync(cl, `\n## v${job.version}\n\n${summary}\n`);
  if (!DRY) {
    try {
      const git = (...a) => execFileSync('git', ['-C', PAGES, ...a], { encoding: 'utf8' }).trim();
      git('config', 'user.name', 'buildbond-agent'); git('config', 'user.email', 'agent@buildbond.invalid');
      if (!fs.existsSync(path.join(PAGES, '.nojekyll'))) fs.writeFileSync(path.join(PAGES, '.nojekyll'), '');
      git('add', '-A');
      git('commit', '-m', `${job.symbol} v${job.version} · run ${job.run}`);
      git('push', 'origin', 'HEAD:gh-pages');
      commit = git('rev-parse', 'HEAD');
      log('SHIP', `committed ${commit.slice(0, 7)} to gh-pages`);
    } catch (e) { ok = false; log('FAIL', 'publish: ' + String(e.message).slice(0, 300)); }
  } else commit = '0'.repeat(40);
}
log('INFO', `run ends · ${ok ? 'passed' : 'not shipped'} · ${usage.inTokens} in, ${usage.outTokens} out tokens · $${usd().toFixed(4)}`);
await report({ ok, ...usage, commit, summary });
fs.rmSync(USAGE_FILE, { force: true });
