// Vellum desktop: window, local SQLite database, installed fonts, and a local command port for the MCP connector.
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

app.setName('Vellum');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let win = null;
let db = null;
let dbPath = '';
let saveTimer = null;
let closing = false;
const pending = new Map();

/* ---------- database (SQLite file in the user's app data folder) ---------- */
async function openDb() {
  const SQL = await initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f) });
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'vellum.db');
  db = null;
  if (fs.existsSync(dbPath)) {
    try { db = new SQL.Database(fs.readFileSync(dbPath)); db.exec('SELECT count(*) FROM sqlite_master'); }
    catch (e) { // damaged database: keep it aside and restore the newest backup
      try { fs.copyFileSync(dbPath, dbPath + '.damaged-' + Date.now()); } catch (_) {}
      db = null;
      const bdir = path.join(dir, 'backups');
      const last = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => f.endsWith('.db')).sort().pop() : null;
      if (last) { try { db = new SQL.Database(fs.readFileSync(path.join(bdir, last))); } catch (_) { db = null; } }
    }
  }
  if (!db) db = new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, updated INTEGER, created INTEGER, folder TEXT, star INTEGER, trashed INTEGER, thumb TEXT, json TEXT);
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
  writeNow();
  dailyBackup();
}
let waiters = [];
// Resolves only after the data is on disk, so the app never reports "saved" too early.
function persist() {
  clearTimeout(saveTimer);
  const p = new Promise((res, rej) => waiters.push({ res, rej }));
  saveTimer = setTimeout(() => { try { writeNow(); } catch (e) { /* reported through the waiters */ } }, 250);
  return p;
}
function writeNow() {
  clearTimeout(saveTimer);
  const ws = waiters; waiters = [];
  if (!db) { ws.forEach(w => w.res(true)); return; }
  try {
    const tmp = dbPath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, Buffer.from(db.export()));
    fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, dbPath); // atomic replace: a crash never leaves a half-written database
    ws.forEach(w => w.res(true));
  } catch (e) {
    console.error('save failed', e);
    ws.forEach(w => w.rej(e));
    throw e;
  }
}
function dailyBackup() {
  try {
    const dir = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'vellum-' + new Date().toISOString().slice(0, 10) + '.db';
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) fs.copyFileSync(dbPath, target);
    const all = fs.readdirSync(dir).filter(f => f.startsWith('vellum-') && f.endsWith('.db')).sort();
    while (all.length > 14) fs.unlinkSync(path.join(dir, all.shift()));
  } catch (e) { console.error('backup failed', e); }
}
function rows(sql, params = []) {
  const st = db.prepare(sql); st.bind(params); const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free(); return out;
}
function listFiles() {
  return rows('SELECT id,name,updated,created,folder,star,trashed,thumb FROM files').map(r => ({ ...r, star: !!r.star, trashed: !!r.trashed, folder: r.folder || null }));
}

