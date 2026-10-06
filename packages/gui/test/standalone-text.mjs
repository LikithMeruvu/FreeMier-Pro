/** Actual standalone Electron verifies its CJS-bundled font/provider path. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), ELECTRON = createRequire(import.meta.url)('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn) { const end = Date.now() + 20000; let error; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await sleep(100); } throw error ?? new Error('Standalone text timeout'); }
async function freePort() { const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }
await fs.mkdir(path.join(ROOT, '.tmp'), { recursive: true });
const workspace = await fs.mkdtemp(path.join(ROOT, '.tmp', 'standalone-text-')), port = await freePort(), debugPort = await freePort();
const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let child, socket, output = '', exceptions = [];
try {
  child = spawn(ELECTRON, [path.join(ROOT, 'packages/gui'), '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (d) => output += d); child.stderr.on('data', (d) => output += d);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok); assert.ok(output.includes('standalone mode'));
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('renderer/index.html')));
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; }); let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const result = JSON.parse(data); if (result.method === 'Runtime.exceptionThrown') exceptions.push(result.params.exceptionDetails.text); pending.get(result.id)?.(result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => reject(new Error('CDP timeout')), 20000); pending.set(key, (result) => { clearTimeout(timer); pending.delete(key); result.error ? reject(new Error(result.error.message)) : resolve(result.result); }); socket.send(JSON.stringify({ id: key, method, params })); });
  await send('Runtime.enable');
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await waitFor(() => evaluate('document.querySelector("#project-name")?.textContent==="Untitled Project"'));
  const call = async (action, args = {}) => { const result = await (await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json(); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const fonts = await call('font_list'); assert.equal(fonts.fonts[0].bundled, true); assert.equal(fonts.fonts[0].license, 'OFL-1.1');
  const title = (await call('title_add', { text: 'Bundled font Δ Ж', start: 0, end: 1, style: { fontSize: 128, outlineWidth: 0, color: '#00ff00' } })).title;
  await waitFor(async () => {
    const state = await evaluate('(()=>{const c=document.querySelector("#program-canvas"),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let green=0;for(let i=0;i<p.length;i+=4)if(p[i]<30&&p[i+1]>150&&p[i+2]<30)green++;return{green,quality:document.querySelector("#preview-quality").textContent}})()');
    if (state.quality.includes('failed') || state.quality.includes('changed') || state.quality.includes('missing')) throw new Error(JSON.stringify(state));
    return state.green > 300;
  });
  assert.deepEqual(exceptions, []); console.log('PASS: standalone Electron bundled OFL font produces actual green glyphs without an MCP process');
  await call('title_remove', { titleId: title.id });
} catch (error) { console.error(output); throw error; }
finally {
  socket?.close(); if (child && child.exitCode === null) { child.kill(); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (!path.resolve(workspace).startsWith(path.join(ROOT, '.tmp') + path.sep)) throw new Error('Unsafe standalone fixture cleanup'); await fs.rm(workspace, { recursive: true, force: true });
}
