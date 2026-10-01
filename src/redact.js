// SNN PDF Editor — true text removal.
// Rewrites a page's content stream so that glyphs whose centre lies inside one of the given
// rectangles are deleted from the file itself, not just painted over. The remaining text keeps
// its position: every removed glyph is replaced by an equal horizontal adjustment.
// Works on pdf-lib objects; pass the PDFLib namespace in so it runs in the browser and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnnRedact = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const latin1 = (b, s = 0, e = b.length) => { let o = ''; for (let i = s; i < e; i++) o += String.fromCharCode(b[i]); return o; };
const fmt = n => String(+n.toFixed(3));
const isWs = c => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

// ---------- content stream tokenizer ----------
function lexer(b) {
  let pos = 0; const n = b.length;
  function skip() {
    for (;;) {
      while (pos < n && isWs(b[pos])) pos++;
      if (b[pos] !== 37) return;
      while (pos < n && b[pos] !== 10 && b[pos] !== 13) pos++;
    }
  }
  function regular() { const s = pos; while (pos < n && !isWs(b[pos]) && !isDelim(b[pos])) pos++; return latin1(b, s, pos); }
  function litString() {
    pos++; const out = []; let depth = 1;
    while (pos < n) {
      let c = b[pos++];
      if (c === 92) {
        c = b[pos++];
        if (c === 110) out.push(10); else if (c === 114) out.push(13); else if (c === 116) out.push(9); else if (c === 98) out.push(8); else if (c === 102) out.push(12);
        else if (c >= 48 && c <= 55) { let v = c - 48; for (let i = 0; i < 2 && b[pos] >= 48 && b[pos] <= 55; i++) v = v * 8 + b[pos++] - 48; out.push(v & 255); }
        else if (c === 13) { if (b[pos] === 10) pos++; }
        else if (c !== 10) out.push(c);
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) break; out.push(c); }
      else if (c === 13) { if (b[pos] === 10) pos++; out.push(10); }
      else out.push(c);
    }
    return out;
  }
  function hexString() {
    pos++; const out = []; let hi = -1;
    while (pos < n) {
      const c = b[pos++]; if (c === 62) break;
      const d = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (d < 0) continue;
      if (hi < 0) hi = d; else { out.push(hi * 16 + d); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return out;
  }
  function next() {
    skip(); if (pos >= n) return null;
    const s = pos, c = b[pos];
    if (c === 40) return { t: 'str', v: litString(), s, e: pos };
    if (c === 60) {
      if (b[pos + 1] !== 60) return { t: 'str', v: hexString(), s, e: pos };
      pos += 2; for (;;) { const k = next(); if (!k || k.t === '>>') break; }
      return { t: 'dict', s, e: pos };
    }
    if (c === 62) { pos += b[pos + 1] === 62 ? 2 : 1; return { t: '>>', s, e: pos }; }
    if (c === 91) { pos++; const v = []; for (;;) { const k = next(); if (!k || k.t === ']') break; v.push(k); } return { t: 'arr', v, s, e: pos }; }
    if (c === 93) { pos++; return { t: ']', s, e: pos }; }
    if (c === 47) { pos++; return { t: 'name', v: regular(), s, e: pos }; }
    if (c === 41 || c === 123 || c === 125) { pos++; return { t: 'junk', s, e: pos }; }
    const w = regular();
    if (/^[+\-.\d]/.test(w) && isFinite(parseFloat(w))) return { t: 'num', v: parseFloat(w), s, e: pos };
    return { t: 'op', v: w, s, e: pos };
  }
  // inline image data runs from "ID" to an "EI" that stands alone between whitespace
  function skipImage() {
    for (let i = pos + 1; i < n - 1; i++) if (b[i] === 69 && b[i + 1] === 73 && isWs(b[i - 1]) && (i + 2 >= n || isWs(b[i + 2]))) { pos = i + 2; return; }
    pos = n;
  }
  return { next, skipImage };
}

// ---------- fonts: how many bytes per character code, and how wide each code is ----------
function streamBytes(L, s) {
  if (s instanceof L.PDFRawStream) return L.decodePDFRawStream(s).decode();
  return typeof s.getUnencodedContents === 'function' ? s.getUnencodedContents() : s.getContents();
}
function cmap(txt) {
  const lens = new Set(), ranges = [];
  for (const m of txt.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>/g)) lens.add(h[1].length / 2);
  if (lens.size !== 1 || /usecmap/.test(txt)) return null;
  for (const m of txt.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) ranges.push([parseInt(r[1], 16), parseInt(r[2], 16), +r[3]]);
  for (const m of txt.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) ranges.push([parseInt(r[1], 16), parseInt(r[1], 16), +r[2]]);
  return { bytes: [...lens][0], vertical: /\/WMode\s+1/.test(txt), toCid: c => { for (const r of ranges) if (c >= r[0] && c <= r[1]) return r[2] + c - r[0]; return c; } };
}
function stdWidths(L, base) {
  const b = (base || '').replace(/^[A-Z]{6}\+/, ''), bold = /bold/i.test(b), ital = /italic|oblique/i.test(b);
  const name = /symbol/i.test(b) ? 'Symbol' : /dingbat/i.test(b) ? 'ZapfDingbats'
    : /times/i.test(b) ? (bold && ital ? 'Times-BoldItalic' : bold ? 'Times-Bold' : ital ? 'Times-Italic' : 'Times-Roman')
    : (/courier/i.test(b) ? 'Courier' : 'Helvetica') + (bold || ital ? '-' : '') + (bold ? 'Bold' : '') + (ital ? 'Oblique' : '');
  let emb = null; try { emb = L.StandardFontEmbedder.for(name); } catch {}
  const dec = new TextDecoder('windows-1252'), cache = [];
  return c => cache[c] ??= (() => { try { return emb.widthOfTextAtSize(dec.decode(Uint8Array.of(c)), 1); } catch { return 0.5; } })();
}
function fontInfo(E, fd) {
  const { L, N } = E, n = (o, d) => (o instanceof L.PDFNumber ? o.asNumber() : d);
  const nm = o => (o instanceof L.PDFName ? o.decodeText() : ''), sub = nm(fd.lookup(N('Subtype')));
  if (sub === 'Type0') {
    const enc = fd.lookup(N('Encoding')); let bytes = 2, vertical = false, toCid = c => c;
    if (enc instanceof L.PDFName) { const e = enc.decodeText(); vertical = /-V$/.test(e); if (!/^Identity-|UCS2|UTF16/.test(e)) return null; }
    else if (enc instanceof L.PDFStream) { const cm = cmap(latin1(streamBytes(L, enc))); if (!cm) return null; ({ bytes, vertical, toCid } = cm); }
    const dfs = fd.lookup(N('DescendantFonts')), df = dfs instanceof L.PDFArray ? dfs.lookup(0) : null;
    if (!(df instanceof L.PDFDict)) return null;
    const dw = n(df.lookup(N('DW')), 1000), W = new Map(), wa = df.lookup(N('W'));
    if (wa instanceof L.PDFArray) for (let i = 0; i < wa.size();) {
      const a = n(wa.lookup(i), 0), b = wa.lookup(i + 1);
      if (b instanceof L.PDFArray) { for (let j = 0; j < b.size(); j++) W.set(a + j, n(b.lookup(j), dw)); i += 2; }
      else { const w = n(wa.lookup(i + 2), dw), last = Math.min(n(b, a), a + 65535); for (let c = a; c <= last; c++) W.set(c, w); i += 3; }
    }
    return { bytes, vertical, width: c => (W.get(toCid(c)) ?? dw) / 1000 };
  }
  const wa = fd.lookup(N('Widths')), first = n(fd.lookup(N('FirstChar')), 0);
  if (wa instanceof L.PDFArray) {
    const fm = fd.lookup(N('FontMatrix')), k = sub === 'Type3' && fm instanceof L.PDFArray ? n(fm.lookup(0), 0.001) : 0.001;
    const dsc = fd.lookup(N('FontDescriptor')), miss = dsc instanceof L.PDFDict ? n(dsc.lookup(N('MissingWidth')), 0) : 0, ws = [];
    for (let i = 0; i < wa.size(); i++) ws.push(n(wa.lookup(i), miss));
    return { bytes: 1, width: c => (ws[c - first] ?? miss) * k };
  }
  // one of the 14 standard fonts, which carry no width table of their own
  return { bytes: 1, width: stdWidths(L, nm(fd.lookup(N('BaseFont')))) };
}
function resLookup(E, res, cat, name) {
  try { const d = res && res.lookup(E.N(cat)); return d instanceof E.L.PDFDict ? d.lookup(E.N(name)) : undefined; } catch { return undefined; }
}
// true for colour spaces whose numbers can be read directly as grey, RGB or CMYK
function plainSpace(E, res, tok) {
  if (!tok || tok.t !== 'name') return false;
  if (/^Device(Gray|RGB|CMYK)$/.test(tok.v)) return true;
  let cs = resLookup(E, res, 'ColorSpace', tok.v);
  if (cs instanceof E.L.PDFArray) cs = cs.lookup(0);
  return cs instanceof E.L.PDFName && /^(Device(Gray|RGB|CMYK)|ICCBased|CalRGB|CalGray)$/.test(cs.decodeText());
}
const cmyk = a => [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])];
function font(E, res, tok) {
  if (!tok || tok.t !== 'name') return null;
  const fd = resLookup(E, res, 'Font', tok.v); if (!(fd instanceof E.L.PDFDict)) return null;
  if (!E.fonts.has(fd)) { let fi = null; try { fi = fontInfo(E, fd); } catch {} E.fonts.set(fd, fi); }
  return E.fonts.get(fd);
}

