// Checks that redact.js really deletes text: every case saves a PDF the way the app does,
// then reads it back with pdf.js (the same engine Chrome's viewer uses) and looks for the old words.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const PDFLib = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { redactPage } = require('../src/redact.js');
const { PDFDocument, StandardFonts, PDFName } = PDFLib;

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };

async function items(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise, pg = await doc.getPage(1);
  const tc = await pg.getTextContent();
  return tc.items.filter(i => i.str.trim()).map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.hypot(i.transform[2], i.transform[3]) }));
}
const text = its => its.map(i => i.str).join(' ');
// same box the editor uses for a line: a little below the baseline up to the cap height
const box = (it, x0 = it.x, x1 = it.x + it.w) => [x0 - 0.5, it.y - it.h * 0.22, x1 + 0.5, it.y + it.h * 0.8];
// save through the same path as the app: copy the page into a fresh document, then redact
async function redact(bytes, rects) {
  const src = await PDFDocument.load(bytes), out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [0]); out.addPage(pg);
  const stats = redactPage(PDFLib, pg, rects);
  return { bytes: await out.save(), stats };
}
async function rawContent(bytes) {
  const d = await PDFDocument.load(bytes), c = d.getPage(0).node.Contents();
  const list = c instanceof PDFLib.PDFArray ? Array.from({ length: c.size() }, (_, i) => c.lookup(i)) : [c];
  return list.map(s => Buffer.from(PDFLib.decodePDFRawStream(s).decode()).toString('latin1')).join('\n');
}
const untouched = (before, after, rects) => before.filter(b => !rects.some(r => b.y >= r[1] - 1 && b.y <= r[3] + 1))
  .every(b => after.some(a => a.str === b.str && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01));

// ---------- 1. built-in fonts ----------
console.log('built-in font (Helvetica)');
{
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), p = d.addPage([595, 842]);
  p.drawText('Invoice for Acme Ltd', { x: 50, y: 760, size: 18, font: f });
  p.drawText('Account holder: John Carpenter', { x: 50, y: 720, size: 12, font: f });
  p.drawText('Total due: 4500 USD by Friday', { x: 50, y: 700, size: 12, font: f });
  const src = await d.save(), before = await items(src);
  const line = before.find(i => i.str.includes('John Carpenter')), tot = before.find(i => i.str.includes('4500'));
  const w = s => [...s].reduce((n, ch) => n + f.widthOfTextAtSize(ch, 12), 0);
  const word = box(tot, tot.x + w('Total due: '), tot.x + w('Total due: 4500'));
  const rects = [box(line), word], { bytes, stats } = await redact(src, rects), after = await items(bytes);
  ok(!text(after).includes('Carpenter') && !text(after).includes('Account'), 'whole line is gone');
  ok(!text(after).includes('4500'), 'single word is gone');
  ok(/Total due:/.test(text(after)) && /USD by Friday/.test(text(after)), 'rest of that line survives');
  const rest = after.filter(i => Math.abs(i.y - 700) < 1), end = Math.max(...rest.map(i => i.x + i.w));
  ok(Math.abs(end - (tot.x + tot.w)) < 0.5, 'words after the gap did not move');
  ok(untouched(before, after, rects), 'other lines are identical');
  ok(stats.removed === 'Account holder: John Carpenter'.length + 4, `glyph count (${stats.removed})`);
  ok(!(await rawContent(bytes)).includes('Carpenter'), 'raw page data has no trace');
}

// ---------- 2. embedded Unicode font (what the desktop app writes for new text) ----------
console.log('embedded TrueType font with Turkish text');
const arial = join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf');
if (existsSync(arial)) {
  const d = await PDFDocument.create(); d.registerFontkit(fontkit);
  const f = await d.embedFont(readFileSync(arial), { subset: true }), p = d.addPage([595, 842]);
  p.drawText('Müşteri: İbrahim Çağlayan', { x: 50, y: 760, size: 14, font: f });
  p.drawText('Gizli şifre: ığüşöç-1234', { x: 50, y: 730, size: 14, font: f });
  p.drawText('Teşekkürler', { x: 50, y: 700, size: 14, font: f });
  const src = await d.save(), before = await items(src);
  ok(text(before).includes('Müşteri: İbrahim Çağlayan'), 'Turkish text is stored as real, searchable text');
  const secret = before.find(i => i.str.includes('Gizli')), rects = [box(secret)];
  const { bytes } = await redact(src, rects), after = await items(bytes);
  ok(!text(after).includes('Gizli') && !text(after).includes('1234'), 'line is gone');
  ok(untouched(before, after, rects) && after.length === 2, 'other lines are identical');
} else console.log('  skip (Arial not found)');

