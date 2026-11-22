// Export to Vellum — a Figma plugin that converts a whole Figma file (or the selection) into a Vellum project file.
// It keeps pages, layers, auto layout, constraints, components and instances (with overrides), color variables
// (with light/dark modes), paint and text styles, effects, images, vector geometry and prototype links.
figma.showUI(__html__, { width: 380, height: 420, themeColors: true });

let SEQ = 1;
const IDMAP = new Map();          // figma id -> vellum id
const vid = fid => { if (!IDMAP.has(fid)) IDMAP.set(fid, 'n' + (SEQ++)); return IDMAP.get(fid); };
const IMAGES = new Map();         // image hash -> data URL
const STYLES = [];                // vellum color variables {id,name,light,dark}
const STYLE_BY_VAR = new Map();   // figma variable id / paint style id -> vellum style id
const TSTYLES = [];
const TSTYLE_BY_ID = new Map();
const LINKS = [];                 // [vellumNode, figmaDestinationId, kind]
const WARN = new Set();
let stats = { nodes: 0, images: 0, components: 0, instances: 0 };

const hex2 = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const toHex = c => '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
const mixed = v => v === figma.mixed;
const progress = t => figma.ui.postMessage({ type: 'progress', text: t });

/* ---------- variables (design tokens) and styles ---------- */
async function readVariables() {
  if (!figma.variables || !figma.variables.getLocalVariableCollectionsAsync) return;
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  for (const col of cols) {
    const modes = col.modes || [];
    const light = modes.find(m => /light|default|day/i.test(m.name)) || modes[0];
    const dark = modes.find(m => /dark|night/i.test(m.name)) || light;
    for (const id of col.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v || v.resolvedType !== 'COLOR') continue;
      const resolve = async (modeId, depth = 0) => {
        let val = v.valuesByMode[modeId];
        let cur = v;
        while (val && val.type === 'VARIABLE_ALIAS' && depth < 10) {
          cur = await figma.variables.getVariableByIdAsync(val.id); depth++;
          if (!cur) return null;
          const m = Object.keys(cur.valuesByMode)[0];
          val = cur.valuesByMode[modeId] || cur.valuesByMode[m];
        }
        return val && typeof val.r === 'number' ? toHex(val) : null;
      };
      const l = await resolve(light.modeId), d = await resolve(dark.modeId);
      if (!l) continue;
      const sid = 's' + STYLES.length;
      STYLES.push({ id: sid, name: (col.name ? col.name + '/' : '') + v.name, light: l, dark: d || l });
      STYLE_BY_VAR.set(v.id, sid);
    }
  }
}
async function readPaintStyles() {
  const ps = await figma.getLocalPaintStylesAsync();
  for (const s of ps) {
    const p = (s.paints || []).find(x => x.type === 'SOLID' && x.visible !== false);
    if (!p) continue;
    const sid = 's' + STYLES.length;
    STYLES.push({ id: sid, name: s.name, light: toHex(p.color), dark: toHex(p.color) });
    STYLE_BY_VAR.set(s.id, sid);
  }
}
function weightFromStyle(style) {
  const s = String(style || '').toLowerCase();
  if (/thin|hairline/.test(s)) return 100; if (/extra ?light|ultra ?light/.test(s)) return 200; if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500; if (/semi ?bold|demi ?bold/.test(s)) return 600; if (/extra ?bold|ultra ?bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900; if (/bold/.test(s)) return 700; return 400;
}
function lineHeight(lh, fs) {
  if (!lh || mixed(lh) || lh.unit === 'AUTO') return 1.2;
  if (lh.unit === 'PIXELS') return Math.round(lh.value / fs * 100) / 100;
  return Math.round(lh.value) / 100;
}
function letterSpacing(ls, fs) { if (!ls || mixed(ls)) return 0; return ls.unit === 'PERCENT' ? Math.round(ls.value / 100 * fs * 100) / 100 : ls.value; }
async function readTextStyles() {
  const ts = await figma.getLocalTextStylesAsync();
  for (const s of ts) {
    const id = 't' + TSTYLES.length;
    TSTYLES.push({ id, name: s.name, font: s.fontName.family, fs: s.fontSize, fw: weightFromStyle(s.fontName.style), lh: lineHeight(s.lineHeight, s.fontSize), ls: letterSpacing(s.letterSpacing, s.fontSize), italic: /italic|oblique/i.test(s.fontName.style) });
    TSTYLE_BY_ID.set(s.id, id);
  }
}

/* ---------- paints, strokes, effects ---------- */
async function imageData(hash) {
  if (IMAGES.has(hash)) return IMAGES.get(hash);
  try {
    const img = figma.getImageByHash(hash); const bytes = await img.getBytesAsync();
    const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : 'image/png';
    const url = 'data:' + mime + ';base64,' + figma.base64Encode(bytes);
    IMAGES.set(hash, url); stats.images++; return url;
  } catch (e) { WARN.add('Some images could not be read'); return null; }
}
function gradientAngle(t) { // gradientTransform maps the paint box to gradient space; invert the direction vector
  try { const [[a, b], [c, d]] = t; const det = a * d - b * c; const dx = d / det, dy = -c / det; return Math.round(Math.atan2(dy, dx) * 180 / Math.PI); } catch (e) { return 90; }
}
function applyFills(n, node) {
  if (!('fills' in node) || mixed(node.fills)) { n.fillOn = false; return null; }
  const vis = node.fills.filter(p => p.visible !== false);
  if (vis.length > 1) WARN.add('Layers with several fills keep only the top fill');
  const p = vis[vis.length - 1];
  if (!p) { n.fillOn = false; return null; }
  if (p.type === 'SOLID') {
    n.fillOn = true; n.fill = toHex(p.color);
    if (p.opacity != null && p.opacity < 1) n.fop = Math.round(p.opacity * 100) / 100;
    const bv = p.boundVariables && p.boundVariables.color;
    if (bv && STYLE_BY_VAR.has(bv.id)) n.style = STYLE_BY_VAR.get(bv.id);
    else if (node.fillStyleId && !mixed(node.fillStyleId) && STYLE_BY_VAR.has(node.fillStyleId)) n.style = STYLE_BY_VAR.get(node.fillStyleId);
  } else if (/^GRADIENT/.test(p.type)) {
    const st = p.gradientStops || [];
    n.fillOn = true; n.fill = toHex(st[0] ? st[0].color : { r: .8, g: .8, b: .8 });
    n.grad = { on: true, c2: toHex(st[st.length - 1] ? st[st.length - 1].color : { r: 1, g: 1, b: 1 }), angle: gradientAngle(p.gradientTransform) };
    if (p.type !== 'GRADIENT_LINEAR') WARN.add('Radial and angular gradients became linear gradients');
  } else if (p.type === 'IMAGE') {
    n.fillOn = false; return p;
  } else { n.fillOn = false; }
  return null;
}
function applyStroke(n, node) {
  if (!('strokes' in node)) return;
  const p = (node.strokes || []).filter(s => s.visible !== false && s.type === 'SOLID').pop();
  if (!p) { n.strokeOn = false; return; }
  n.strokeOn = true; n.stroke = toHex(p.color);
  n.sw = mixed(node.strokeWeight) ? (node.strokeTopWeight || 1) : node.strokeWeight;
  if (node.dashPattern && node.dashPattern.length) n.dash = node.dashPattern[0];
}
function applyEffects(n, node) {
  if (!('effects' in node)) return;
  for (const e of node.effects) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' && !n.shadow) n.shadow = { on: true, x: e.offset.x, y: e.offset.y, b: e.radius, c: toHex(e.color), o: Math.round(e.color.a * 100) / 100 };
    else if (e.type === 'LAYER_BLUR') n.blur = e.radius;
    else if (e.type === 'INNER_SHADOW' || e.type === 'BACKGROUND_BLUR') WARN.add('Inner shadows and background blur are not supported yet');
  }
}

