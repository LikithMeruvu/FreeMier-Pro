/** Actual Electron end-to-end acceptance for project protection and recovery. */
import assert from 'node:assert/strict';
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
const workspace = await fs.mkdtemp(path.join(root, '.tmp', 'project-protection-'));
const port = await freePort(), bridge = `http://127.0.0.1:${port}`;
const projectPath = path.join(workspace, 'Protected project.freemier');
const sourcePath = path.join(workspace, 'synthetic-protection-red.mp4');
const outputPath = path.join(workspace, 'recovered-export.mp4');
const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1', FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, output: outputPath, closeChoices: ['cancel', 'save'] }) };
delete env.ELECTRON_RUN_AS_NODE;
const children = [];
let gui;

async function startGui(extraEnv = {}) {
  const debugPort = await freePort(); let log = '';
  const child = spawn(electron, ['--inspect=0', path.join(root, 'packages/gui'), `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
  const target = await waitFor('Electron renderer page', async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((entry) => entry.type === 'page' && entry.url.includes('renderer/index.html')));
  const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map(), errors = [];
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
  const inspectorUrl = await waitFor('Electron main-process inspector endpoint', () => log.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]);
  const mainSocket = new WebSocket(inspectorUrl); await new Promise((resolve, reject) => { mainSocket.onopen = resolve; mainSocket.onerror = reject; });
  let mainSequence = 0; const mainPending = new Map();
  mainSocket.onmessage = ({ data }) => { const message = JSON.parse(data); mainPending.get(message.id)?.(message); };
  const mainSend = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++mainSequence, timer = setTimeout(() => { mainPending.delete(id); reject(new Error(`main CDP timeout: ${method}`)); }, 20000);
    mainPending.set(id, (message) => { clearTimeout(timer); mainPending.delete(id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    mainSocket.send(JSON.stringify({ id, method, params }));
  });
  await mainSend('Runtime.enable');
  const evaluateMain = async (expression) => {
    const result = await mainSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
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
  const closeNatively = () => evaluate('(()=>{window.freemier.requestWindowCloseForTest();return true})()');
  return { child, socket, mainSocket, send, evaluate, evaluateMain, click, set, state, closeNatively, errors, get log() { return log; } };
}

async function call(action, args = {}) {
  const response = await fetch(bridge + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, arguments: args }) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${action}: ${result.error?.message ?? JSON.stringify(result)}`);
  return result;
}

async function stopGui(gui) {
  gui?.socket?.close();
  gui?.mainSocket?.close();
  if (gui?.child && gui.child.exitCode === null) {
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(gui.child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else gui.child.kill();
    await Promise.race([new Promise((resolve) => gui.child.once('exit', resolve)), sleep(4000)]);
    if (gui.child.exitCode === null) gui.child.kill('SIGKILL');
  }
}

async function waitForExit(gui, label) {
  // A live Node inspector client intentionally keeps Electron's main process
  // active; disconnect it before asserting that the real window close exits.
  gui.mainSocket.close();
  gui.socket.close();
  await waitFor(label, () => gui.child.exitCode !== null, 15000);
}

async function armProjectSaveBarrier(gui, projectDir) {
  const target = path.join(projectDir, 'project.json');
  return gui.evaluateMain(`(()=>{const fs=process.getBuiltinModule('fs');const path=process.getBuiltinModule('path');const api=fs.promises;const original=api.rename;let reachedResolve,releaseResolve;const reached=new Promise(r=>reachedResolve=r);const released=new Promise(r=>releaseResolve=r);const target=path.resolve(${JSON.stringify(target)});const real=original.bind(api);globalThis.__protectionSaveBarrier={reached,release:()=>releaseResolve(),restore:()=>{api.rename=original;releaseResolve();}};api.rename=async function(from,to,...rest){const result=await real(from,to,...rest);if(path.resolve(String(to))===target&&path.basename(String(from)).startsWith('project.json.tmp-')){api.rename=original;reachedResolve();await released;}return result;};return true})()`);
}

async function waitForProjectSaveBarrier(gui) {
  return gui.evaluateMain(`globalThis.__protectionSaveBarrier.reached.then(()=>true)`);
}

async function releaseProjectSaveBarrier(gui) {
  return gui.evaluateMain(`(()=>{globalThis.__protectionSaveBarrier?.release();return true})()`);
}

// Windows keeps a directory un-renamable while the renderer is still buffering a
// media file inside it. Retry the test's own directory moves for a bounded time.
async function renameWithRetry(from, to, attempts = 80) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await sleep(250);
    }
  }
}