// ---------- 3. hand-written page: kerning arrays, quote operators, scaling, forms, ActualText ----------
console.log('unusual page instructions');
{
  const d = await PDFDocument.create(), ctx = d.context, p = d.addPage([595, 842]);
  const f1 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const form = ctx.register(ctx.stream('BT /F1 12 Tf 50 500 Td (form TOPSECRET here) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595, 842], Resources: { Font: { F1: f1 } } }));
  p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f1 }, XObject: { Fm1: form } }));
  p.node.set(PDFName.of('Contents'), ctx.register(ctx.stream([
    'BT /F1 12 Tf 50 700 Td [(Alpha) -250 (Bravo) 120 (Charlie)] TJ ET',
    'BT /F1 10 Tf 14 TL 50 660 Td (first line) Tj (second SECRET line) \' 2 1 (third quoted) " ET',
    'q 2 0 0 2 0 0 cm BT /F1 8 Tf 110 Tz 25 300 Td 1 Tc (scaled HIDDEN text) Tj ET Q',
    '/Span <</ActualText (PRIVATE)>> BDC BT /F1 12 Tf 50 550 Td (PRIVATE) Tj ET EMC',
    'BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI',
    'q /Fm1 Do Q q 1 0 0 1 0 -40 cm /Fm1 Do Q',
  ].join('\n'))));
  const src = await d.save(), before = await items(src);
  const f = await d.embedFont(StandardFonts.Helvetica), w = (s, z) => [...s].reduce((n, ch) => n + f.widthOfTextAtSize(ch, z), 0);
  // boxes from the known positions in the page above: [left, right, baseline, font size]
  const rb = (x0, x1, y, size) => [x0 - 0.5, y - size * 0.22, x1 + 0.5, y + size * 0.8];
  const bx = 50 + w('Alpha', 12) + 0.25 * 12;
  const rects = [rb(bx, bx + w('Bravo', 12), 700, 12), rb(50 + w('second ', 10), 50 + w('second SECRET', 10), 646, 10), rb(50, 300, 600, 16),
    rb(50, 50 + w('PRIVATE', 12), 550, 12), rb(50 + w('form ', 12), 50 + w('form TOPSECRET', 12), 500, 12)];
  const { bytes } = await redact(src, rects), after = await items(bytes), all = text(after), raw = await rawContent(bytes);
  const on = (its, y) => its.filter(i => Math.abs(i.y - y) < 1), endOf = (its, y) => Math.max(...on(its, y).map(i => i.x + i.w));
  ok(!all.includes('Bravo') && all.includes('Alpha') && all.includes('Charlie'), 'word removed from a kerned array');
  ok(Math.abs(endOf(after, 700) - endOf(before, 700)) < 0.5, 'kerned line keeps its length');
  ok(!text(on(after, 646)).includes('SECRET') && /second/.test(text(on(after, 646))) && /line/.test(text(on(after, 646))), "word removed from a ' line");
  ok(Math.abs(endOf(after, 646) - endOf(before, 646)) < 0.5, "' line keeps its length");
  ok(untouched(before, after, rects) && /third/.test(text(on(after, 632))), 'following " line and other lines are identical');
  ok(!on(after, 600).length, 'text under a scaling transform removed');
  ok(!all.includes('PRIVATE') && !raw.includes('PRIVATE') && !raw.includes('ActualText'), 'ActualText copy of the words removed');
  ok(!text(on(after, 500)).includes('TOPSECRET') && /form/.test(text(on(after, 500))) && /here/.test(text(on(after, 500))), 'word removed inside a form');
  ok(Math.abs(endOf(after, 500) - endOf(before, 500)) < 0.5, 'form line keeps its length');
  ok(/form\s+TOPSECRET\s+here/.test(text(on(after, 460))), 'second use of the same form is untouched');
}

// ---------- 4. a PDF printed by Chromium (the most common real-world producer) ----------
console.log('Chromium-printed PDF');
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
if (edge) {
  const dir = mkdtempSync(join(tmpdir(), 'snn-')), html = join(dir, 'in.html'), pdf = join(dir, 'out.pdf');
  writeFileSync(html, `<meta charset="utf-8"><body style="font:16px Georgia,serif;margin:40px"><h1>Sözleşme</h1>
<p>Bu belge <b>Ayşe Yılmaz</b> ile <i>SNN Yazılım</i> arasında düzenlenmiştir.</p>
<p style="font-family:Arial">IBAN: TR12 3456 7890 1234 5678 9012 34</p><p>Toplam tutar: 12.500 TL (KDV dahil).</p>
<table border=1 cellpadding=6><tr><td>Kalem</td><td>Fiyat</td></tr><tr><td>Danışmanlık</td><td>9.000</td></tr></table></body>`);
  try {
    execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${pdf}`, pathToFileURL(html).href], { stdio: 'ignore', timeout: 60000 });
    // the launcher can return before the browser has finished writing the file
    for (let i = 0; i < 100 && !existsSync(pdf); i++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 500));
    const src = new Uint8Array(readFileSync(pdf)), before = await items(src);
    const iban = before.filter(i => i.str.includes('IBAN') || /^\d{4}$|TR12/.test(i.str.trim())), y = before.find(i => i.str.includes('IBAN')).y;
    const lineItems = before.filter(i => Math.abs(i.y - y) < 1), price = before.find(i => i.str.includes('9.000'));
    const x0 = Math.min(...lineItems.map(i => i.x)), x1 = Math.max(...lineItems.map(i => i.x + i.w));
    const rects = [box(lineItems[0], x0, x1), box(price)];
    const { bytes, stats } = await redact(src, rects), after = await items(bytes), all = text(after);
    ok(iban.length > 0 && !all.includes('IBAN') && !all.includes('TR12') && !all.includes('7890'), 'IBAN line is gone');
    ok(!all.includes('9.000') && all.includes('Danışmanlık'), 'table cell is gone, its neighbour stays');
    ok(untouched(before, after, rects), 'other lines are identical');
    ok(stats.removed > 30, `glyph count (${stats.removed})`);
  } catch (e) { ok(false, 'could not print or process: ' + e.message); }
} else console.log('  skip (no Chromium browser found)');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