/* ---------- geometry ---------- */
// Vellum stores the unrotated top-left corner relative to the parent and rotates around the center (clockwise).
function placement(node, ox, oy) {
  const w = node.width, h = node.height, t = node.relativeTransform;
  const cx = t[0][0] * w / 2 + t[0][1] * h / 2 + t[0][2], cy = t[1][0] * w / 2 + t[1][1] * h / 2 + t[1][2];
  const rot = Math.round(Math.atan2(t[1][0], t[0][0]) * 180 / Math.PI * 100) / 100;
  return { x: Math.round((cx - w / 2 - ox) * 100) / 100, y: Math.round((cy - h / 2 - oy) * 100) / 100, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, rot };
}
const consMap = { MIN: 'start', MAX: 'end', CENTER: 'center', STRETCH: 'both', SCALE: 'scale' };
const justMap = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'between' };
const alignMap = { MIN: 'start', CENTER: 'center', MAX: 'end', BASELINE: 'start' };

function base(node, type, ox, oy) {
  const g = placement(node, ox, oy);
  const n = { id: vid(node.id), type, name: node.name, x: g.x, y: g.y, w: g.w, h: g.h, rot: g.rot, fill: '#d9d9d9', fillOn: false, grad: null, style: null,
    stroke: '#000000', strokeOn: false, sw: 1, dash: 0, rad: 0, op: node.opacity != null ? Math.round(node.opacity * 100) / 100 : 1, vis: node.visible !== false, lock: !!node.locked,
    shadow: null, blur: 0, children: [], cons: { h: 'start', v: 'start' }, link: null };
  if (node.constraints) n.cons = { h: consMap[node.constraints.horizontal] || 'start', v: consMap[node.constraints.vertical] || 'start' };
  if ('cornerRadius' in node) n.rad = mixed(node.cornerRadius) ? (node.topLeftRadius || 0) : (node.cornerRadius || 0);
  // sizing inside an auto layout parent
  if (node.layoutSizingHorizontal) n.sizeH = node.layoutSizingHorizontal.toLowerCase();
  if (node.layoutSizingVertical) n.sizeV = node.layoutSizingVertical.toLowerCase();
  if (node.layoutPositioning === 'ABSOLUTE') n.absPos = true;
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(k => { if (node[k] != null) n[{ minWidth: 'minW', maxWidth: 'maxW', minHeight: 'minH', maxHeight: 'maxH' }[k]] = node[k]; });
  if (node.reactions && node.reactions.length) {
    for (const r of node.reactions) {
      const acts = r.actions || (r.action ? [r.action] : []);
      if (!r.trigger || (r.trigger.type !== 'ON_CLICK' && r.trigger.type !== 'ON_PRESS')) continue;
      for (const a of acts) {
        if (a.type === 'BACK') { n.link = '__back'; break; }
        if (a.type === 'NODE' && a.destinationId) { LINKS.push([n, a.destinationId, a.navigation === 'OVERLAY' ? 'overlay' : 'navigate']); n.trans = a.transition ? (a.transition.type === 'DISSOLVE' ? 'dissolve' : /SLIDE|PUSH|MOVE/.test(a.transition.type) ? 'slide' : 'dissolve') : 'none'; break; }
      }
    }
  }
  stats.nodes++;
  return n;
}
function autoLayout(n, node) {
  if (!node.layoutMode || node.layoutMode === 'NONE') return;
  if (node.layoutMode === 'GRID') { WARN.add('Grid auto layout was converted to a wrapping row'); }
  const H = node.layoutMode !== 'VERTICAL';
  const hugMain = node.primaryAxisSizingMode === 'AUTO', hugCross = node.counterAxisSizingMode === 'AUTO';
  n.auto = { on: true, dir: H ? 'h' : 'v', gap: node.itemSpacing || 0, pad: node.paddingTop || 0, pt: node.paddingTop || 0, pr: node.paddingRight || 0, pb: node.paddingBottom || 0, pl: node.paddingLeft || 0,
    align: alignMap[node.counterAxisAlignItems] || 'start', just: justMap[node.primaryAxisAlignItems] || 'start',
    hugW: H ? hugMain : hugCross, hugH: H ? hugCross : hugMain, hug: false, rtl: false,
    wrap: node.layoutWrap === 'WRAP' || node.layoutMode === 'GRID', gap2: node.counterAxisSpacing != null ? node.counterAxisSpacing : undefined };
}

