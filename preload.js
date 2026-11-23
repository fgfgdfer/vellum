// Bridge between the editor page and the desktop app. The page checks for window.vellum to know it runs on the desktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vellum', {
  platform: process.platform,
  list: () => ipcRenderer.invoke('db:list'),
  load: id => ipcRenderer.invoke('db:load', id),
  save: (id, json, rec) => ipcRenderer.invoke('db:save', id, json, rec),
  remove: id => ipcRenderer.invoke('db:remove', id),
  getFolders: () => ipcRenderer.invoke('db:getFolders'),
  setFolders: list => ipcRenderer.invoke('db:setFolders', list),
  flush: () => ipcRenderer.invoke('db:flush'),
  saveFile: (name, data) => ipcRenderer.invoke('file:save', name, data),
  fonts: () => ipcRenderer.invoke('fonts:list'),
  connectClaude: () => ipcRenderer.invoke('claude:connect'),
  saveImages: pairs => ipcRenderer.invoke('img:save', pairs),
  loadImages: ids => ipcRenderer.invoke('img:load', ids),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSave: (id, cfg) => ipcRenderer.invoke('ai:save', id, cfg),
  aiModels: id => ipcRenderer.invoke('ai:models', id),
  aiChat: req => ipcRenderer.invoke('ai:chat', req),
  claudeCodeCommand: () => ipcRenderer.invoke('claude:codeCommand'),
  onUpdate: fn => ipcRenderer.on('vellum-update', (e, info) => fn(info)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onCommand: fn => {
    ipcRenderer.on('vellum-cmd', async (e, msg) => {
      try { const result = await fn(msg.tool, msg.args || {}); ipcRenderer.send('vellum-cmd-result', { id: msg.id, ok: true, result }); }
      catch (err) { ipcRenderer.send('vellum-cmd-result', { id: msg.id, ok: false, error: String((err && err.message) || err) }); }
    });
  }
});