try {
  await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath], { windowsHide: true });
  gui = await startGui();
  await waitFor('standalone bridge and owner protection snapshot', async () => (await fetch(bridge + '/health')).ok && await gui.evaluate(`document.querySelector('#protection-indicator').textContent==='New project'`));
  assert.ok(gui.log.includes('standalone mode'), `expected an owning standalone EditorStore: ${gui.log}`);

  await gui.click('#btn-new-project');
  await waitFor('new project dialog opens from clean state', () => gui.evaluate(`document.querySelector('#project-dialog').open`));
  await gui.set('#project-form-name', 'value', 'Protection demo');
  await gui.click('#project-form-submit');
  await waitFor('guarded New creates the selected project', async () => (await gui.state()).project?.name === 'Protection demo');
  const initial = await gui.state();
  const asset = (await call('media_import', { path: sourcePath, copyIntoProject: true })).asset;
  const tracks = (await call('timeline_inspect')).tracks;
  const videoTrack = tracks.find((track) => track.kind === 'video'), audioTrack = tracks.find((track) => track.kind === 'audio');
  assert.ok(videoTrack && audioTrack, 'fixture project exposes video and audio tracks');
  await call('clip_add', { trackId: videoTrack.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 4, strict: true });
  await call('clip_add', { trackId: audioTrack.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 4, strict: true });
  const saved = await call('project_save', { path: projectPath });
  assert.equal(saved.projectProtection.dirty, false, 'normal project save establishes the clean content baseline');
  await waitFor('decoded original project frame', () => gui.evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')],c=document.querySelector('#program-canvas');return v.length===1&&v[0].readyState>=2&&!v[0].seeking&&Number(c.dataset.paintedTime)===0})()`));

  const firstTitle = (await call('title_add', { text: 'Checkpoint A', start: 0, end: 2 })).title;
  const firstRecovery = (await call('project_recovery_create')).recovery;
  await waitFor('GUI marks authored work unsaved', () => gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  await gui.click('#btn-new-project');
  await waitFor('replacement Save/Discard/Cancel prompt', () => gui.evaluate(`document.querySelector('#protection-replace-dialog').open`));
  await gui.click('#protection-replace-cancel');
  await waitFor('Cancel keeps project editor unchanged', async () => !await gui.evaluate(`document.querySelector('#protection-replace-dialog').open`) && (await gui.state()).project.id === initial.project.id);
  await gui.click('#btn-new-project');
  await waitFor('second replacement prompt before New', () => gui.evaluate(`document.querySelector('#protection-replace-dialog').open`));
  await gui.click('#protection-replace-discard');
  await waitFor('explicit Discard opens new-project form', () => gui.evaluate(`!document.querySelector('#protection-replace-dialog').open&&document.querySelector('#project-dialog').open`));
  await gui.set('#project-form-name', 'value', 'Temporary guarded project');
  await gui.click('#project-form-submit');
  await waitFor('New uses the guarded replacement command', async () => (await gui.state()).project?.name === 'Temporary guarded project');
  await gui.click('#btn-open');
  await waitFor('Open uses guarded project picker result', async () => (await gui.state()).project?.name === 'Protection demo');
  assert.ok((await gui.state()).project.id === initial.project.id, 'guarded Open restores the same saved project identity');

  const secondTitle = (await call('title_add', { text: 'Checkpoint B', start: 0, end: 2 })).title;
  const secondRecovery = (await call('project_recovery_create')).recovery;
  await call('title_add', { text: 'Later unsaved title', start: 2, end: 3 });
  const loadedProject = JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8'));
  const packagedAsset = loadedProject.media.find((item) => item.id === asset.id);
  assert.ok(packagedAsset?.copied, 'saved project contains the copied synthetic source');
  const originalPackagedMedia = path.resolve(projectPath, 'media', packagedAsset.path);
  assert.ok(originalPackagedMedia.startsWith(path.resolve(projectPath, 'media') + path.sep));
  await gui.click('#btn-new-project');
  await waitFor('temporary replacement prompt before removing media held by a decoder', () => gui.evaluate(`document.querySelector('#protection-replace-dialog').open`));
  await gui.click('#protection-replace-discard');
  await waitFor('temporary project form for releasing the saved media decoder', () => gui.evaluate(`document.querySelector('#project-dialog').open`));
  await gui.set('#project-form-name', 'value', 'Decoder release workspace');
  await gui.click('#project-form-submit');
  await waitFor('temporary project replaces the decoded source', async () => (await gui.state()).project?.name === 'Decoder release workspace');
  await waitFor('saved media file is no longer held by the Windows decoder', () => gui.evaluate(`![...document.querySelectorAll('#preview-stage video')].some((video)=>video.currentSrc&&video.readyState>=2)`));
  await fs.rm(originalPackagedMedia, { force: true });
  assert.equal(await fs.stat(originalPackagedMedia).then(() => true, () => false), false, 'normal saved media copy is absent before recovery restore');
  await call('title_add', { text: 'Disposable unsaved edit', start: 0, end: 1 });

  await gui.click('#btn-protection');
  await waitFor('visible project protection panel and recovery versions', () => gui.evaluate(`document.querySelector('#project-protection-dialog').open&&document.querySelector('#protection-recovery-list').options.length>=3`));
  await gui.set('#protection-recovery-list', 'value', secondRecovery.id);
  await gui.click('#protection-inspect');
  await waitFor('recovery package inspection verifies copied media', () => gui.evaluate(`document.querySelector('#protection-inspection').textContent.includes('validated')&&document.querySelector('#protection-inspection').textContent.includes('available')`));
  await gui.click('#protection-restore');
  await waitFor('dirty restore asks for explicit replacement consent', () => gui.evaluate(`document.querySelector('#protection-replace-dialog').open`));
  await gui.click('#protection-replace-discard');
  await waitFor('selected recovery replaces project and remains dirty', async () => {
    const state = await gui.state();
    return state.project.timeline.titles.some((item) => item.id === secondTitle.id) && !state.project.timeline.titles.some((item) => item.text === 'Later unsaved title') && state.projectProtection?.dirty === true;
  });
  await waitFor('recovery media decodes in the visible Program monitor', () => gui.evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')],c=document.querySelector('#program-canvas');if(v.length!==1||v[0].readyState<2||v[0].seeking||Number(c.dataset.paintedTime)!==0)return false;const p=c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data;return p[0]>p[2]*2})()`));

  const beforeSettings = await gui.state();
  await gui.set('#protection-enabled', 'checked', false);
  await gui.set('#protection-interval', 'value', '45');
  await gui.set('#protection-retention', 'value', '4');
  await gui.click('#protection-configure');
  await waitFor('visible protection settings persist without project history mutation', async () => {
    const state = await gui.state(), config = (await call('project_protection_get')).projectProtection;
    return !config.enabled && config.intervalSeconds === 45 && config.retention === 4 && state.revision === beforeSettings.revision && state.eventSequence === beforeSettings.eventSequence && state.canUndo === beforeSettings.canUndo && state.canRedo === beforeSettings.canRedo;
  });
  await gui.click('#protection-close');
  await gui.click('#btn-export');
  await waitFor('actual export of recovered project', () => gui.evaluate(`document.querySelector('#toast').textContent.startsWith('Exported')`), 120000);
  const { stdout: decodedExport } = await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
  const center = ((90 * 320) + 160) * 3;
  assert.ok(decodedExport[center] > decodedExport[center + 2] * 2, 'recovered project export decodes the expected red frame');
  await gui.click('#btn-save');
  await waitFor('normal Save clears recovered dirty state', async () => (await gui.state()).projectProtection?.dirty === false);

  // A second Electron process attaches as a viewer. Closing that window must not stop the MCP owner.
  const viewer = await startGui({ FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, output: outputPath }) });
  await waitFor('second Electron process attaches in viewer mode', () => viewer.log.includes('viewer mode'));
  await viewer.closeNatively();
  await waitForExit(viewer, 'viewer detaches through an actual BrowserWindow close');
  assert.equal((await fetch(bridge + '/health')).ok, true, 'closing a viewer leaves the standalone MCP owner alive');
  assert.equal((await call('project_protection_get')).projectProtection.dirty, false);
  await gui.closeNatively();
  await waitForExit(gui, 'clean standalone window closes without an unsaved prompt');

  // A fresh owning process presents a recovery chooser before the user can lose sight of completed versions.
  gui = await startGui({ FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, output: outputPath, closeChoices: ['cancel', 'save'] }) });
  await waitFor('completed recovery versions shown in startup chooser', () => gui.evaluate(`document.querySelector('#project-protection-dialog').open&&document.querySelector('#protection-recovery-list').options.length>=3`));
  await gui.click('#protection-inspect');
  await waitFor('startup recovery selection can be inspected', () => gui.evaluate(`document.querySelector('#protection-inspection').textContent.includes('validated')`));
  await gui.click('#protection-restore');
  await waitFor('clean startup store restores selected version', async () => (await gui.state()).projectProtection?.dirty === true);
  await waitFor('startup restored package renders decoded media', () => gui.evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')],c=document.querySelector('#program-canvas');if(v.length!==1||v[0].readyState<2||v[0].seeking||Number(c.dataset.paintedTime)!==0)return false;const p=c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data;return p[0]>p[2]*2})()`));
  await gui.closeNatively();
  await waitFor('native Cancel keeps dirty standalone window open', () => gui.child.exitCode === null && gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  await gui.closeNatively();
  await waitForExit(gui, 'native Save publishes the dirty recovery and closes the standalone window');
  assert.ok(await fs.stat(path.join(projectPath, 'project.json')).then(() => true, () => false), 'native Save publishes the normal project document');

  const normalProjectBytes = await fs.readFile(path.join(projectPath, 'project.json'));
  gui = await startGui({ FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, closeChoices: ['discard'] }) });
  await waitFor('standalone process with pending recovery starts', () => gui.log.includes('standalone mode') && gui.evaluate(`document.querySelector('#project-protection-dialog').open`));
  await gui.click('#protection-close');
  await call('title_add', { text: 'Discarded on close', start: 0, end: 1 });
  await waitFor('native Discard test is dirty', () => gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  await gui.closeNatively();
  await waitForExit(gui, 'native Discard closes the dirty standalone window');
  assert.deepEqual(await fs.readFile(path.join(projectPath, 'project.json')), normalProjectBytes, 'Discard leaves the normal saved project bytes untouched');

  // Save with a canceled destination is not a successful close decision.
  gui = await startGui({ FREEMIER_TEST_DIALOGS: JSON.stringify({ closeSavePath: '', closeChoices: ['save', 'discard'] }) });
  await waitFor('standalone process for canceled Save close', () => gui.log.includes('standalone mode') && gui.evaluate(`document.querySelector('#project-protection-dialog').open`));
  await gui.click('#protection-close');
  await call('title_add', { text: 'Save destination canceled', start: 0, end: 1 });
  await waitFor('canceled Save test is dirty', () => gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  await gui.closeNatively();
  await waitFor('Save with no chosen destination leaves window open', () => gui.child.exitCode === null && gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  await gui.closeNatively();
  await waitForExit(gui, 'explicit Discard remains available after canceled Save');

  // Hold the actual atomic project.json rename after it publishes the captured
  // snapshot. A real Bridge edit arrives while project_save is still awaiting
  // filesystem completion; the stale receipt must leave the real window open.
  gui = await startGui({ FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, closeChoices: ['save', 'discard'], closeNoticeReplies: [0] }) });
  await waitFor('standalone recovery chooser for concurrent-edit close case', () => gui.log.includes('standalone mode') && gui.evaluate(`document.querySelector('#project-protection-dialog').open&&document.querySelector('#protection-recovery-list').options.length>=3`));
  await gui.click('#protection-close');
  await gui.click('#btn-open');
  await waitFor('saved project loads for concurrent-edit close case', async () => (await gui.state()).project?.name === 'Protection demo');
  await call('title_add', { text: 'Close-save captured baseline', start: 0, end: 1 });
  await waitFor('concurrent-save case is dirty', () => gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  await armProjectSaveBarrier(gui, projectPath);
  await gui.closeNatively();
  await waitForProjectSaveBarrier(gui);
  const concurrentTitle = 'Bridge edit while native Save awaits publication';
  const pendingEdit = call('title_add', { text: concurrentTitle, start: 1, end: 2 });
  await sleep(100);
  await releaseProjectSaveBarrier(gui);
  await pendingEdit;
  await waitFor('native Save detects the intervening edit and leaves the window open', async () => gui.child.exitCode === null && await gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`) && gui.log.includes('[test] CLOSE_NOTICE: Could not save project'));
  const publishedDuringSave = JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8'));
  assert.ok(!publishedDuringSave.timeline.titles.some((item) => item.text === concurrentTitle), 'the atomic save contains the captured pre-edit snapshot, not the Bridge edit');
  await gui.closeNatively();
  await waitForExit(gui, 'explicit Discard remains available after a stale native Save receipt');

  // Make the normal project destination a regular file. The real backend save
  // must fail, the native error acknowledgement is stubbed, and the window
  // remains open until the user chooses Discard.
  const stableProjectBytes = await fs.readFile(path.join(projectPath, 'project.json'));
  gui = await startGui({ FREEMIER_TEST_DIALOGS: JSON.stringify({ project: projectPath, closeChoices: ['save', 'discard'], closeNoticeReplies: [0] }) });
  await waitFor('standalone recovery chooser for failed-save close case', () => gui.log.includes('standalone mode') && gui.evaluate(`document.querySelector('#project-protection-dialog').open&&document.querySelector('#protection-recovery-list').options.length>=3`));
  await gui.click('#protection-close');
  await gui.click('#btn-open');
  await waitFor('saved project loads for failed-save close case', async () => (await gui.state()).project?.name === 'Protection demo');
  await call('title_add', { text: 'Failed native Save remains dirty', start: 0, end: 1 });
  await waitFor('failed-save case is dirty', () => gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`));
  const blockedProjectPath = path.join(workspace, 'Protected project.blocked-backup');
  await renameWithRetry(projectPath, blockedProjectPath);
  await fs.writeFile(projectPath, 'regular file blocks project directory creation');
  try {
    await gui.closeNatively();
    await waitFor('failed Save is acknowledged and the standalone window remains open', async () => gui.child.exitCode === null && await gui.evaluate(`document.querySelector('#protection-indicator').textContent==='Unsaved'`) && gui.log.includes('[test] CLOSE_NOTICE: Could not save project'));
  } finally {
    await fs.rm(projectPath, { force: true });
    await renameWithRetry(blockedProjectPath, projectPath);
  }
  assert.deepEqual(await fs.readFile(path.join(projectPath, 'project.json')), stableProjectBytes, 'failed Save leaves the last published project document unchanged');
  await gui.closeNatively();
  await waitForExit(gui, 'native Discard closes after a failed Save without publishing the edit');

  assert.deepEqual(gui.errors, [], `renderer exceptions: ${gui.errors.join('\n')}\n${gui.log}`);
  console.log('Project protection Electron acceptance: guarded New/Open, recovery inspection/restore, independent settings, decoded recovered preview/export, startup chooser, native Save/Discard/Cancel, viewer detach, canceled Save, actual save failure, and concurrent edit during atomic Save passed.');
} catch (error) {
  console.error(error);
  if (gui) {
    console.error('Electron main log:', gui.log);
    console.error('Current renderer state:', await gui.state().catch((stateError) => String(stateError)));
    console.error('Renderer exceptions:', gui.errors);
    console.error('Current project/dialog DOM:', await gui.evaluate(`(()=>({toast:document.querySelector('#toast')?.textContent,newDialog:document.querySelector('#project-dialog')?.open,replaceDialog:document.querySelector('#protection-replace-dialog')?.open,protection:document.querySelector('#protection-indicator')?.textContent,form:document.querySelector('#project-form')?.outerHTML}))()`).catch((domError) => String(domError)));
  }
  for (const child of children) if (child.exitCode === null) child.stderr?.on('data', (data) => process.stderr.write(data));
  throw error;
} finally {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Unsafe acceptance fixture cleanup');
  await fs.rm(resolved, { recursive: true, force: true });
}
