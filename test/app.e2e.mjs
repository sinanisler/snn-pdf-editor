// End-to-end check of the built desktop app: opens a PDF, retypes one line, erases a table cell,
// saves, then reads the saved file back to confirm the old text is really gone.
// Needs `npm run build` first. Run with: node test/app.e2e.mjs
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const PDFLib = require('pdf-lib');
const { probePage } = require('../src/redact.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'src-tauri', 'target', 'release', 'snn-pdf-editor.exe');
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };

async function items(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise, pg = await doc.getPage(1), tc = await pg.getTextContent();
  await pg.getOperatorList();
  const fontOf = i => { try { return pg.commonObjs.get(i.fontName).name; } catch { return ''; } };
  return { height: pg.view[3], width: pg.view[2], items: tc.items.filter(i => i.str.trim()).map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.hypot(i.transform[2], i.transform[3]), font: fontOf(i) })) };
}

const dir = mkdtempSync(join(tmpdir(), 'snn-e2e-')), html = join(dir, 'in.html'), input = join(dir, 'sözleşme.pdf'), output = join(dir, 'çıktı.pdf');
writeFileSync(html, `<meta charset="utf-8"><body style="font:16px Georgia,serif;margin:40px"><h1>Sözleşme</h1>
<p>Bu belge <b>Ayşe Yılmaz</b> ile <i>SNN Yazılım</i> arasında düzenlenmiştir.</p>
<p style="font-family:Arial">IBAN: TR12 3456 7890 1234 5678 9012 34</p><p style="color:#1a5fb4">Toplam tutar: 12.500 TL (KDV dahil).</p>
<p style="font-family:'Segoe UI Light'">Hafif metin</p>
<table border=1 cellpadding=6><tr><td>Kalem</td><td>Fiyat</td></tr><tr><td>Danışmanlık</td><td>9.000</td></tr></table></body>`);
execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${input}`, pathToFileURL(html).href], { stdio: 'ignore', timeout: 60000 });
for (let i = 0; i < 100 && !existsSync(input); i++) await sleep(200);
await sleep(500);
const before = await items(new Uint8Array(readFileSync(input)));

const app = spawn(exe, [input], { env: { ...process.env, SNN_DEBUG_PORT: '9333' }, stdio: 'ignore' });
try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { await sleep(500); browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null }).catch(() => null); }
  if (!browser) throw new Error('the app did not start');
  const page = (await browser.pages()).find(p => /tauri/.test(p.url())) || (await browser.pages())[0];
  await page.waitForSelector('.thumb canvas', { timeout: 30000 }); await sleep(1500);

  console.log('desktop app');
  ok(await page.evaluate(() => document.getElementById('saveLbl').textContent === 'Save' && !document.getElementById('bSaveAs').hidden), 'runs in desktop mode with Save / Save as');
  ok((await page.evaluate(() => document.getElementById('fname').textContent)) === 'sözleşme.pdf', 'opened the file passed on the command line');

  // where a PDF point lands on screen
  const geo = await page.evaluate(() => { const r = document.querySelector('.page').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width }; });
  const z = geo.w / before.width, at = (x, y) => [geo.left + x * z, geo.top + (before.height - y) * z];
  const iban = before.items.find(i => i.str.includes('IBAN')), cell = before.items.find(i => i.str.includes('9.000'));

  // 1. click the IBAN line and retype it
  await page.mouse.click(...at(iban.x + 10, iban.y + iban.h * 0.3));
  await page.waitForSelector('.page textarea', { timeout: 5000 });
  const old = await page.evaluate(() => document.querySelector('.page textarea').value);
  ok(/IBAN: TR12 3456 7890 1234 5678 9012 34/.test(old), `clicking a line opens it for editing ("${old}")`);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('IBAN: gizlendi (şğıİöç)');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(300);

  // 1b. retype the blue Georgia line: the new text must keep its font, size and colour
  const total = before.items.find(i => i.str.includes('Toplam'));
  await page.keyboard.press('Escape');
  await page.mouse.click(...at(total.x + 10, total.y + total.h * 0.3));
  await page.waitForSelector('.page textarea', { timeout: 5000 });
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('Toplam tutar: 99 TL');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(300);

  // 1c. a Light weight: the status bar names the font, and the retyped text keeps that weight
  const light = before.items.find(i => i.str.includes('Hafif'));
  await page.keyboard.press('Escape');
  await page.mouse.click(...at(light.x + 10, light.y + light.h * 0.3));
  await page.waitForSelector('.page textarea', { timeout: 5000 });
  const info = await page.evaluate(() => document.getElementById('finfo').textContent);
  ok(/Light \(300\)/.test(info) && /installed as "Segoe UI Light"/.test(info), `status bar describes the clicked text ("${info}")`);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('Hafif yeni');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(300);

  // 2. erase the price cell with the whiteout tool
  await page.keyboard.press('Escape'); await page.keyboard.press('w');
  const [x0, y0] = at(cell.x - 3, cell.y + cell.h), [x1, y1] = at(cell.x + cell.w + 3, cell.y - cell.h * 0.3);
  await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2); await page.mouse.move(x1, y1); await page.mouse.up();
  await sleep(300);
  ok((await page.title()).startsWith('•'), 'title shows unsaved changes');
  await page.screenshot({ path: join(dir, 'edited.png') });

  // 3. save (the native "Save as" dialog can't be clicked from here, so answer it directly)
  await page.evaluate(p => { window.__TAURI__.dialog.save = async () => p; }, output);
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  for (let i = 0; i < 100 && !existsSync(output); i++) await sleep(200);
  await sleep(800);
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  ok(existsSync(output) && /deleted from the file/.test(toast), `saved to disk ("${toast}")`);
  ok(!(await page.title()).startsWith('•'), 'title is clean again after saving');

  const after = await items(new Uint8Array(readFileSync(output))), all = after.items.map(i => i.str).join(' ');
  console.log('saved file');
  ok(!/TR12|3456|7890|9012/.test(all), 'old IBAN cannot be found any more');
  ok(all.includes('IBAN: gizlendi (şğıİöç)'), 'new text is real, searchable text including Turkish letters');
  ok(!all.includes('9.000') && all.includes('Danışmanlık'), 'erased cell is gone, its neighbour stays');
  const nt = after.items.find(i => i.str.includes('99 TL'));
  ok(nt && !all.includes('12.500'), 'retyped line replaced the old one');
  ok(nt && /Georgia/i.test(nt.font) && /Georgia/i.test(total.font), `retyped line keeps its font (${total.font} -> ${nt && nt.font})`);
  ok(nt && Math.abs(nt.h - total.h) < 0.01 && Math.abs(nt.y - total.y) < 0.05 && Math.abs(nt.x - total.x) < 0.5, `retyped line keeps its exact size and position (${total.h} -> ${nt && nt.h})`);
  const nl = after.items.find(i => i.str.includes('Hafif yeni'));
  ok(nl && /Light/i.test(nl.font) && Math.abs(nl.h - light.h) < 0.01, `Light text stays Light (${light.font} -> ${nl && nl.font})`);
  const lib = await PDFLib.PDFDocument.load(readFileSync(output));
  const col = nt && probePage(PDFLib, lib.getPage(0), [[nt.x, nt.y - 2, nt.x + nt.w, nt.y + nt.h]])[0];
  ok(col === '#1a5fb4', `retyped line keeps its exact colour (${col})`);
  const keep = before.items.filter(b => Math.abs(b.y - iban.y) > 2 && Math.abs(b.y - cell.y) > 2 && Math.abs(b.y - total.y) > 2 && Math.abs(b.y - light.y) > 2);
  ok(keep.every(b => after.items.some(a => a.str === b.str && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01)), 'every other line is untouched');
  console.log('\nfiles in ' + dir);
  await browser.disconnect();
} catch (e) { ok(false, e.message); }
finally { app.kill(); }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
