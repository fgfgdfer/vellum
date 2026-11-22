// Vellum desktop: window, local SQLite database, installed fonts, and a local command port for the MCP connector.
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

app.setName('Vellum');
if (!app.requestSingleInstanceLock()) { app.quit(); }

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
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, updated INTEGER, created INTEGER, folder TEXT, star INTEGER, trashed INTEGER, thumb TEXT, json TEXT);
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
  writeNow();
  dailyBackup();
}
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 250); }
function writeNow() {
  clearTimeout(saveTimer);
  if (!db) return;
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbPath); // atomic replace: a crash never leaves a half-written database
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

ipcMain.handle('db:list', () => listFiles());
ipcMain.handle('db:load', (e, id) => (rows('SELECT json FROM files WHERE id=?', [String(id)])[0] || {}).json || null);
ipcMain.handle('db:save', (e, id, json, rec) => {
  db.run('INSERT OR REPLACE INTO files(id,name,updated,created,folder,star,trashed,thumb,json) VALUES(?,?,?,?,?,?,?,?,?)',
    [String(id), String(rec.name || 'Untitled'), +rec.updated || Date.now(), +rec.created || Date.now(), rec.folder || null, rec.star ? 1 : 0, rec.trashed ? 1 : 0, String(rec.thumb || ''), String(json)]);
  persist(); return true;
});
ipcMain.handle('db:remove', (e, id) => { db.run('DELETE FROM files WHERE id=?', [String(id)]); persist(); return true; });
ipcMain.handle('db:getFolders', () => { const r = rows("SELECT value FROM meta WHERE key='folders'")[0]; try { return r ? JSON.parse(r.value) : []; } catch (e) { return []; } });
ipcMain.handle('db:setFolders', (e, list) => { db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('folders',?)", [JSON.stringify(list || [])]); persist(); return true; });
ipcMain.handle('db:flush', () => { writeNow(); return true; });

/* ---------- files, fonts, Claude connection ---------- */
ipcMain.handle('file:save', async (e, name, data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name)) });
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

/* ---------- local command port used by the MCP connector (127.0.0.1 only, token protected) ---------- */
function startCommandPort() {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-vellum-token'] !== token) return send(401, { error: 'unauthorized' });
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
    fs.writeFileSync(path.join(app.getPath('userData'), 'mcp.json'), JSON.stringify({ port, token, pid: process.pid }));
  });
}
ipcMain.on('vellum-cmd-result', (e, r) => { const f = pending.get(r.id); if (f) { pending.delete(r.id); f(r); } });

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Vellum', backgroundColor: '#1e1e1e', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: true }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', e => {
    if (closing) return;
    e.preventDefault();
    win.webContents.executeJavaScript('window.__vellumFlush ? window.__vellumFlush() : null', true)
      .catch(() => {}).finally(() => { closing = true; writeNow(); win.close(); });
  });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'fullscreen'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ['clipboard-read', 'clipboard-sanitized-write', 'local-fonts', 'fullscreen'].includes(perm));
  await openDb();
  startCommandPort();
  createWindow();
});
app.on('window-all-closed', () => { writeNow(); app.quit(); });