/* Security: every bridge call must come from Vellum's own page, never from another frame or a navigated page */
const APP_PAGE = () => require('url').pathToFileURL(path.join(__dirname, 'app', 'index.html')).href;
const _handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => _handle(ch, (e, ...a) => { const u = e.senderFrame && e.senderFrame.url; if (!u || u.split('#')[0].split('?')[0] !== APP_PAGE() || (win && e.sender !== win.webContents)) throw new Error('Blocked: request did not come from Vellum'); return fn(e, ...a); });
ipcMain.handle('db:list', () => listFiles());
ipcMain.handle('db:load', (e, id) => (rows('SELECT json FROM files WHERE id=?', [String(id)])[0] || {}).json || null);
ipcMain.handle('db:save', (e, id, json, rec) => {
  db.run('INSERT OR REPLACE INTO files(id,name,updated,created,folder,star,trashed,thumb,json) VALUES(?,?,?,?,?,?,?,?,?)',
    [String(id), String(rec.name || 'Untitled'), +rec.updated || Date.now(), +rec.created || Date.now(), rec.folder || null, rec.star ? 1 : 0, rec.trashed ? 1 : 0, String(rec.thumb || ''), String(json)]);
  return persist();
});
ipcMain.handle('db:remove', (e, id) => { db.run('DELETE FROM files WHERE id=?', [String(id)]); return persist(); });
ipcMain.handle('db:getFolders', () => { const r = rows("SELECT value FROM meta WHERE key='folders'")[0]; try { return r ? JSON.parse(r.value) : []; } catch (e) { return []; } });
ipcMain.handle('db:setFolders', (e, list) => { db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('folders',?)", [JSON.stringify(list || [])]); return persist(); });
ipcMain.handle('db:flush', () => { writeNow(); return true; });

/* ---------- files, fonts, Claude connection ---------- */
ipcMain.handle('file:save', async (e, name, data) => {
  const safe = path.basename(String(name || 'export')).replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120) || 'export';
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), safe) });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
  return true;
});
ipcMain.handle('fonts:list', async () => {
  try { const fl = require('font-list'); const f = await fl.getFonts({ disableQuoting: true }); return [...new Set(f)].sort((a, b) => a.localeCompare(b)); }
  catch (e) { return []; }
});
function claudeConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || app.getPath('appData'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(app.getPath('home'), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(app.getPath('home'), '.config', 'Claude', 'claude_desktop_config.json');
}
function mcpEntry() {
  return { command: process.execPath, args: [path.join(app.getAppPath(), 'mcp-server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
ipcMain.handle('claude:connect', () => {
  const p = claudeConfigPath();
  let cfg = {};
  try { if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { ok: false, error: 'Claude Desktop settings file could not be read: ' + e.message }; }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.vellum = mcpEntry();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.before-vellum');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return { ok: true, path: p };
});
ipcMain.handle('claude:codeCommand', () => {
  const e = mcpEntry();
  const q = s => '"' + s + '"';
  return process.platform === 'win32'
    ? `claude mcp add vellum --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${q(e.command)} ${q(e.args[0])}`
    : `claude mcp add vellum --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${q(e.command)} ${q(e.args[0])}`;
});

/* ---------- AI models: Claude, Gemini, Grok, GPT, OpenRouter and local models, with your own keys ---------- */
const { safeStorage, net } = require('electron');
const PROVIDERS = {
  anthropic: { name: 'Claude (API key)', kind: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  openai: { name: 'GPT (OpenAI)', kind: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-5' },
  gemini: { name: 'Gemini (Google)', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  xai: { name: 'Grok (xAI)', kind: 'openai', base: 'https://api.x.ai/v1', model: 'grok-4' },
  openrouter: { name: 'OpenRouter (any model)', kind: 'openai', base: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  ollama: { name: 'Local model (Ollama)', kind: 'openai', base: 'http://127.0.0.1:11434/v1', model: 'llama3.1', noKey: true }
};
function localBase(u) { try { const x = new URL(String(u)); if (!/^https?:$/.test(x.protocol)) return null; const h = x.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h)) return x.origin + x.pathname.replace(/\/+$/, ''); } catch (e) { } return null; }
const keysPath = () => path.join(app.getPath('userData'), 'ai-keys.json');
function readKeys() { try { const raw = JSON.parse(fs.readFileSync(keysPath(), 'utf8')); const out = {}; for (const k in raw) { try { out[k] = { ...raw[k], key: raw[k].key ? (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw[k].key, 'base64')) : Buffer.from(raw[k].key, 'base64').toString()) : '' }; } catch (e) { } } return out; } catch (e) { return {}; } }
function writeKeys(all) { const raw = {}; for (const k in all) raw[k] = { ...all[k], key: all[k].key ? (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(all[k].key) : Buffer.from(all[k].key)).toString('base64') : '' }; fs.writeFileSync(keysPath(), JSON.stringify(raw), { mode: 0o600 }); try { fs.chmodSync(keysPath(), 0o600); } catch (e) { } }
ipcMain.handle('ai:status', () => { const k = readKeys(); return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, defaultModel: p.model, model: (k[id] && k[id].model) || p.model, base: (k[id] && k[id].base) || p.base, configured: !!(k[id] && (k[id].key || (p.noKey && k[id].enabled))), noKey: !!p.noKey })); });
ipcMain.handle('ai:save', (e, id, cfg) => { if (!PROVIDERS[id]) return false; const all = readKeys(); const cur = all[id] || {}; all[id] = { key: cfg.key != null ? String(cfg.key) : cur.key || '', model: String(cfg.model || cur.model || PROVIDERS[id].model), base: PROVIDERS[id].noKey ? (localBase(cfg.base || cur.base) || PROVIDERS[id].base) : PROVIDERS[id].base, enabled: cfg.enabled !== false }; if (cfg.remove) delete all[id]; writeKeys(all); return true; });
async function httpJSON(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(180000) });
  const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { }
  if (!res.ok) { const msg = (j && (j.error && (j.error.message || j.error) || j.message)) || txt.slice(0, 300); const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); err.status = res.status; throw err; }
  return j;
}
ipcMain.handle('ai:models', async (e, id) => {
  const p = PROVIDERS[id]; const k = readKeys()[id] || {}; if (!p) return [];
  try {
    if (p.kind === 'anthropic') { const j = await httpJSON(p.base + '/models', { headers: { 'x-api-key': k.key, 'anthropic-version': '2023-06-01' } }); return (j.data || []).map(m => m.id); }
    const j = await httpJSON((k.base || p.base) + '/models', { headers: k.key ? { Authorization: 'Bearer ' + k.key } : {} }); return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).slice(0, 300);
  } catch (err) { return { error: err.message }; }
});
// conv: provider-neutral transcript [{role:'user'|'assistant'|'tool', text, toolCalls:[{id,name,input}], results:[{id,name,content}]}]
ipcMain.handle('ai:chat', async (e, req) => {
  const p = PROVIDERS[req.provider]; if (!p) return { error: 'Unknown model provider' };
  const k = readKeys()[req.provider] || {}; if (!p.noKey && !k.key) return { error: 'Add an API key for ' + p.name + ' first (AI models settings).' };
  if (!req || !Array.isArray(req.conv) || JSON.stringify(req).length > 40e6) return { error: 'Request too large' };
  const model = String(req.model || k.model || p.model).slice(0, 200); const tools = Array.isArray(req.tools) ? req.tools.slice(0, 40) : [];
  try {
    if (p.kind === 'anthropic') {
      const messages = [];
      for (const m of req.conv) {
        if (m.role === 'user') messages.push({ role: 'user', content: (m.images || []).length ? [...m.images.map(u => { const mm = /^data:([^;]+);base64,(.*)$/.exec(u) || []; return { type: 'image', source: { type: 'base64', media_type: mm[1] || 'image/png', data: mm[2] || '' } }; }), { type: 'text', text: m.text || '(empty)' }] : (m.text || '(empty)') });
        else if (m.role === 'assistant') messages.push({ role: 'assistant', content: [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.toolCalls || []).map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} }))].concat(!m.text && !(m.toolCalls || []).length ? [{ type: 'text', text: '(no reply)' }] : []) });
        else if (m.role === 'tool') messages.push({ role: 'user', content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
      }
      const j = await httpJSON(p.base + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 8192, system: req.system, messages, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema || { type: 'object', properties: {} } })) }) });
      const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const toolCalls = (j.content || []).filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name, input: c.input }));
      return { text, toolCalls, model: j.model || model };
    }
    const messages = [{ role: 'system', content: req.system }];
    for (const m of req.conv) {
      if (m.role === 'user') messages.push({ role: 'user', content: (m.images || []).length ? [{ type: 'text', text: m.text || '(empty)' }, ...m.images.map(u => ({ type: 'image_url', image_url: { url: u } }))] : (m.text || '(empty)') });
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.text || null, ...((m.toolCalls || []).length ? { tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } })) } : {}) });
      else if (m.role === 'tool') m.results.forEach(r => messages.push({ role: 'tool', tool_call_id: r.id, content: r.content }));
    }
    const headers = { 'content-type': 'application/json', ...(k.key ? { Authorization: 'Bearer ' + k.key } : {}) };
    if (req.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://vellum.local'; headers['X-Title'] = 'Vellum'; }
    const j = await httpJSON((k.base || p.base) + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages, ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema || { type: 'object', properties: {} } } })) } : {}) }) });
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const toolCalls = (msg.tool_calls || []).map((t, i) => { let input = {}; try { input = JSON.parse(t.function.arguments || '{}'); } catch (e) { } return { id: t.id || ('call_' + Date.now() + '_' + i), name: t.function.name, input }; });
    return { text: typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '', toolCalls, model: j.model || model };
  } catch (err) {
    const s = err.status; const hint = !s && req.provider === 'ollama' ? 'Could not reach the local model server. Is Ollama running?' : !s ? 'Could not reach ' + p.name + '. Check the internet connection.' : s === 401 || s === 403 ? 'The API key was rejected.' : s === 429 ? 'Rate limit or out of credits/tokens for this model. Switch to another model in the chat and continue.' : s === 404 ? 'Model not found. Pick another model name.' : '';
    return { error: (hint ? hint + ' ' : '') + err.message, status: s };
  }
});