// ---------- the rewrite ----------
function rewrite(E, bytes, res, gs0, depth) {
  const { L, N } = E, lx = lexer(bytes), edits = [], stack = [], marks = [], added = [];
  let gs = { ...gs0 }, tm = IDENT, tlm = IDENT, ops = [], t;
  const nums = k => { const a = ops.slice(-k); return a.length === k && a.every(o => o.t === 'num') ? a.map(o => o.v) : null; };
  const one = d => { const a = nums(1); return a ? a[0] : d; };
  const nextLine = (x, y) => { tlm = mul([1, 0, 0, 1, x, y], tlm); tm = tlm; };

  function show(items, s, e, prefix) {
    const f = gs.font, nb = f ? f.bytes : 1, out = []; let run = [], adj = 0, hit = false;
    const endRun = () => { if (run.length) { out.push('<' + run.map(v => v.toString(16).padStart(2, '0')).join('') + '>'); run = []; } };
    const endAdj = () => { if (adj) { out.push(fmt(adj)); adj = 0; } };
    for (const it of items) {
      if (it.t === 'num') { endRun(); adj += it.v; tm = mul([1, 0, 0, 1, -it.v / 1000 * gs.fs * gs.th, 0], tm); continue; }
      if (it.t !== 'str') continue;
      const v = it.v;
      for (let i = 0; i < v.length; i += nb) {
        const end = Math.min(v.length, i + nb); let code = 0; for (let j = i; j < end; j++) code = code * 256 + v[j];
        const w = f ? f.width(code) : 0.5, sp = nb === 1 && code === 32 ? gs.tw : 0; let kill = false;
        if (f && !f.vertical) {
          const gx = w / 2 * gs.fs * gs.th, gy = gs.ts + 0.3 * gs.fs;
          const tx = gx * tm[0] + gy * tm[2] + tm[4], ty = gx * tm[1] + gy * tm[3] + tm[5], c = gs.ctm;
          const x = tx * c[0] + ty * c[2] + c[4], y = tx * c[1] + ty * c[3] + c[5];
          const ri = E.rects.findIndex(r => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);
          if (!E.probe) kill = ri >= 0;
          else if (ri >= 0 && gs.fill && gs.tr !== 1 && gs.tr !== 3 && code !== 32) { const k = gs.fill.join(); E.probe[ri].set(k, (E.probe[ri].get(k) || 0) + 1); }
        }
        if (kill) { endRun(); adj -= w * 1000 + (gs.fs ? (gs.tc + sp) * 1000 / gs.fs : 0); hit = true; E.stats.removed++; }
        else { endAdj(); for (let j = i; j < end; j++) run.push(v[j]); }
        tm = mul([1, 0, 0, 1, (w * gs.fs + gs.tc + sp) * gs.th, 0], tm);
      }
    }
    if (!hit) return;
    endRun(); endAdj();
    edits.push({ s, e, text: prefix + '[' + out.join(' ') + '] TJ' });
    marks.forEach(m => m.hit = true);
  }

  while ((t = lx.next())) {
    if (t.t !== 'op') { ops.push(t); continue; }
    const s = ops.length ? ops[0].s : t.s, e = t.e, last = ops[ops.length - 1];
    let a;
    switch (t.v) {
      case 'q': stack.push({ ...gs }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if ((a = nums(6))) gs.ctm = mul(a, gs.ctm); break;
      case 'BT': tm = tlm = IDENT; break;
      case 'Tf': gs.font = font(E, res, ops[ops.length - 2]); gs.fs = one(0); break;
      case 'Tc': gs.tc = one(0); break;
      case 'Tw': gs.tw = one(0); break;
      case 'Tz': gs.th = one(100) / 100; break;
      case 'TL': gs.tl = one(0); break;
      case 'Ts': gs.ts = one(0); break;
      case 'Tr': gs.tr = one(0); break;
      case 'g': if ((a = nums(1))) { gs.fill = [a[0], a[0], a[0]]; gs.fcs = true; } break;
      case 'rg': if ((a = nums(3))) { gs.fill = a; gs.fcs = true; } break;
      case 'k': if ((a = nums(4))) { gs.fill = cmyk(a); gs.fcs = true; } break;
      case 'cs': gs.fcs = plainSpace(E, res, last); gs.fill = gs.fcs ? [0, 0, 0] : null; break;
      case 'sc': case 'scn':
        if (gs.fcs) { a = nums(ops.length) || []; gs.fill = a.length === 1 ? [a[0], a[0], a[0]] : a.length === 3 ? a : a.length === 4 ? cmyk(a) : null; }
        break;
      case 'Td': if ((a = nums(2))) nextLine(a[0], a[1]); break;
      case 'TD': if ((a = nums(2))) { gs.tl = -a[1]; nextLine(a[0], a[1]); } break;
      case 'Tm': if ((a = nums(6))) tm = tlm = a; break;
      case 'T*': nextLine(0, -gs.tl); break;
      case 'Tj': if (last) show([last], s, e, ''); break;
      case 'TJ': if (last && last.t === 'arr') show(last.v, s, e, ''); break;
      case "'": nextLine(0, -gs.tl); if (last) show([last], s, e, 'T* '); break;
      case '"': {
        const p = ops.slice(-3);
        if (p.length === 3 && p[0].t === 'num' && p[1].t === 'num') { gs.tw = p[0].v; gs.tc = p[1].v; }
        nextLine(0, -gs.tl); if (last) show([last], s, e, `${fmt(gs.tw)} Tw ${fmt(gs.tc)} Tc T* `); break;
      }
      case 'ID': lx.skipImage(); break;
      case 'BMC': marks.push({}); break;
      case 'BDC': marks.push({ s, e, actual: ops.some(o => o.t === 'dict' && latin1(bytes, o.s, o.e).includes('/ActualText')) }); break;
      // a span's /ActualText would still spell out the words we just deleted
      case 'EMC': { const m = marks.pop(); if (m && m.actual && m.hit) edits.push({ s: m.s, e: m.e, text: '/Span BMC' }); break; }
      case 'Do': {
        if (!last || last.t !== 'name' || depth > 6) break;
        const xo = resLookup(E, res, 'XObject', last.v);
        if (!(xo instanceof L.PDFStream)) break;
        const st = xo.dict.lookup(N('Subtype')); if (!(st instanceof L.PDFName) || st.decodeText() !== 'Form') break;
        const ma = xo.dict.lookup(N('Matrix')), fres = xo.dict.lookup(N('Resources'));
        const mt = ma instanceof L.PDFArray && ma.size() === 6 ? [0, 1, 2, 3, 4, 5].map(i => { const v = ma.lookup(i); return v instanceof L.PDFNumber ? v.asNumber() : 0; }) : IDENT;
        const sub = rewrite(E, streamBytes(L, xo), fres instanceof L.PDFDict ? fres : res, { ...gs, ctm: mul(mt, gs.ctm) }, depth + 1);
        if (!sub.changed) break;
        // the form may be drawn elsewhere too, so the cleaned version becomes a new object under a new name
        const ns = E.ctx.flateStream(sub.bytes);
        xo.dict.entries().forEach(([k, v]) => { if (!['Filter', 'DecodeParms', 'Length', 'DL'].includes(k.decodeText())) ns.dict.set(k, v); });
        if (sub.res !== fres) ns.dict.set(N('Resources'), sub.res);
        let name; do name = 'FoR' + (++E.seq); while (resLookup(E, res, 'XObject', name));
        added.push([name, E.ctx.register(ns)]);
        edits.push({ s, e, text: '/' + name + ' Do' });
        break;
      }
    }
    ops = [];
  }

  if (!edits.length) return { changed: false, bytes, res };
  edits.sort((x, y) => x.s - y.s);
  const parts = []; let at = 0, len = 0;
  for (const ed of edits) {
    const txt = ' ' + ed.text + ' ', rep = new Uint8Array(txt.length);
    for (let i = 0; i < txt.length; i++) rep[i] = txt.charCodeAt(i);
    parts.push(bytes.subarray(at, ed.s), rep); at = ed.e;
  }
  parts.push(bytes.subarray(at));
  parts.forEach(p => len += p.length);
  const out = new Uint8Array(len); at = 0;
  parts.forEach(p => { out.set(p, at); at += p.length; });

  let outRes = res;
  if (added.length) {
    const clone = d => { const c = E.ctx.obj({}); if (d instanceof L.PDFDict) d.entries().forEach(([k, v]) => c.set(k, v)); return c; };
    outRes = clone(res); const xo = clone(res.lookup(N('XObject')));
    added.forEach(([k, ref]) => xo.set(N(k), ref)); outRes.set(N('XObject'), xo);
  }
  return { changed: true, bytes: out, res: outRes };
}

// Deletes every glyph of `page` (a pdf-lib PDFPage) whose centre is inside one of `rects`.
// Each rect is [x0, y0, x1, y1] in the page's PDF coordinates. Returns { removed: glyphCount }.
function run(L, page, rects, probe) {
  const stats = { removed: 0 };
  if (!rects.length) return probe ? [] : stats;
  const ctx = page.doc.context, node = page.node, N = s => L.PDFName.of(s);
  const E = { L, ctx, N, rects, stats, fonts: new Map(), seq: 0, probe: probe ? rects.map(() => new Map()) : null };
  const c = node.Contents(), list = c instanceof L.PDFArray ? Array.from({ length: c.size() }, (_, i) => c.lookup(i)) : c ? [c] : [];
  const chunks = list.filter(s => s instanceof L.PDFStream).map(s => streamBytes(L, s));
  const bytes = new Uint8Array(chunks.reduce((n, ch) => n + ch.length + 1, 0)); let at = 0;
  chunks.forEach(ch => { bytes.set(ch, at); at += ch.length; bytes[at++] = 10; });
  const res = node.Resources();
  const r = rewrite(E, bytes, res, { ctm: IDENT, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, fill: [0, 0, 0], fcs: true }, 0);
  // probing: the colour most of the glyphs in each rect are filled with
  if (probe) return E.probe.map(m => {
    const top = [...m].sort((x, y) => y[1] - x[1])[0];
    return top ? '#' + top[0].split(',').map(v => Math.round(Math.min(1, Math.max(0, +v)) * 255).toString(16).padStart(2, '0')).join('') : null;
  });
  if (r.changed) {
    node.set(N('Contents'), ctx.register(ctx.flateStream(r.bytes)));
    if (r.res !== res) node.set(N('Resources'), r.res);
  }
  return stats;
}

const redactPage = (L, page, rects) => run(L, page, rects, false);
// The exact fill colour of the text inside each rect, as '#rrggbb' (null where it can't be told).
// Changes nothing in the page.
const probePage = (L, page, rects) => run(L, page, rects, true);

return { redactPage, probePage };
});
