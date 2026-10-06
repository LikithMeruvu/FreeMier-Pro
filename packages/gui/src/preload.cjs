const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload. Exposes a narrow, explicit API — no raw ipcRenderer,
 * no Node access in the renderer.
 */
const api = {
  getInfo: () => ipcRenderer.invoke('app:info'),
  importMedia: (paths) => ipcRenderer.invoke('media:import', paths),
  runExport: (outputPath, captionPolicy) => ipcRenderer.invoke('export:run', outputPath, captionPolicy),
  pickExportPath: () => ipcRenderer.invoke('dialog:save'),
  pickMedia: () => ipcRenderer.invoke('dialog:pickMedia'),
  pickProjectSavePath: () => ipcRenderer.invoke('dialog:saveProject'),
  pickProjectOpenPath: () => ipcRenderer.invoke('dialog:openProject'),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_event, progress) => cb(progress)),

  /** Report renderer state so an automated check can verify live sync. */
  reportState: (snapshot) => ipcRenderer.send('renderer:state', snapshot),
  onCheckState: (cb) => ipcRenderer.on('renderer:check', () => cb()),
};
if (process.env.FREEMIER_TEST_MODE === '1') api.captureForTest = () => ipcRenderer.invoke('test:capture-page');
contextBridge.exposeInMainWorld('freemier', api);
contextBridge.exposeInMainWorld('palmier', api); // Existing client compatibility.
