import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { EditorStore, addMediaAsset } from '@freemier/engine';
import { LiveBridge } from '@freemier/mcp';
import { importMedia, exportProject } from '@freemier/ffmpeg';

/**
 * Electron main process.
 *
 * Modes:
 *  - VIEWER (default when an agent's bridge is already listening): the GUI is a
 *    pure view onto the MCP server's store. Agent edits appear live.
 *  - STANDALONE (no bridge found): the GUI runs its own store + bridge so the
 *    editor is still fully usable with no agent attached.
 *
 * The GUI never owns a second copy of the timeline when a bridge exists —
 * two independent stores would silently diverge, which would make "live sync"
 * a lie.
 */

const WORKSPACE = process.env.FREEMIER_WORKSPACE ?? path.join(os.homedir(), '.freemier');
const PREFERRED_PORT = Number(process.env.FREEMIER_BRIDGE_PORT ?? 4317);

let mainWindow: BrowserWindow | null = null;
let ownBridge: LiveBridge | null = null;
let ownStore: EditorStore | null = null;
let bridgePort = PREFERRED_PORT;
let viewerMode = false;
let mcpStdioAttached = false;
let owningWorkspace = WORKSPACE;
// Native dialog selection is the only test substitution. Editing/rendering/export stay real.
const testDialogs = process.env.FREEMIER_TEST_MODE === '1'
  ? JSON.parse(process.env.FREEMIER_TEST_DIALOGS ?? '{}') as { media?: string[]; output?: string; project?: string; preset?: string; presetOutput?: string }
  : null;

/** Probe whether a bridge is already listening on the preferred port. */
async function probeBridge(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const info = await res.json() as { app?: string; workspace?: string };
    if (info.app !== 'freemier-pro') return false;
    owningWorkspace = info.workspace ?? WORKSPACE;
    return true;
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  await fs.mkdir(WORKSPACE, { recursive: true });
  if (await probeBridge(PREFERRED_PORT)) {
    // An agent's MCP server is already running — attach as a viewer.
    viewerMode = true;
    bridgePort = PREFERRED_PORT;
    process.stdout.write(`[freemier] viewer mode — attached to bridge on ${bridgePort}\n`);
  } else {
    // No agent attached: host our own store so the editor still works.
    ownStore = EditorStore.create({ name: 'Untitled Project', fps: 30, width: 1920, height: 1080 });
    ownBridge = new LiveBridge({ store: ownStore, workspace: WORKSPACE, port: PREFERRED_PORT });
    bridgePort = await ownBridge.start();
    process.stdout.write(`[freemier] standalone mode — bridge on ${bridgePort}\n`);
  }

  // Optionally expose this GUI's store over stdio MCP (rarely needed; agents
  // normally spawn their own server).
  if (process.env.FREEMIER_MCP_STDIO === '1' && ownStore && !mcpStdioAttached) {
    mcpStdioAttached = true;
    const { createServer } = await import('@freemier/mcp');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { server } = createServer({ workspace: WORKSPACE, store: ownStore });
    await server.connect(new StdioServerTransport());
    process.stderr.write('[freemier] MCP attached on stdio\n');
  }

  createWindow(bridgePort, viewerMode);
}

function createWindow(port: number, viewer: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e0f13',
    show: process.env.FREEMIER_TEST_MODE !== '1',
    title: viewer ? 'FreeMier Pro — live' : 'FreeMier Pro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const query = { bridge: String(port), mode: viewer ? 'viewer' : 'standalone' };
  const devUrl = process.env.FREEMIER_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(`${devUrl}?bridge=${port}&mode=${query.mode}`);
  } else {
    void mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'), { query });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- IPC -----------------------------------------------------------------

/** Latest state the renderer reported, for automated live-sync verification. */
let lastRendererState: Record<string, unknown> | null = null;

ipcMain.on('renderer:state', (_e, snapshot) => { lastRendererState = snapshot as Record<string, unknown>; });

ipcMain.handle('renderer:get-state', () => lastRendererState);

// CDP screenshot capture can stall for hidden Windows windows. Capture the
// same production webContents without exposing filesystem access to the page.
if (testDialogs) ipcMain.handle('test:capture-page', async () => {
  if (!mainWindow) throw new Error('No editor window');
  const image = await mainWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  if (image.isEmpty()) throw new Error('Editor capture is empty');
  return image.toPNG().toString('base64');
});

/** Ask the renderer to report its state right now, and wait for the reply. */
ipcMain.handle('renderer:request-state', async () => {
  if (!mainWindow) return null;
  lastRendererState = null;
  mainWindow.webContents.send('renderer:check');
  const deadline = Date.now() + 4000;
  while (!lastRendererState && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
  }
  return lastRendererState;
});

ipcMain.handle('app:info', () => ({
  workspace: owningWorkspace,
  bridgePort,
  viewerMode,
}));

/** Import media. In viewer mode this is applied by the owning bridge instead. */
ipcMain.handle('media:import', async (_e, paths: string[]) => {
  if (viewerMode || !ownStore) {
    const imported = [];
    for (const p of paths) {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'media_import', path: p }),
      });
      const body = await res.json() as { ok: boolean; asset?: { id: string } };
      if (!body.ok) return body;
      imported.push(body.asset?.id);
    }
    return { ok: true, imported };
  }
  const imported = [];
  for (const p of paths) {
    try {
      const asset = await importMedia(p);
      addMediaAsset(ownStore, asset);
      imported.push(asset.id);
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, error: { code: 'IMPORT_ERROR', message: e.message ?? String(err) } };
    }
  }
  return { ok: true, imported };
});

