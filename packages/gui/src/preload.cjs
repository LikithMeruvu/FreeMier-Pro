const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload. Exposes a narrow, explicit API — no raw ipcRenderer,
 * no Node access in the renderer.
 */
contextBridge.exposeInMainWorld('palmier', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  importMedia: (paths) => ipcRenderer.invoke('media:import', paths),
  runExport: (outputPath) => ipcRenderer.invoke('export:run', outputPath),
  pickExportPath: () => ipcRenderer.invoke('dialog:save'),
  pickMedia: () => ipcRenderer.invoke('dialog:pickMedia'),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_event, progress) => cb(progress)),

  /** Report renderer state so an automated check can verify live sync. */
  reportState: (snapshot) => ipcRenderer.send('renderer:state', snapshot),
  onCheckState: (cb) => ipcRenderer.on('renderer:check', () => cb()),
});
