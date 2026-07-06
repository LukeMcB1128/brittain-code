// Bridge between the UI (renderer) and main process. Keep this thin.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listModels: () => ipcRenderer.invoke('models:list'),
  pickCwd: () => ipcRenderer.invoke('cwd:pick'),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  stop: () => ipcRenderer.send('chat:stop'),
  reset: () => ipcRenderer.invoke('chat:reset'),
  respondApproval: (id, approved) => ipcRenderer.send('approval:response', { id, approved }),

  onToken: (cb) => ipcRenderer.on('stream:token', (_e, t) => cb(t)),
  onToolCall: (cb) => ipcRenderer.on('stream:toolcall', (_e, d) => cb(d)),
  onToolResult: (cb) => ipcRenderer.on('stream:toolresult', (_e, d) => cb(d)),
  onStats: (cb) => ipcRenderer.on('stream:stats', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('stream:done', () => cb()),
  onApprovalRequest: (cb) => ipcRenderer.on('approval:request', (_e, d) => cb(d)),
});