ipcMain.handle('export:run', async (_e, outputPath?: string, captionPolicy?: 'burn-in' | 'none' | 'sidecar') => {
  const out = outputPath ?? path.join(owningWorkspace, `export-${Date.now()}.mp4`);
  try {
    if (viewerMode) {
      // Export the timeline the agent actually sees.
      const res = await fetch(`http://127.0.0.1:${bridgePort}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputPath: out, captionPolicy }),
      });
      const body = await res.json() as { ok?: boolean; error?: { message?: string } };
      return body;
    }
    if (!ownStore) throw new Error('no store');
    mainWindow?.webContents.send('export:progress', { fraction: 0, outputPath: out });
    const result = await exportProject(ownStore.project, {
      outputPath: out,
      mediaDirectory: path.join(owningWorkspace, 'media'),
      captionPolicy,
      onProgress: (fraction) => mainWindow?.webContents.send('export:progress', { fraction, outputPath: out }),
    });
    return { ok: true, ...result };
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: unknown };
    return { ok: false, error: { code: e.code ?? 'EXPORT_ERROR', message: e.message ?? String(err), details: e.details } };
  }
});

ipcMain.handle('dialog:save', async () => {
  if (testDialogs) return testDialogs.output ?? null;
  const result = await dialog.showSaveDialog({
    title: 'Export video',
    defaultPath: path.join(owningWorkspace, `export-${Date.now()}.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:pickMedia', async () => {
  if (testDialogs) return testDialogs.media ?? [];
  const result = await dialog.showOpenDialog({
    title: 'Import media', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'ogg', 'png', 'jpg', 'jpeg', 'webp'] }, { name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:saveProject', async () => {
  if (testDialogs) return testDialogs.project ?? null;
  const result = await dialog.showSaveDialog({ title: 'Save FreeMier project', defaultPath: path.join(owningWorkspace, 'Edit.freemier'), filters: [{ name: 'FreeMier project directory', extensions: ['freemier'] }] });
  return result.canceled ? null : result.filePath;
});
ipcMain.handle('dialog:openProject', async () => {
  if (testDialogs) return testDialogs.project ?? null;
  const result = await dialog.showOpenDialog({ title: 'Open .freemier or legacy .palmier project', properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('dialog:pickPreset', async () => {
  if (testDialogs) return testDialogs.preset ?? null;
  const result = await dialog.showOpenDialog({ title: 'Import FreeMier effect preset (.fmfx.json)', properties: ['openFile'], filters: [{ name: 'FreeMier effect preset JSON', extensions: ['json'] }] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('dialog:savePreset', async () => {
  if (testDialogs) return testDialogs.presetOutput ?? null;
  const result = await dialog.showSaveDialog({ title: 'Export FreeMier effect preset (new file)', defaultPath: path.join(owningWorkspace, 'Preset.fmfx.json'), filters: [{ name: 'FreeMier effect preset JSON', extensions: ['json'] }] });
  return result.canceled ? null : result.filePath;
});

app.whenReady().then(boot).catch((err) => {
  process.stderr.write(`[freemier] boot failed: ${err}\n`);
  app.quit();
});

app.on('window-all-closed', () => {
  void ownBridge?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(bridgePort, viewerMode);
});
