/* Vellum .fig reader: opens files saved from Figma (File > Save local copy) without a plugin.
   .fig is a zip (or a bare "fig-kiwi" archive) holding canvas.fig: a binary Kiwi schema plus the document, compressed
   with deflate or zstd, and an images/ folder named by hash. The format is not documented by Figma, so this is
   best effort: what it cannot map is listed in the warnings. No eval: the Kiwi decoder interprets the schema. */
(function () {
  'use strict';
  /* ---------- Kiwi decoding ---------- */
  const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer), td = new TextDecoder();
  class BB {
    constructor(u8) { this.d = u8; this.i = 0; }
    byte() { if (this.i >= this.d.length) throw new Error('Unexpected end of data'); return this.d[this.i++]; }
    vuint() { let v = 0, s = 0, b; do { b = this.byte(); v |= (b & 127) << s; s += 7; } while (b & 128 && s < 35); return v >>> 0; }
    vint() { const v = this.vuint() | 0; return v & 1 ? ~(v >>> 1) : v >>> 1; }
    vuint64() { let v = 0, m = 1, b; do { b = this.byte(); v += (b & 127) * m; m *= 128; } while (b & 128 && m < 2 ** 63); return v; }
    vint64() { const v = this.vuint64(); return v % 2 ? -(v + 1) / 2 : v / 2; }
    vfloat() { const d = this.d, i = this.i; const first = d[i]; if (first === 0) { this.i = i + 1; return 0; } if (i + 4 > d.length) throw new Error('Unexpected end of data');
      let bits = first | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24); this.i = i + 4; i32[0] = (bits << 23) | (bits >>> 9); return f32[0]; }
    str() { const s = this.i; while (this.i < this.d.length && this.d[this.i] !== 0) this.i++; const out = td.decode(this.d.subarray(s, this.i)); this.i++; return out; }
    bytes() { const n = this.vuint(); if (this.i + n > this.d.length) throw new Error('Unexpected end of data'); const out = this.d.slice(this.i, this.i + n); this.i += n; return out; }
  }
  const BUILTIN = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'], KINDS = ['ENUM', 'STRUCT', 'MESSAGE'];
  function readSchema(u8) {
    const bb = new BB(u8); const n = bb.vuint(); const defs = [];
    for (let i = 0; i < n; i++) { const name = bb.str(), kind = KINDS[bb.byte()], fc = bb.vuint(), fields = [];
      for (let j = 0; j < fc; j++) fields.push({ name: bb.str(), type: bb.vint(), arr: !!(bb.byte() & 1), value: bb.vuint() });
      defs.push({ name, kind, fields }); }
    for (const d of defs) for (const f of d.fields) f.type = f.type < 0 ? BUILTIN[~f.type] : defs[f.type];
    const byName = {}; for (const d of defs) { byName[d.name] = d; d.byValue = {}; for (const f of d.fields) d.byValue[f.value] = f; }
    return byName;
  }
  function readValue(bb, type) {
    if (typeof type === 'string') switch (type) {
      case 'bool': return !!bb.byte(); case 'byte': return bb.byte(); case 'int': return bb.vint(); case 'uint': return bb.vuint();
      case 'float': return bb.vfloat(); case 'string': return bb.str(); case 'int64': return bb.vint64(); case 'uint64': return bb.vuint64(); }
    if (type.kind === 'ENUM') { const v = bb.vuint(); const f = type.byValue[v]; return f ? f.name : v; }
    const o = {};
    if (type.kind === 'STRUCT') { for (const f of type.fields) o[f.name] = readField(bb, f); return o; }
    for (;;) { const v = bb.vuint(); if (v === 0) return o; const f = type.byValue[v]; if (!f) throw new Error('Unknown field in ' + type.name); o[f.name] = readField(bb, f); }
  }
  function readField(bb, f) {
    if (!f.arr) return readValue(bb, f.type);
    if (f.type === 'byte') return bb.bytes();
    const n = bb.vuint(); if (n > 5e7) throw new Error('Corrupt array length'); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = readValue(bb, f.type); return a;
  }

  /* ---------- archive ---------- */
  const isZip = u => u[0] === 0x50 && u[1] === 0x4b;
  const isZstd = u => u[0] === 0x28 && u[1] === 0xb5 && u[2] === 0x2f && u[3] === 0xfd;
  function inflate(u) {
    if (isZstd(u)) { if (!window.fzstd) throw new Error('zstd support is missing'); return window.fzstd.decompress(u); }
    try { return window.fflate.inflateSync(u); } catch (e) { return window.fflate.unzlibSync(u); }
  }
  function readArchive(u) {
    const pre = td.decode(u.subarray(0, 8));
    if (!/^fig-/.test(pre)) throw new Error('This is not a Figma file');
    if (pre === 'fig-jam.' || pre === 'fig-jamb') throw new Error('FigJam boards are not supported. Open a Figma design file.');
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let o = 12; const chunks = [];
    while (o + 4 <= u.length) { const n = dv.getUint32(o, true); o += 4; if (o + n > u.length) break; chunks.push(u.subarray(o, o + n)); o += n; }
    if (chunks.length < 2) throw new Error('The Figma file is incomplete');
    const schema = readSchema(inflate(chunks[0]));
    const root = schema.Message; if (!root) throw new Error('Unknown Figma file layout');
    return readValue(new BB(inflate(chunks[1])), root);
  }

  /* ---------- conversion to a Vellum document ---------- */
  function convert(msg, images) {
    const WARN = new Set(), stats = { nodes: 0, components: 0, instances: 0, images: 0, pages: 0 };
    const key = g => g ? g.sessionID + ':' + g.localID : '';
    const byKey = new Map(), kids = new Map();
    for (const nc of msg.nodeChanges || []) { if (!nc.guid) continue; byKey.set(key(nc.guid), nc); }
    for (const nc of byKey.values()) { const p = nc.parentIndex; if (!p || !p.guid) continue; const k = key(p.guid); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(nc); }
    for (const a of kids.values()) a.sort((x, y) => (x.parentIndex.position < y.parentIndex.position ? -1 : x.parentIndex.position > y.parentIndex.position ? 1 : 0));
    let SEQ = 1; const IDS = new Map(); const vid = k => { if (!IDS.has(k)) IDS.set(k, 'n' + (SEQ++)); return IDS.get(k); };
    const blobs = msg.blobs || [];
    const hex = c => { const h = v => Math.round(Math.max(0, Math.min(1, v || 0)) * 255).toString(16).padStart(2, '0'); return '#' + h(c.r) + h(c.g) + h(c.b); };
    const r2 = v => Math.round((v || 0) * 100) / 100;
    const vis = p => p && p.visible !== false;
    const imgCache = new Map();
    function imageURL(hash) {
      if (!hash) return null; const h = typeof hash === 'string' ? hash : Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
      if (imgCache.has(h)) return imgCache.get(h);
      const bytes = images[h]; let url = null;
      if (bytes) { const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : 'image/png';
        let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); url = 'data:' + mime + ';base64,' + btoa(s); stats.images++; }
      else WARN.add('Some images were not inside the file');
      imgCache.set(h, url); return url;
    }
    function weight(style) { const s = String(style || '').toLowerCase();
      if (/thin|hairline/.test(s)) return 100; if (/extra ?light|ultra ?light/.test(s)) return 200; if (/light/.test(s)) return 300;
      if (/medium/.test(s)) return 500; if (/semi ?bold|demi ?bold/.test(s)) return 600; if (/extra ?bold|ultra ?bold/.test(s)) return 800;
      if (/black|heavy/.test(s)) return 900; if (/bold/.test(s)) return 700; return 400; }
    function path(blobIndex) {
      const b = blobs[blobIndex]; if (!b || !b.bytes) return ''; const u = b.bytes; const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let i = 0, out = [];
      const f = () => { const v = dv.getFloat32(i, true); i += 4; return Math.round(v * 100) / 100; };
      try { while (i < u.length) { const c = u[i++];
        if (c === 0) out.push('Z'); else if (c === 1) out.push('M' + f() + ' ' + f()); else if (c === 2) out.push('L' + f() + ' ' + f());
        else if (c === 3) out.push('Q' + f() + ' ' + f() + ' ' + f() + ' ' + f()); else if (c === 4) out.push('C' + f() + ' ' + f() + ' ' + f() + ' ' + f() + ' ' + f() + ' ' + f());
        else break; } } catch (e) { }
      return out.join(' ');
    }
    const consMap = { MIN: 'start', MAX: 'end', CENTER: 'center', STRETCH: 'both', SCALE: 'scale' };
    function base(nc, type) {
      const w = nc.size ? nc.size.x : 0, h = nc.size ? nc.size.y : 0, t = nc.transform || { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const cx = t.m00 * w / 2 + t.m01 * h / 2 + t.m02, cy = t.m10 * w / 2 + t.m11 * h / 2 + t.m12;
      const n = { id: vid(key(nc.guid)), type, name: nc.name || type, x: r2(cx - w / 2), y: r2(cy - h / 2), w: r2(w), h: r2(h), rot: r2(Math.atan2(t.m10, t.m00) * 180 / Math.PI),
        fill: '#d9d9d9', fillOn: false, grad: null, style: null, stroke: '#000000', strokeOn: false, sw: 1, dash: 0, rad: 0,
        op: nc.opacity != null ? r2(nc.opacity) : 1, vis: nc.visible !== false, lock: !!nc.locked, shadow: null, blur: 0, children: [],
        cons: { h: consMap[nc.horizontalConstraint] || 'start', v: consMap[nc.verticalConstraint] || 'start' }, link: null };
      if (nc.cornerRadius) n.rad = r2(nc.cornerRadius); else if (nc.rectangleTopLeftCornerRadius) n.rad = r2(nc.rectangleTopLeftCornerRadius);
      if (nc.stackPositioning === 'ABSOLUTE') n.absPos = true;
      stats.nodes++; return n;
    }
    function fills(n, nc) {
      const ps = (nc.fillPaints || []).filter(vis); if (ps.length > 1) WARN.add('Layers with several fills keep only the top fill');
      const p = ps[ps.length - 1]; if (!p) { n.fillOn = false; return null; }
      if (p.type === 'SOLID' && p.color) { n.fillOn = true; n.fill = hex(p.color); const a = (p.opacity != null ? p.opacity : 1) * (p.color.a != null ? p.color.a : 1); if (a < 1) n.fop = r2(a); }
      else if (/^GRADIENT/.test(p.type || '')) { const st = p.stops || []; n.fillOn = true; n.fill = hex(st[0] ? st[0].color : { r: .8, g: .8, b: .8 });
        let ang = 90; const t = p.transform; if (t) { const det = t.m00 * t.m11 - t.m01 * t.m10; if (det) ang = Math.round(Math.atan2(-t.m10 / det, t.m11 / det) * 180 / Math.PI); }
        n.grad = { on: true, c2: hex(st[st.length - 1] ? st[st.length - 1].color : { r: 1, g: 1, b: 1 }), angle: ang }; if (p.type !== 'GRADIENT_LINEAR') WARN.add('Radial and angular gradients became linear gradients'); }
      else if (p.type === 'IMAGE') { n.fillOn = false; return p; }
      return null;
    }
    function strokes(n, nc) { const p = (nc.strokePaints || []).filter(x => vis(x) && x.type === 'SOLID').pop(); if (!p) return; n.strokeOn = true; n.stroke = hex(p.color); n.sw = r2(nc.strokeWeight != null ? nc.strokeWeight : 1); if (nc.dashPattern && nc.dashPattern.length) n.dash = nc.dashPattern[0]; }
    function effects(n, nc) { for (const e of nc.effects || []) { if (!vis(e)) continue;
      if (e.type === 'DROP_SHADOW' && !n.shadow) n.shadow = { on: true, x: r2(e.offset && e.offset.x), y: r2(e.offset && e.offset.y), b: r2(e.radius), c: hex(e.color || {}), o: r2(e.color && e.color.a != null ? e.color.a : .25) };
      else if (e.type === 'FOREGROUND_BLUR') n.blur = r2(e.radius); else WARN.add('Inner shadows and background blur are not supported yet'); } }
    function imageNode(n, p) { const src = imageURL(p.image && p.image.hash); const m = p.imageScaleMode; return Object.assign({}, n, { type: 'image', src: src || '', fit: m === 'FIT' ? 'fit' : m === 'STRETCH' ? 'stretch' : 'fill', fillOn: !src, fill: '#d9d9d9' }); }
    function auto(n, nc) {
      if (!nc.stackMode || nc.stackMode === 'NONE') return; const H = nc.stackMode !== 'VERTICAL';
      const pl = nc.stackHorizontalPadding != null ? nc.stackHorizontalPadding : nc.stackPadding || 0, pt = nc.stackVerticalPadding != null ? nc.stackVerticalPadding : nc.stackPadding || 0;
      const pr = nc.stackPaddingRight != null ? nc.stackPaddingRight : pl, pb = nc.stackPaddingBottom != null ? nc.stackPaddingBottom : pt;
      const hugMain = /RESIZE_TO_FIT/.test(nc.stackPrimarySizing || ''), hugCross = /RESIZE_TO_FIT/.test(nc.stackCounterSizing || '');
      const jm = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_EVENLY: 'between', SPACE_BETWEEN: 'between' }, am = { MIN: 'start', CENTER: 'center', MAX: 'end', BASELINE: 'start' };
      n.auto = { on: true, dir: H ? 'h' : 'v', gap: r2(nc.stackSpacing), pad: r2(pt), pt: r2(pt), pr: r2(pr), pb: r2(pb), pl: r2(pl), align: am[nc.stackCounterAlignItems] || 'start', just: jm[nc.stackPrimaryAlignItems] || 'start',
        hugW: H ? hugMain : hugCross, hugH: H ? hugCross : hugMain, hug: false, rtl: false, wrap: nc.stackWrap === 'WRAP', gap2: nc.stackCounterSpacing != null ? r2(nc.stackCounterSpacing) : undefined };
    }
    function childSizing(n, nc, parent) {
      if (!parent || !parent.stackMode || parent.stackMode === 'NONE') return; const H = parent.stackMode !== 'VERTICAL';
      const grow = nc.stackChildPrimaryGrow > 0, stretch = nc.stackChildAlignSelf === 'STRETCH';
      if (grow) { if (H) n.sizeH = 'fill'; else n.sizeV = 'fill'; } if (stretch) { if (H) n.sizeV = 'fill'; else n.sizeH = 'fill'; }
    }
    function node(nc, parent) {
      const t = nc.type;
      if (['SLICE', 'CONNECTOR', 'STICKY', 'WIDGET', 'SHAPE_WITH_TEXT', 'CODE_BLOCK', 'STAMP', 'HIGHLIGHT', 'WASHI_TAPE', 'TABLE', 'EMBED', 'LINK_UNFURL', 'MEDIA', 'VARIABLE', 'VARIABLE_SET', 'STYLE'].includes(t)) return null;
      let n;
      try {
        if (t === 'FRAME' || t === 'SYMBOL' || t === 'INSTANCE' || t === 'SECTION' || t === 'GROUP') {
          const isGroup = t === 'GROUP' || (t === 'FRAME' && nc.resizeToFit && !nc.stackMode);
          n = base(nc, isGroup ? 'group' : t === 'SYMBOL' ? 'comp' : 'frame');
          if (!isGroup) { const img = fills(n, nc); strokes(n, nc); effects(n, nc); n.clip = t !== 'SECTION' && !nc.frameMaskDisabled; auto(n, nc);
            if (nc.isStateGroup) n.variantSet = true;
            if (t === 'SYMBOL') { stats.components++; if (parent && parent.isStateGroup) n.variant = nc.name; }
            if (img) n._bg = img; }
          if (t === 'INSTANCE') { stats.instances++; const sid = nc.symbolData && nc.symbolData.symbolID; const mk = key(sid);
            if (sid && byKey.has(mk)) { n.type = 'inst'; n.master = vid(mk); n.ovr = [];
              for (const o of (nc.symbolData.symbolOverrides || [])) { const gs = o.guidPath && o.guidPath.guids; if (!gs || !gs.length) continue; const src = vid(key(gs[gs.length - 1]));
                if (o.textData && o.textData.characters != null) n.ovr.push({ src, k: 'text', v: o.textData.characters });
                if (o.visible === false) n.ovr.push({ src, k: 'vis', v: false });
                const fp = (o.fillPaints || []).filter(x => vis(x) && x.type === 'SOLID').pop(); if (fp) n.ovr.push({ src, k: 'fill', v: hex(fp.color) }); }
              childSizing(n, nc, parent); delete n._bg; return n; }
            WARN.add('Instances of library components were kept as frames (the library is not in this file)'); }
          n.children = (kids.get(key(nc.guid)) || []).map(c => node(c, nc)).filter(Boolean);
          if (n._bg) { const bg = imageNode(Object.assign({}, n, { id: 'n' + (SEQ++), name: n.name + ' image', x: 0, y: 0, rot: 0, children: [], auto: null, absPos: true, shadow: null, cons: { h: 'both', v: 'both' } }), n._bg); delete bg._bg; n.children.unshift(bg); }
          delete n._bg;
        } else if (t === 'RECTANGLE' || t === 'ROUNDED_RECTANGLE') { n = base(nc, 'rect'); const img = fills(n, nc); strokes(n, nc); effects(n, nc); if (img) n = imageNode(n, img); }
        else if (t === 'ELLIPSE') { n = base(nc, 'ellipse'); const img = fills(n, nc); strokes(n, nc); effects(n, nc);
          const a = nc.arcData; if (a && ((a.endingAngle - a.startingAngle) < 6.28 || a.innerRadius > 0)) n = vector(nc); else if (img) { n = imageNode(n, img); n.rad = Math.min(n.w, n.h) / 2; } }
        else if (t === 'LINE') { n = base(nc, 'line'); strokes(n, nc); n.strokeOn = true; n.h = 0; effects(n, nc); if (/ARROW/.test(nc.strokeCap || '')) n.arrow = true; }
        else if (t === 'REGULAR_POLYGON' || t === 'STAR') { n = base(nc, t === 'STAR' ? 'star' : 'polygon'); fills(n, nc); strokes(n, nc); effects(n, nc); n.sides = nc.count || (t === 'STAR' ? 5 : 3); if (t === 'STAR') n.inner = nc.starInnerScale != null ? r2(nc.starInnerScale) : .38; }
        else if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION') n = vector(nc);
        else if (t === 'TEXT') n = text(nc);
        else { WARN.add('Skipped unsupported layer type: ' + t); return null; }
      } catch (e) { WARN.add('A layer could not be converted (' + (nc.name || t) + ')'); return null; }
      childSizing(n, nc, parent); return n;
    }
    function vector(nc) {
      const n = base(nc, 'bool'); fills(n, nc); strokes(n, nc); effects(n, nc);
      let geo = n.fillOn ? (nc.fillGeometry || []) : []; let d = geo.map(g => path(g.commandsBlob)).join(' '); let rule = geo[0] && /ODD/.test(geo[0].windingRule || '') ? 'evenodd' : 'nonzero';
      if (!d) { const sg = nc.strokeGeometry || []; if (sg.length) { d = sg.map(g => path(g.commandsBlob)).join(' '); rule = 'nonzero'; n.fillOn = true; n.fill = n.stroke; n.strokeOn = false; } }
      if (!d) { n.type = 'rect'; n.fillOn = false; WARN.add('Some vectors had no outline data'); return n; }
      Object.assign(n, { d, ox: 0, oy: 0, sx: 1, sy: 1, rule }); return n;
    }
    function text(nc) {
      const n = base(nc, 'text'); const td2 = nc.textData || {}; n.text = td2.characters != null ? td2.characters : '';
      const fn = nc.fontName || {}; n.font = fn.family || 'Inter'; n.fs = r2(nc.fontSize || 12); n.fw = weight(fn.style); n.italic = /italic|oblique/i.test(fn.style || '');
      const lh = nc.lineHeight; n.lh = !lh || lh.units === 'RAW' && !lh.value ? 1.2 : lh.units === 'PIXELS' ? r2(lh.value / n.fs) : lh.units === 'PERCENT' ? r2(lh.value / 100) : lh.units === 'RAW' ? r2(lh.value) : 1.2;
      if (n.lh <= 0) n.lh = 1.2;
      const ls = nc.letterSpacing; n.ls = !ls ? 0 : ls.units === 'PERCENT' ? r2(ls.value / 100 * n.fs) : r2(ls.value);
      const rtl = /[֐-׿؀-ۿ]/.test(n.text); const al = nc.textAlignHorizontal;
      n.ta = al === 'CENTER' ? 'center' : al === 'RIGHT' ? (rtl ? 'start' : 'end') : al === 'LEFT' ? (rtl ? 'end' : 'start') : 'start';
      n.fixedW = nc.textAutoResize !== 'WIDTH_AND_HEIGHT'; n.fixedH = !nc.textAutoResize || nc.textAutoResize === 'NONE' || nc.textAutoResize === 'TRUNCATE';
      n.va = { TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' }[nc.textAlignVertical] || 'top';
      n.deco = nc.textDecoration === 'UNDERLINE' ? 'underline' : nc.textDecoration === 'STRIKETHROUGH' ? 'line-through' : '';
      n.upper = nc.textCase === 'UPPER';
      if (td2.styleOverrideTable && td2.styleOverrideTable.length) WARN.add('Text with mixed styles kept the style of its first run');
      fills(n, nc); if (!n.fillOn) { n.fillOn = true; n.fill = '#000000'; } effects(n, nc); return n;
    }
    const doc = [...byKey.values()].find(n => n.type === 'DOCUMENT');
    if (!doc) throw new Error('No document inside this Figma file');
    const canvases = (kids.get(key(doc.guid)) || []).filter(c => c.type === 'CANVAS');
    const pages = [];
    // components can live on Figma's hidden internal page; keep that page only when instances use them
    const used = new Set(); for (const nc of byKey.values()) if (nc.type === 'INSTANCE' && nc.symbolData && nc.symbolData.symbolID) used.add(key(nc.symbolData.symbolID));
    for (const c of canvases) {
      const list = kids.get(key(c.guid)) || [];
      if (c.internalOnly) { if (!list.some(x => used.has(key(x.guid)))) continue; }
      const nodes = list.map(x => node(x, c)).filter(Boolean);
      const bg = c.backgroundColor && c.backgroundEnabled !== false ? hex(c.backgroundColor) : '';
      pages.push({ id: 'p' + pages.length, name: c.internalOnly ? 'Library components' : (c.name || 'Page ' + (pages.length + 1)), bg, guides: [], nodes });
    }
    if (!pages.length) pages.push({ id: 'p0', name: 'Page 1', bg: '', guides: [], nodes: [] });
    stats.pages = pages.length;
    // instance masters that were converted as plain frames (e.g. library) become frames
    const all = new Set(); const walk = l => l.forEach(n => { all.add(n.id); walk(n.children || []); }); pages.forEach(p => walk(p.nodes));
    const fix = l => l.forEach(n => { if (n.type === 'inst' && !all.has(n.master)) { n.type = 'frame'; delete n.master; delete n.ovr; WARN.add('Some instances lost their component and became frames'); } fix(n.children || []); }); pages.forEach(p => fix(p.nodes));
    return { doc: { app: 'Vellum', format: 'vellum-doc', version: 1, source: 'figma-file', name: doc.name || 'Figma file', seq: SEQ + 1, cur: 0, mode: 'light', styles: [], tstyles: [], comments: [], pages }, warnings: [...WARN], stats };
  }

  /* read the uncompressed size from the zip directory before inflating anything */
  function zipEntrySizes(u) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let e = -1;
    for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) return null; const count = dv.getUint16(e + 10, true); let o = dv.getUint32(e + 16, true); const out = {};
    for (let k = 0; k < count && o + 46 <= u.length; k++) { if (dv.getUint32(o, true) !== 0x02014b50) break;
      const size = dv.getUint32(o + 24, true), nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true);
      out[td.decode(u.subarray(o + 46, o + 46 + nl))] = size; o += 46 + nl + xl + cl; }
    return out;
  }
  const MAX_CANVAS = 400 * 1048576;
  function parse(buf) {
    let u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); const images = {}; let name = '';
    if (isZip(u)) {
      if (!window.fflate) throw new Error('zip support is missing');
      const sizes = zipEntrySizes(u); if (sizes && sizes['canvas.fig'] > MAX_CANVAS) throw new Error('This Figma file is too large to open here (over 400 MB of data). Split it into smaller files or export pages from Figma.');
      const files = window.fflate.unzipSync(u, { filter: f => f.name === 'canvas.fig' || f.name === 'meta.json' || /^images\//.test(f.name) });
      for (const k in files) if (/^images\//.test(k)) images[k.slice(7).replace(/\.[a-z]+$/i, '')] = files[k];
      try { if (files['meta.json']) name = JSON.parse(td.decode(files['meta.json'])).file_name || ''; } catch (e) { }
      u = files['canvas.fig']; if (!u) throw new Error('This .fig file has no canvas inside');
    }
    const msg = readArchive(u); const out = convert(msg, images); if (name) out.doc.name = name; return out;
  }
  window.VellumFig = { parse, _readSchema: readSchema, _readArchive: readArchive };
})();