/* ---------- local command port used by the MCP connector (127.0.0.1 only, token protected) ---------- */
function startCommandPort() {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const got = Buffer.from(String(req.headers['x-vellum-token'] || '')), want = Buffer.from(token);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/cmd') return send(404, { error: 'not found' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', async () => {
      let msg; try { msg = JSON.parse(body); } catch (e) { return send(400, { error: 'bad json' }); }
      if (msg.tool === 'list_files') return send(200, { ok: true, result: listFiles().map(({ thumb, ...r }) => r) });
      if (!win || win.isDestroyed()) return send(503, { error: 'Vellum window is not open' });
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); send(504, { error: 'Vellum did not answer in time' }); }, 120000);
      pending.set(id, r => { clearTimeout(timer); send(200, r); });
      win.webContents.send('vellum-cmd', { id, tool: msg.tool, args: msg.args || {} });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    fs.writeFileSync(path.join(app.getPath('userData'), 'mcp.json'), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
    try { fs.chmodSync(path.join(app.getPath('userData'), 'mcp.json'), 0o600); } catch (e) { }
  });
}
ipcMain.on('vellum-cmd-result', (e, r) => { if (!win || e.sender !== win.webContents || !r) return; const f = pending.get(r.id); if (f) { pending.delete(r.id); f(r); } });