/* ---------- node conversion ---------- */
async function convert(node, ox, oy) {
  if (node.type === 'SLICE' || node.type === 'CONNECTOR' || node.type === 'STICKY' || node.type === 'WIDGET' || node.type === 'EMBED' || node.type === 'LINK_UNFURL') return null;
  try {
    switch (node.type) {
      case 'FRAME': case 'SECTION': case 'COMPONENT': case 'COMPONENT_SET': case 'INSTANCE': return await convertFrame(node, ox, oy);
      case 'GROUP': {
        const n = base(node, 'group', ox, oy);
        // group children are positioned relative to the group's parent in Figma; Vellum keeps them relative to the group
        const kids = await Promise.all(node.children.map(c => convert(c, ox + n.x, oy + n.y)));
        n.children = kids.filter(Boolean); return n;
      }
      case 'RECTANGLE': {
        const n = base(node, 'rect', ox, oy); const img = applyFills(n, node); applyStroke(n, node); applyEffects(n, node);
        if (img) return await imageNode(n, img);
        return n;
      }
      case 'ELLIPSE': {
        const n = base(node, 'ellipse', ox, oy); const img = applyFills(n, node); applyStroke(n, node); applyEffects(n, node);
        if (node.arcData && (node.arcData.endingAngle - node.arcData.startingAngle < 6.28 || node.arcData.innerRadius > 0)) return vectorNode(node, ox, oy);
        if (img) { const im = await imageNode(n, img); im.rad = Math.min(n.w, n.h) / 2; return im; }
        return n;
      }
      case 'LINE': {
        const n = base(node, 'line', ox, oy); applyStroke(n, node); n.h = 0; n.strokeOn = true; applyEffects(n, node);
        if (node.strokeCap === 'ARROW_LINES' || node.strokeCap === 'ARROW_EQUILATERAL') n.arrow = true;
        return n;
      }
      case 'POLYGON': case 'STAR': {
        const n = base(node, node.type === 'STAR' ? 'star' : 'polygon', ox, oy); applyFills(n, node); applyStroke(n, node); applyEffects(n, node);
        n.sides = node.pointCount || 5; if (node.type === 'STAR') n.inner = node.innerRadius != null ? node.innerRadius : .38;
        return n;
      }
      case 'VECTOR': case 'BOOLEAN_OPERATION': return vectorNode(node, ox, oy);
      case 'TEXT': return await textNode(node, ox, oy);
      default: WARN.add('Skipped unsupported layer type: ' + node.type); return null;
    }
  } catch (e) { WARN.add('A layer could not be converted (' + node.name + '): ' + e.message); return null; }
}
async function imageNode(n, paint) {
  const src = await imageData(paint.imageHash);
  const im = Object.assign({}, n, { type: 'image', src: src || '', fit: paint.scaleMode === 'FIT' ? 'fit' : paint.scaleMode === 'STRETCH' ? 'stretch' : 'fill', fillOn: !src, fill: '#d9d9d9' });
  if (paint.scaleMode === 'TILE') WARN.add('Tiled image fills became regular image fills');
  return im;
}
function vectorNode(node, ox, oy) {
  const n = base(node, 'bool', ox, oy);
  applyFills(n, node); applyStroke(n, node); applyEffects(n, node);
  let geo = [];
  try { geo = n.fillOn ? node.fillGeometry : []; } catch (e) { geo = []; }
  let d = geo.map(g => g.data).join(' ');
  let rule = (geo[0] && geo[0].windingRule === 'EVENODD') ? 'evenodd' : 'nonzero';
  if (!d) { // stroke-only vector: use its outline geometry, filled with the stroke color
    let sg = []; try { sg = node.strokeGeometry || []; } catch (e) { sg = []; }
    if (sg.length) { d = sg.map(g => g.data).join(' '); rule = 'nonzero'; n.fillOn = true; n.fill = n.stroke; n.strokeOn = false; }
  } else if (n.strokeOn) {
    // keep stroke as drawn outline on top of the fill
  }
  n.d = d; n.ox = 0; n.oy = 0; n.sx = 1; n.sy = 1; n.rule = rule;
  return n;
}
async function textNode(node, ox, oy) {
  const n = base(node, 'text', ox, oy);
  n.text = node.characters;
  let fontName = node.fontName, fontSize = node.fontSize, seg0 = null;
  if (mixed(fontName) || mixed(fontSize)) {
    try { seg0 = node.getStyledTextSegments(['fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fills'])[0]; } catch (e) { seg0 = null; }
    WARN.add('Text with mixed styles kept the style of its first run');
  }
  if (seg0) { fontName = seg0.fontName; fontSize = seg0.fontSize; }
  n.font = fontName.family; n.fs = fontSize; n.fw = (!mixed(node.fontWeight) && node.fontWeight) || weightFromStyle(fontName.style);
  n.italic = /italic|oblique/i.test(fontName.style);
  n.lh = lineHeight(seg0 ? seg0.lineHeight : node.lineHeight, fontSize);
  n.ls = letterSpacing(seg0 ? seg0.letterSpacing : node.letterSpacing, fontSize);
  const rtl = /[֐-׿؀-ۿ]/.test(n.text);
  const al = node.textAlignHorizontal;
  n.ta = al === 'CENTER' ? 'center' : al === 'RIGHT' ? (rtl ? 'start' : 'end') : al === 'LEFT' ? (rtl ? 'end' : 'start') : 'start';
  n.fixedW = node.textAutoResize !== 'WIDTH_AND_HEIGHT';
  n.fixedH = node.textAutoResize === 'NONE' || node.textAutoResize === 'TRUNCATE';
  n.va = { TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' }[node.textAlignVertical] || 'top';
  if (!mixed(node.textDecoration)) n.deco = node.textDecoration === 'UNDERLINE' ? 'underline' : node.textDecoration === 'STRIKETHROUGH' ? 'line-through' : '';
  if (!mixed(node.textCase)) n.upper = node.textCase === 'UPPER';
  const tmp = { fills: seg0 ? seg0.fills : node.fills, fillStyleId: node.fillStyleId };
  applyFills(n, mixed(node.fills) && seg0 ? Object.assign({}, node, { fills: seg0.fills }) : node);
  if (!n.fillOn) { n.fillOn = true; n.fill = '#000000'; }
  if (node.textStyleId && !mixed(node.textStyleId) && TSTYLE_BY_ID.has(node.textStyleId)) n.tstyle = TSTYLE_BY_ID.get(node.textStyleId);
  applyEffects(n, node);
  return n;
}
async function convertFrame(node, ox, oy) {
  const isComp = node.type === 'COMPONENT', isInst = node.type === 'INSTANCE';
  const n = base(node, isComp ? 'comp' : 'frame', ox, oy);
  const img = applyFills(n, node); applyStroke(n, node); applyEffects(n, node);
  n.clip = node.type === 'SECTION' ? false : !!node.clipsContent;
  autoLayout(n, node);
  if (node.type === 'COMPONENT_SET') { n.name = node.name; n.variantSet = true; }
  if (isComp && node.parent && node.parent.type === 'COMPONENT_SET') n.variant = node.name; // "Size=Large, State=Hover"
  if (isComp) stats.components++;
  if (node.layoutGrids && node.layoutGrids.length) {
    const g = node.layoutGrids.find(x => x.pattern === 'COLUMNS' && x.visible !== false);
    if (g) n.lgrid = { on: true, cols: g.count || 12, gutter: g.gutterSize || 20, margin: g.offset || 0 };
  }
  if (isInst) {
    stats.instances++;
    let main = null; try { main = await node.getMainComponentAsync(); } catch (e) { main = null; }
    const inFile = main && !main.remote;
    if (inFile) {
      n.type = 'inst'; n.master = vid(main.id);
      // overrides: compare instance children with the main component's children (same path ends with the main child id)
      n.ovr = [];
      const walk = inst => {
        for (const c of ('children' in inst ? inst.children : [])) {
          const srcFid = c.id.split(';').pop();
          if (c.type === 'TEXT') {
            n.ovr.push({ src: vid(srcFid), k: 'text', v: c.characters });
          }
          if (c.visible === false) n.ovr.push({ src: vid(srcFid), k: 'vis', v: false });
          if ('fills' in c && !mixed(c.fills)) { const p = c.fills.filter(x => x.visible !== false && x.type === 'SOLID').pop(); if (p) n.ovr.push({ src: vid(srcFid), k: 'fill', v: toHex(p.color) }); }
          walk(c);
        }
      };
      walk(node);
      if (img) WARN.add('Image fills on instances are not kept');
      return n; // children are rebuilt from the main component inside Vellum
    }
    WARN.add('Instances of library components were kept as frames (the library is not in this file)');
  }
  const kids = 'children' in node ? await Promise.all(node.children.map(c => convert(c, 0, 0))) : [];
  n.children = kids.filter(Boolean);
  if (img) { const bg = await imageNode(Object.assign({}, n, { id: 'n' + (SEQ++), name: n.name + ' image', x: 0, y: 0, rot: 0, children: [], auto: null, absPos: true, shadow: null, cons: { h: 'both', v: 'both' } }), img); n.children.unshift(bg); }
  return n;
}

/* ---------- run ---------- */
async function run(scope) {
  try {
    progress('Reading variables and styles…');
    await figma.loadAllPagesAsync();
    await readVariables(); await readPaintStyles(); await readTextStyles();
    const pages = [];
    const list = scope === 'page' || scope === 'selection' ? [figma.currentPage] : figma.root.children;
    for (const pg of list) {
      progress('Converting page “' + pg.name + '”…');
      const nodes = scope === 'selection' ? figma.currentPage.selection : pg.children;
      const conv = []; for (const c of nodes) { const v = await convert(c, scope === 'selection' ? c.absoluteTransform[0][2] - c.relativeTransform[0][2] : 0, scope === 'selection' ? c.absoluteTransform[1][2] - c.relativeTransform[1][2] : 0); if (v) conv.push(v); }
      const bgp = (pg.backgrounds || []).find(b => b.type === 'SOLID' && b.visible !== false);
      pages.push({ id: 'p' + pages.length, name: pg.name, bg: bgp ? toHex(bgp.color) : '', guides: [], nodes: conv });
    }
    // prototype links need every destination converted first
    for (const [n, dest, kind] of LINKS) { if (IDMAP.has(dest)) { n.link = IDMAP.get(dest); if (kind === 'overlay') n.overlay = true; } }
    const doc = { app: 'Vellum', format: 'vellum-doc', version: 1, source: 'figma', name: figma.root.name, seq: SEQ + 1, cur: 0, mode: 'light',
      styles: STYLES, tstyles: TSTYLES, comments: [], pages };
    const json = JSON.stringify(doc);
    figma.ui.postMessage({ type: 'done', name: figma.root.name, json, stats, warnings: [...WARN], sizeMB: Math.round(json.length / 1048576 * 10) / 10, variables: STYLES.length, textStyles: TSTYLES.length });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', text: String(e && e.message || e) });
  }
}
figma.ui.onmessage = msg => { if (msg.type === 'export') run(msg.scope); if (msg.type === 'close') figma.closePlugin(); };
