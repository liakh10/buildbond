/* The check the agent runs on its own work, and the gate a version must pass to ship: the app is served from its folder
   and opened in headless Chrome at 1280x800 and at 375x812. It fails on any uncaught error, console error, broken
   same-origin request, an almost empty page, or a page wider than a phone. A desktop screenshot becomes the cover. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.md': 'text/plain' };
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));

function serve(dir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

export async function check(dir, { cover = true } = {}) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) return { ok: false, report: 'index.html is missing' };
  const server = await serve(dir), port = server.address().port, url = `http://127.0.0.1:${port}/`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const problems = [], notes = [];
  try {
    for (const [name, w, h] of [['desktop', 1280, 800], ['phone', 375, 812]]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: name === 'phone', hasTouch: name === 'phone' });
      page.on('pageerror', e => problems.push(`${name}: uncaught ${String(e.message || e).slice(0, 300)}`));
      page.on('console', m => { if (m.type() === 'error' && !/favicon|^Failed to load resource/.test(m.text())) problems.push(`${name}: console error ${m.text().slice(0, 300)}`); });
      page.on('response', r => { if (r.url().startsWith(url) && r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`${name}: ${r.status()} ${r.url().slice(url.length - 1)}`); });
      page.on('requestfailed', r => { if (!/favicon/.test(r.url())) notes.push(`${name}: request failed ${r.url().slice(0, 160)} ${r.failure() ? r.failure().errorText : ''}`); });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(e => problems.push(`${name}: did not load in 20 s (${e.message.slice(0, 120)})`));
      await new Promise(r => setTimeout(r, 900));
      const m = await page.evaluate(W => ({
        text: document.body ? document.body.innerText.trim().length : 0,
        nodes: document.querySelectorAll('body *').length,
        wide: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) - W,
        title: document.title,
        buttons: document.querySelectorAll('button, a[href], input, select, textarea').length
      }), w).catch(() => ({ text: 0, nodes: 0, wide: 0, title: '', buttons: 0 }));
      if (m.text < 40) problems.push(`${name}: the page shows almost no text (${m.text} characters)`);
      if (m.wide > 1) problems.push(`${name}: the page is ${m.wide}px wider than the screen, it scrolls sideways`);
      if (name === 'desktop') notes.push(`title "${m.title}", ${m.nodes} elements, ${m.buttons} interactive, ${m.text} characters of text`);
      if (name === 'desktop' && cover) await page.screenshot({ path: path.join(dir, '_cover.jpg'), type: 'jpeg', quality: 72 });
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
  const ok = problems.length === 0;
  return { ok, problems, notes, report: (ok ? 'PASS' : 'FAIL') + '\n' + [...problems.map(p => '✗ ' + p), ...notes.map(n => '· ' + n)].join('\n') };
}

if (process.argv[1] && process.argv[1].endsWith('check.mjs') && process.argv[2]) {
  const r = await check(path.resolve(process.argv[2]));
  console.log(r.report);
  process.exit(r.ok ? 0 : 1);
}