/* ---------- automatic updates: installed copies download new versions from the GitHub releases and install them on restart ---------- */
function startUpdates() {
  if (!app.isPackaged) return;
  let au; try { au = require('electron-updater').autoUpdater; } catch (e) { return; }
  au.autoDownload = true; au.autoInstallOnAppQuit = true;
  au.on('update-downloaded', info => { if (win && !win.isDestroyed()) win.webContents.send('vellum-update', { version: info.version }); });
  au.on('error', () => { });
  const check = () => au.checkForUpdates().catch(() => { });
  setTimeout(check, 8000); setInterval(check, 4 * 3600 * 1000);
  ipcMain.handle('update:install', () => { au.quitAndInstall(false, true); return true; });
}

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Vellum', backgroundColor: '#1e1e1e', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // the window only ever shows the editor: links open in the browser, dropped files never replace the page
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', e => {
    if (closing) return;
    e.preventDefault();
    const flush = win.webContents.executeJavaScript('window.__vellumFlush ? window.__vellumFlush() : null', true).catch(() => {});
    Promise.race([flush, new Promise(r => setTimeout(r, 3000))]).finally(() => { closing = true; try { writeNow(); } catch (e) {} win.close(); });
  });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'fullscreen'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ['clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'fullscreen'].includes(perm));
  await openDb();
  startCommandPort();
  startUpdates();
  createWindow();
});
app.on('window-all-closed', () => { try { writeNow(); } catch (e) {} app.quit(); });
