/** Actual Electron acceptance for project settings and visible track controls. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'), ELECTRON = createRequire(import.meta.url)('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn) { const end = Date.now() + 20000; let error; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await sleep(100); } throw error ?? new Error('Project tracks acceptance timeout'); }
async function freePort() { const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }
await fs.mkdir(path.join(ROOT, '.tmp'), { recursive: true });
const workspace = await fs.mkdtemp(path.join(ROOT, '.tmp', 'project-tracks-')), port = await freePort(), debugPort = await freePort();
const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let child, socket, output = '';
try {
  child = spawn(ELECTRON, [path.join(ROOT, 'packages/gui'), '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (d) => output += d); child.stderr.on('data', (d) => output += d);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('renderer/index.html')));
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; }); let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const result = JSON.parse(data); pending.get(result.id)?.(result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => reject(new Error('CDP timeout')), 20000); pending.set(key, (result) => { clearTimeout(timer); pending.delete(key); result.error ? reject(new Error(result.error.message)) : resolve(result.result); }); socket.send(JSON.stringify({ id: key, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const click = async (selector) => { const { root } = await send('DOM.getDocument', { depth: -1 }); const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }); assert.ok(nodeId, `Missing clickable element ${selector}`); const { model } = await send('DOM.getBoxModel', { nodeId }); const quad = model.content, x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
  await waitFor(() => evaluate('!!document.querySelector("#btn-new-project") && document.querySelector("#live-status").classList.contains("on")'));
  const call = async (action, args = {}) => { const result = await (await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json(); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  await click('#btn-new-project');
  await waitFor(() => evaluate('document.querySelector("#project-dialog").open'));
  await evaluate('document.querySelector("#project-form-name").value="Electron Project";document.querySelector("#project-form-width").value="640";document.querySelector("#project-form-height").value="360";document.querySelector("#project-form-fps").value="30"'); await click('#project-form-submit');
  await waitFor(() => evaluate('document.querySelector("#project-name").textContent==="Electron Project"'));
  const created = await evaluate('({name:document.querySelector("#project-name").textContent,dialogOpen:document.querySelector("#project-dialog").open,toast:document.querySelector("#toast").textContent,formName:document.querySelector("#project-form-name").value})');
  assert.equal(created.name, 'Electron Project', JSON.stringify(created));
  await call('marker_add', { label: 'Keep content', time: 0.5 });
  const previous = await call('project_info');
  await click('#btn-project-settings'); await waitFor(() => evaluate('document.querySelector("#project-dialog").open'));
  await evaluate('document.querySelector("#project-form-name").value="Edited Project";document.querySelector("#project-form-width").value="1280";document.querySelector("#project-form-height").value="720";document.querySelector("#project-form-fps").value="30"'); await click('#project-form-submit');
  await waitFor(async () => (await call('project_info')).width === 1280);
  assert.equal((await call('marker_list')).markers[0].label, 'Keep content');
  const refusal = await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'project_update', fps: 24 }) }).then((r) => r.json());
  assert.equal(refusal.ok, false); assert.equal((await call('project_info')).fps, 30);
  await call('undo'); assert.equal((await call('project_info')).width, previous.width); assert.equal((await call('marker_list')).markers[0].label, 'Keep content');
  const savedProject = path.join(workspace, 'project-roundtrip');
  await call('project_save', { path: savedProject });
  await call('project_update', { name: 'Temporary Project', width: 800 });
  await call('project_load', { path: savedProject });
  await waitFor(async () => (await call('project_info')).name === 'Electron Project');
  assert.equal((await call('project_info')).width, previous.width);
  assert.equal((await call('marker_list')).markers[0].label, 'Keep content');
  await evaluate('window.__confirmCalls=[];window.confirm=(message)=>{window.__confirmCalls.push(message);return false}');
  await click('#btn-new-project');
  assert.ok((await evaluate('window.__confirmCalls.at(-1)')).includes('discard the current project'));
  assert.equal(await evaluate('document.querySelector("#project-dialog").open'), false); assert.equal((await call('marker_list')).markers[0].label, 'Keep content');
  const first = (await call('track_add', { kind: 'video', name: 'V2' })).track, second = (await call('track_add', { kind: 'video', name: 'V3' })).track;
  await waitFor(() => evaluate(`!!document.querySelector('[data-track-id="${second.id}"]')`));
  await click(`[data-track-id="${second.id}"] [title="Move V3 down"]`);
  await waitFor(() => evaluate(`(()=>{const rows=[...document.querySelectorAll('#track-headers .track-header')].map(row=>row.dataset.trackId);return rows.indexOf('${second.id}')>rows.indexOf('${first.id}')})()`));
  await evaluate('window.prompt=(message)=>message==="Track name"?"Renamed":null');
  await click(`[data-track-id="${second.id}"] [title="Rename V3"]`);
  await waitFor(() => evaluate(`document.querySelector('[data-track-id="${second.id}"]').textContent.includes("Renamed")`));
  await click(`[data-track-id="${second.id}"] [title="Lock / unlock Renamed"]`);
  await waitFor(() => evaluate(`document.querySelector('[data-track-id="${second.id}"] [title="Lock / unlock Renamed"]').classList.contains('active')`));
  await click(`[data-track-id="${second.id}"] [title="Move Renamed up"]`);
  await waitFor(() => evaluate('document.querySelector("#toast").textContent.includes("Unlock both tracks")'));
  await click(`[data-track-id="${second.id}"] [title="Lock / unlock Renamed"]`);
  await waitFor(() => evaluate(`!document.querySelector('[data-track-id="${second.id}"] [title="Lock / unlock Renamed"]').classList.contains('active')`));
  const asset = (await call('media_import', { path: path.join(ROOT, 'fixtures/media/clipA.mp4'), copyIntoProject: true })).asset;
  await call('clip_add', { trackId: second.id, assetId: asset.id, duration: 0.5, label: 'Track removal undo' });
  await evaluate('window.confirm=(message)=>{window.__confirmCalls.push(message);return true}');
  await click(`[data-track-id="${second.id}"] [title="Remove Renamed"]`);
  await waitFor(() => evaluate(`!document.querySelector('[data-track-id="${second.id}"]')`));
  await call('undo');
  const restored = (await call('timeline_inspect')).tracks.find((track) => track.id === second.id);
  assert.equal(restored.clipCount, 1, 'undo restores a removed track and its authored clip');
  assert.equal(output.includes('standalone mode'), true);
  console.log('PASS: actual Electron project creation, content-preserving settings, fps refusal, undo, and track reorder/rename/remove');
} catch (error) { console.error(output); throw error; }
finally {
  socket?.close(); if (child && child.exitCode === null) { if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else child.kill(); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (!path.resolve(workspace).startsWith(path.join(ROOT, '.tmp') + path.sep)) throw new Error('Unsafe project fixture cleanup'); await fs.rm(workspace, { recursive: true, force: true });
}
