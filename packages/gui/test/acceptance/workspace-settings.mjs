/** Actual Electron acceptance for persistent, service-owned workspace layouts. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const electron = createRequire(import.meta.url)('electron'), execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, fn, timeout = 30000, interval = 100) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`Timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
const workspace = await fs.mkdtemp(path.join(root, '.tmp', 'workspace-settings-'));
const port = await freePort(), bridge = `http://127.0.0.1:${port}`;
const debugPort = await freePort(), projectPath = path.join(workspace, 'Workspace acceptance.freemier');
const sourcePath = path.join(workspace, 'synthetic-red-tone.mp4'), outputPath = path.join(workspace, 'workspace-export.mp4');
const settingsPath = path.join(workspace, 'settings', 'workspace.json');
const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1', FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, output: outputPath }) };
delete env.ELECTRON_RUN_AS_NODE;
let client, transport, child, socket, log = '';

async function startService() {
  client = new Client({ name: 'workspace-settings-electron-acceptance', version: '1' });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/mcp/dist/cli.js')], env });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const value = JSON.parse(response.content[0].text);
    if (response.isError) throw new Error(value.error?.message ?? `${name} failed`);
    return value;
  };
  return call;
}

async function startGui() {
  child = spawn(electron, [path.join(root, 'packages/gui'), `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
  const target = await waitFor('Electron page', async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((entry) => entry.type === 'page' && entry.url.includes('renderer/index.html')));
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(); const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const click = async (selector) => {
    await waitFor(`visible enabled ${selector}`, () => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el&&!el.disabled&&el.getClientRects().length>0})()`));
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const set = (selector, property, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el[${JSON.stringify(property)}]=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state = async () => (await (await fetch(bridge + '/state')).json());
  return { child, socket, send, evaluate, click, set, state, errors };
}

async function stopGui(gui) {
  gui?.socket?.close();
  if (gui?.child && gui.child.exitCode === null) {
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(gui.child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else gui.child.kill();
    await Promise.race([new Promise((resolve) => gui.child.once('exit', resolve)), sleep(4000)]);
    if (gui.child.exitCode === null) gui.child.kill('SIGKILL');
  }
  if (child === gui?.child) child = null;
  if (socket === gui?.socket) socket = null;
}
async function stopService() {
  if (!client) return;
  const previous = client; client = null; transport = null;
  await previous.close().catch(() => {});
}
async function waitBridgeDown() {
  await waitFor('bridge shutdown before service restart', async () => {
    try { return !(await fetch(bridge + '/health')).ok; } catch { return true; }
  }, 15000);
}
const snapshotOf = (result) => result.workspaceSettings ?? result.data?.workspaceSettings;

try {
  await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath], { windowsHide: true });
  let call = await startService();
  await waitFor('bridge startup', async () => (await fetch(bridge + '/health')).ok);
  await call('project_create', { name: 'Workspace preferences acceptance', width: 320, height: 180, fps: 30 });
  const asset = (await call('media_import', { path: sourcePath, copyIntoProject: true })).asset;
  const tracks = (await call('timeline_inspect')).tracks, videoTrack = tracks.find((track) => track.kind === 'video'), audioTrack = tracks.find((track) => track.kind === 'audio');
  const clip = (await call('clip_add', { trackId: videoTrack.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 5, strict: true })).clip;
  await call('clip_add', { trackId: audioTrack.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 5, strict: true });
  const gui = await startGui();
  await waitFor('initial settings snapshot and project paint', async () => {
    const state = await gui.state();
    return state.workspaceSettings?.current?.mode === 'edit' && await gui.evaluate(`Number(document.querySelector('#revision').textContent.replace('rev ',''))===${state.revision}`);
  });
  await waitFor('decoded synthetic program frame', () => gui.evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')];return v.length===1&&v[0].readyState>=2&&!v[0].seeking&&Number(document.querySelector('#program-canvas').dataset.paintedTime)===0})()`));
  const pixelAtProgram = () => gui.evaluate(`(()=>{const c=document.querySelector('#program-canvas'),p=c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data;return[p[0],p[1],p[2]]})()`);
  const initialPixel = await pixelAtProgram(); assert.ok(initialPixel[0] > initialPixel[2] * 2, `synthetic program preview decoded red: ${initialPixel}`);
  await gui.evaluate(`document.querySelector('.media-item[data-asset-id="${asset.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await waitFor('decoded Source monitor', () => gui.evaluate(`(()=>{const v=document.querySelector('#source-stage video');return v&&v.readyState>=2&&!v.seeking})()`));
  await gui.click('#source-play'); await gui.click('#btn-play');
  await waitFor('Source and Program playback active', () => gui.evaluate(`(()=>{const source=document.querySelector('#source-stage video'),audio=document.querySelector('#preview-stage audio');return !!source&&!source.paused&&!!audio&&!audio.paused})()`));

  await gui.click('#btn-workspace-settings');
  await waitFor('visible settings dialog', () => gui.evaluate(`document.querySelector('#workspace-settings-dialog').open&&document.querySelector('#ws-mode').value==='edit'`));
  await gui.set('#ws-source-visible', 'checked', false);
  await waitFor('hiding Source pauses only Source playback', () => gui.evaluate(`(()=>{const source=document.querySelector('#source-stage video'),programAudio=document.querySelector('#preview-stage audio');return document.querySelector('#source-monitor').hidden&&source.paused&&programAudio&&!programAudio.paused})()`)).catch(async (error) => {
    const diagnostics = await gui.evaluate(`(()=>({panelHidden:document.querySelector('#source-monitor').hidden,source:{paused:document.querySelector('#source-stage video')?.paused,playing:document.querySelector('#source-play').textContent},programAudio:[...document.querySelectorAll('#preview-stage audio')].map(el=>({paused:el.paused,readyState:el.readyState,time:el.currentTime})),playButton:document.querySelector('#btn-play').textContent,settings:document.querySelector('#ws-source-visible').checked,revision:document.querySelector('#btn-workspace-settings').dataset.settingsRevision}))()`);
    throw new Error(`${error.message}; source/playback diagnostics ${JSON.stringify(diagnostics)}`);
  });
  await gui.click('#workspace-settings-close'); await gui.click('#btn-play');
  await waitFor('Program playback paused after Source independence check', () => gui.evaluate(`(()=>[...document.querySelectorAll('#preview-stage video,#preview-stage audio')].every(el=>el.paused))()`));
  await gui.click('#btn-start');
  await waitFor('Program decoder settled back on the synthetic first frame', () => gui.evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')];return v.length===1&&v[0].readyState>=2&&!v[0].seeking&&Math.abs(v[0].currentTime)<.001&&Number(document.querySelector('#program-canvas').dataset.paintedTime)===0})()`));
  assert.deepEqual(await pixelAtProgram(), initialPixel, 'Program remains on decoded first frame before workspace mutations');
  await gui.click('#btn-workspace-settings');
  await gui.set('#ws-mode', 'value', 'audio');
  await gui.set('#ws-browser', 'value', 'effects');
  await gui.set('#ws-library-width', 'value', '286');
  await gui.set('#ws-inspector-width', 'value', '338');
  await gui.set('#ws-source-ratio', 'value', '0.64');
  await gui.set('#ws-auto-timeline-height', 'checked', false);
  await gui.set('#ws-timeline-height', 'value', '260');
  await gui.set('#ws-timeline-zoom', 'value', '123.5');
  await gui.set('#ws-snap', 'checked', false);
  await gui.set('#ws-grid', 'checked', false);
  await gui.set('#ws-library-visible', 'checked', false);
  await gui.set('#ws-source-visible', 'checked', false);
  await gui.set('#ws-inspector-visible', 'checked', false);
  await gui.set('#ws-transitions-visible', 'checked', false);
  const expectedLayout = { mode: 'audio', browser: 'effects', panels: { library: false, source: false, inspector: false, transitions: false }, libraryWidth: 286, inspectorWidth: 338, timelineHeight: 260, sourceRatio: 0.64, timelineZoom: 123.5, snap: false, grid: false };
  await waitFor('GUI settings mutations persisted and painted', async () => {
    const state = await gui.state(), layout = state.workspaceSettings?.current;
    return JSON.stringify(layout) === JSON.stringify(expectedLayout) && await gui.evaluate(`document.querySelector('#layout').dataset.libraryVisible==='false'&&document.querySelector('#layout').dataset.inspectorVisible==='false'&&document.querySelector('#source-monitor').hidden&&document.querySelector('#right').hidden&&document.querySelector('#left').hidden`);
  });
  assert.equal(await gui.evaluate(`!document.querySelector('#btn-workspace-settings').hidden&&!document.querySelector('#program-monitor').hidden&&!document.querySelector('#timeline-wrap').hidden`), true, 'settings entry, Program and Timeline remain reachable');
  await gui.set('#ws-mode', 'value', 'color');
  await waitFor('Color mode remains reachable while Inspector is hidden', () => gui.evaluate(`document.body.dataset.workspace==='color'&&!document.querySelector('#workspace-mode-note').hidden`));
  await gui.set('#ws-mode', 'value', 'audio');
  const savedLayout = await (async () => {
    await gui.set('#ws-layout-name', 'value', 'Review mix');
    await gui.click('#ws-layout-save');
    return waitFor('named workspace saved', async () => {
      const result = await call('workspace_layout_list');
      return result.layouts?.find((layout) => layout.name === 'Review mix') ?? false;
    });
  })();
  await waitFor('saved layout option painted in visible settings', () => gui.evaluate(`!!document.querySelector('#ws-layout-select option[value="${savedLayout.id}"]')`));
  await gui.set('#ws-layout-select', 'value', savedLayout.id);
  const markerRevision = (await call('project_info')).revision;
  await call('marker_add', { label: 'Unrelated project edit', time: 0.5 });
  await waitFor('named selection survives project event and duplicate settings snapshot', async () => {
    const info = await call('project_info');
    return info.revision > markerRevision && await gui.evaluate(`document.querySelector('#ws-layout-select').value==='${savedLayout.id}'`);
  });
  await gui.set('#ws-library-visible', 'checked', true);
  await gui.set('#ws-source-visible', 'checked', true);
  await gui.set('#ws-inspector-visible', 'checked', true);
  await gui.set('#ws-transitions-visible', 'checked', true);
  await gui.set('#ws-mode', 'value', 'edit');
  await gui.set('#ws-browser', 'value', 'project');
  await waitFor('temporary workspace arrangement restored', () => gui.evaluate(`!document.querySelector('#left').hidden&&!document.querySelector('#source-monitor').hidden&&!document.querySelector('#right').hidden`));
  const wideGeometry = await gui.evaluate(`(()=>({library:document.querySelector('#left').getBoundingClientRect().width,inspector:document.querySelector('#right').getBoundingClientRect().width,source:document.querySelector('#source-monitor').getBoundingClientRect().width,program:document.querySelector('#program-monitor').getBoundingClientRect().width,timeline:document.querySelector('#timeline-wrap').getBoundingClientRect().height}))()`);
  assert.equal(wideGeometry.library, expectedLayout.libraryWidth); assert.equal(wideGeometry.inspector, expectedLayout.inspectorWidth); assert.ok(Math.abs(wideGeometry.source / (wideGeometry.source + wideGeometry.program) - expectedLayout.sourceRatio) < .02); assert.equal(wideGeometry.timeline, expectedLayout.timelineHeight);
  await gui.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor('responsive workspace geometry remains inside a small window', () => gui.evaluate(`(()=>{const layout=document.querySelector('#layout'),left=document.querySelector('#left').getBoundingClientRect(),right=document.querySelector('#right').getBoundingClientRect();return right.right<=window.innerWidth&&left.width<=286&&right.width<=338})()`));
  await gui.send('Emulation.clearDeviceMetricsOverride');
  await gui.set('#ws-layout-select', 'value', savedLayout.id);
  await gui.click('#ws-layout-apply');
  await waitFor('named layout visibly applied', async () => {
    const current = (await gui.state()).workspaceSettings.current;
    return current.mode === 'audio' && current.browser === 'effects' && !current.panels.library && await gui.evaluate(`document.querySelector('#left').hidden&&document.body.dataset.workspace==='audio'`);
  });
  await gui.set('#ws-layout-select', 'value', savedLayout.id);
  await gui.click('#ws-layout-delete');
  await waitFor('named layout removed through GUI', async () => (await call('workspace_layout_list')).layouts.length === 0);

  const preferencesBeforeProjectLoad = (await call('workspace_settings_get')).workspaceSettings.current;
  const projectBeforeRemoteUpdate = await gui.state();
  const remoteLayout = { ...preferencesBeforeProjectLoad, panels: { ...preferencesBeforeProjectLoad.panels, library: true }, timelineZoom: 177.25 };
  const remoteUpdate = await call('workspace_settings_update', { patch: { panels: { library: true }, timelineZoom: 177.25 }, expectedSettingsRevision: projectBeforeRemoteUpdate.workspaceSettings.revision });
  const remoteSnapshot = snapshotOf(remoteUpdate);
  await waitFor('MCP workspace update paints without project history change', async () => {
    const state = await gui.state();
    return state.workspaceSettings?.revision === remoteSnapshot.revision && await gui.evaluate(`!document.querySelector('#left').hidden&&Number(document.querySelector('#timeline-zoom').value)===177.25`) && state.revision === projectBeforeRemoteUpdate.revision && state.eventSequence === projectBeforeRemoteUpdate.eventSequence && state.canUndo === projectBeforeRemoteUpdate.canUndo && state.canRedo === projectBeforeRemoteUpdate.canRedo;
  }).catch(async (error) => {
    const state = await gui.state();
    const diagnostics = await gui.evaluate(`(()=>({live:document.querySelector('#live-text').textContent,libraryHidden:document.querySelector('#left').hidden,zoomValue:document.querySelector('#timeline-zoom').value,settingsButtonRevision:document.querySelector('#btn-workspace-settings').dataset.settingsRevision,dialogOpen:document.querySelector('#workspace-settings-dialog').open}))()`);
    throw new Error(`${error.message}; expected settings revision ${remoteSnapshot.revision}, expected project state ${JSON.stringify({ revision: projectBeforeRemoteUpdate.revision, eventSequence: projectBeforeRemoteUpdate.eventSequence, canUndo: projectBeforeRemoteUpdate.canUndo, canRedo: projectBeforeRemoteUpdate.canRedo })}, actual state ${JSON.stringify({ settings: state.workspaceSettings, revision: state.revision, eventSequence: state.eventSequence, canUndo: state.canUndo, canRedo: state.canRedo })}, UI ${JSON.stringify(diagnostics)}`);
  });
  assert.equal(JSON.stringify((await call('workspace_settings_get')).workspaceSettings.current), JSON.stringify(remoteLayout));
  const previewAfterRemote = await pixelAtProgram(); assert.deepEqual(previewAfterRemote, initialPixel, 'settings-only MCP updates preserve decoded program pixels');
  await gui.click('#workspace-settings-close');
  await gui.click('#btn-export');
  await waitFor('actual export after workspace updates', () => gui.evaluate(`document.querySelector('#toast').textContent.startsWith('Exported')`), 120000);
  const decodeExport = async () => {
    const { stdout } = await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
    const offset = ((90 * 320) + 160) * 3; return [stdout[offset], stdout[offset + 1], stdout[offset + 2]];
  };
  const exportedPixel = await decodeExport(); assert.ok(exportedPixel[0] > exportedPixel[2] * 2, `export remains a decoded red frame: ${exportedPixel}`);
  await call('project_save', { path: projectPath });
  const beforeProjectReload = JSON.stringify((await call('workspace_settings_get')).workspaceSettings.current);
  await call('project_update', { name: 'Temporary name' }); await call('project_load', { path: projectPath });
  await waitFor('project reload without workspace preference loss', async () => JSON.stringify((await call('workspace_settings_get')).workspaceSettings.current) === beforeProjectReload);

  await gui.click('#btn-workspace-settings');
  await waitFor('settings dialog reopened before owner restart', () => gui.evaluate(`document.querySelector('#workspace-settings-dialog').open`));
  await gui.set('#ws-layout-name', 'value', 'Reconnect layout');
  await gui.click('#ws-layout-save');
  const reconnectLayout = await waitFor('second named layout persisted before owner restart', async () => {
    const result = await call('workspace_layout_list');
    return result.layouts?.find((layout) => layout.name === 'Reconnect layout') ?? false;
  });
  await waitFor('reconnect layout option painted before owner restart', () => gui.evaluate(`!!document.querySelector('#ws-layout-select option[value="${reconnectLayout.id}"]')`));
  await gui.set('#ws-layout-select', 'value', reconnectLayout.id);
  const beforeOwnerRestart = (await call('workspace_settings_get')).workspaceSettings;
  const originalEpoch = beforeOwnerRestart.epoch;
  await gui.click('#workspace-settings-close');
  await stopService();
  await waitBridgeDown();
  await waitFor('live bridge reports disconnect before owner restart', () => gui.evaluate(`document.querySelector('#live-text').textContent==='Reconnecting'`));
  call = await startService();
  await waitFor('restarted owner bridge', async () => (await fetch(bridge + '/health')).ok);
  const afterRestart = (await call('workspace_settings_get')).workspaceSettings;
  assert.deepEqual(afterRestart.current, remoteLayout, 'settings persist across an owning service restart');
  assert.equal(afterRestart.epoch === originalEpoch, false, 'restarted owner establishes a new settings epoch');
  assert.equal(afterRestart.layouts.find((layout) => layout.id === reconnectLayout.id)?.name, 'Reconnect layout', 'named layout id and name survive owner restart');
  await waitFor('live Electron reconnects to restarted owner epoch', async () =>
    await gui.evaluate(`document.querySelector('#live-text').textContent==='Live MCP'`) &&
    (await gui.state()).workspaceSettings?.epoch === afterRestart.epoch &&
    await gui.evaluate(`Number(document.querySelector('#timeline-zoom').value)===177.25`));
  await waitFor('reconnected named layout option painted', () => gui.evaluate(`!!document.querySelector('#ws-layout-select option[value="${reconnectLayout.id}"]')`));
  const newOwnerProjectBeforeUpdate = await gui.state();
  const reconnectedUpdateResult = await call('workspace_settings_update', { patch: { timelineZoom: 190.5 }, expectedSettingsRevision: afterRestart.revision });
  const reconnectedUpdate = snapshotOf(reconnectedUpdateResult);
  await waitFor('second remote update paints in new owner epoch without project mutation', async () => {
    const state = await gui.state();
    return state.workspaceSettings?.epoch === afterRestart.epoch && state.workspaceSettings?.revision === reconnectedUpdate.revision &&
      await gui.evaluate(`Number(document.querySelector('#timeline-zoom').value)===190.5`) &&
      state.revision === newOwnerProjectBeforeUpdate.revision && state.eventSequence === newOwnerProjectBeforeUpdate.eventSequence && state.canUndo === newOwnerProjectBeforeUpdate.canUndo && state.canRedo === newOwnerProjectBeforeUpdate.canRedo;
  });
  const guiSelectedLayout = await gui.evaluate(`document.querySelector('#ws-layout-select').value`);
  assert.equal(guiSelectedLayout, reconnectLayout.id, 'layout selection survives authoritative epoch snapshot');
  await call('project_load', { path: projectPath });
  await waitFor('saved portable project opened after owner restart', async () => {
    const state = await gui.state();
    return state.project?.name === 'Workspace preferences acceptance' &&
      await gui.evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')];const c=document.querySelector('#program-canvas');return v.length===1&&v[0].readyState>=2&&!v[0].seeking&&Number(c.dataset.paintedTime)===0})()`);
  });
  assert.deepEqual(await pixelAtProgram(), initialPixel, 'decoded Program preview survives explicit project reopen after reconnect');
  await stopGui(gui);
  const relaunchedGui = await startGui();
  await waitFor('cold-start layout paints from persisted owner', async () => {
    const state = await relaunchedGui.state();
    return state.workspaceSettings?.epoch === afterRestart.epoch && state.workspaceSettings?.revision === reconnectedUpdate.revision &&
      await relaunchedGui.evaluate(`document.querySelector('#layout').dataset.libraryVisible==='true'&&Number(document.querySelector('#timeline-zoom').value)===190.5`);
  });
  await relaunchedGui.click('#btn-workspace-settings');
  await waitFor('named layout survives cold GUI restart', () => relaunchedGui.evaluate(`!!document.querySelector('#ws-layout-select option[value="${reconnectLayout.id}"]')`));

  await stopGui(relaunchedGui);
  await stopService();
  await waitBridgeDown();
  const corruptBytes = Buffer.from('{ workspace settings damaged\n', 'utf8');
  await fs.writeFile(settingsPath, corruptBytes);
  call = await startService();
  await waitFor('service read-only corrupt settings state', async () => (await call('workspace_settings_get')).workspaceSettings.readOnly);
  const recoveryGui = await startGui();
  await recoveryGui.click('#btn-workspace-settings');
  await waitFor('corrupt settings warning visible and Recovery enabled', () => recoveryGui.evaluate(`(()=>{const warning=document.querySelector('#ws-persistence-warning');return warning.hidden===false&&warning.textContent.toLowerCase().includes('read-only')&&!document.querySelector('#ws-restore').disabled})()`));
  await recoveryGui.click('#ws-restore');
  await waitFor('explicit recovery restores writable defaults', async () => {
    const settings = (await call('workspace_settings_get')).workspaceSettings;
    return !settings.readOnly && settings.current.mode === 'edit' && settings.current.panels.library && await recoveryGui.evaluate(`document.querySelector('#ws-persistence-warning').hidden`);
  });
  const recoveredFile = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(recoveredFile.current, (await call('workspace_settings_get')).workspaceSettings.current);
  const backupNames = (await fs.readdir(path.dirname(settingsPath))).filter((name) => name.startsWith('workspace-recovery-') && name.endsWith('.json'));
  assert.ok(backupNames.length > 0, 'recovery made a unique backup before replacing corrupt bytes');
  assert.deepEqual(await fs.readFile(path.join(path.dirname(settingsPath), backupNames[0])), corruptBytes, 'recovery backup preserves the original corrupt file bytes');
  assert.deepEqual(recoveryGui.errors, [], `renderer exceptions: ${recoveryGui.errors.join('\n')}\n${log}`);
  console.log('Workspace settings Electron acceptance: visible layouts/CRUD, service-owned remote updates, project isolation, reconnect/cold restart, corruption backup/recovery, decoded preview/export passed.');
  await stopGui(recoveryGui);
} catch (error) {
  console.error(error);
  if (log) console.error(log);
  throw error;
} finally {
  if (socket) socket.close();
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(4000)]);
  }
  await client?.close().catch(() => {});
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Unsafe acceptance fixture cleanup');
  await fs.rm(resolved, { recursive: true, force: true });
}
