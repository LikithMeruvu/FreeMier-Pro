/** Actual stdio MCP -> actual Electron renderer acceptance. No substitute SSE viewer. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ELECTRON = createRequire(import.meta.url)('electron');
const screenshotOnly = process.argv.includes('--screenshot-only');
const screenshotPath = process.argv.find((v) => v.endsWith('.png')) ?? path.join(ROOT, 'docs/screenshot.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = promisify(execFile);
const checks = [];
const check = (name, evidence) => { checks.push({ name, evidence }); console.log(`PASS: ${name}`); };

async function waitFor(label, fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  return port;
}
class Rpc {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        try { const response = JSON.parse(line); this.pending.get(response.id)?.(response); } catch { /* non-protocol output */ }
      }
    });
  }
  request(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 20000);
      this.pending.set(id, (response) => { clearTimeout(timer); this.pending.delete(id); response.error ? reject(new Error(response.error.message)) : resolve(response.result); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(`${name}: ${body.error.message}`);
    return body;
  }
}
class Cdp {
  async connect(url) {
    this.id = 0; this.pending = new Map(); this.loadEvents = 0; this.errors = [];
    this.socket = new WebSocket(url);
    await new Promise((r, reject) => { this.socket.onopen = r; this.socket.onerror = reject; });
    this.socket.onmessage = ({ data }) => {
      const response = JSON.parse(data);
      if (response.method === 'Page.loadEventFired') this.loadEvents++;
      if (response.method === 'Runtime.exceptionThrown') this.errors.push(response.params.exceptionDetails.text);
      this.pending.get(response.id)?.(response);
    };
    await this.send('Page.enable'); await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, (r) => { clearTimeout(timer); this.pending.delete(id); r.error ? reject(new Error(r.error.message)) : resolve(r.result); });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() { this.socket?.close(); }
}
const snapshotExpression = `(() => {
  const canvas = document.querySelector('#timeline');
  const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  let hash=2166136261, clipPixels=0;
  for(let i=0;i<pixels.length;i+=4){ hash=Math.imul(hash^pixels[i]^pixels[i+1]^pixels[i+2],16777619); if(pixels[i]===59 && pixels[i+1]===110 && pixels[i+2]===165)clipPixels++; }
  return {name:document.querySelector('#project-name').textContent,revision:Number(document.querySelector('#revision').textContent.replace('rev ','')),
    media:document.querySelectorAll('.media-item').length, thumbs:[...document.querySelectorAll('.media-thumb')].filter(x=>x.complete && x.naturalWidth>0).length,
    canvas:{width:canvas.width,height:canvas.height,hash:hash>>>0,clipPixels,waveformPeaks:Number(canvas.dataset.waveformPeaks??0)},
    audio:[...document.querySelectorAll('#preview-stage audio')].map(v=>({clipId:v.dataset.clipId,readyState:v.readyState,time:v.currentTime})),
    videos:[...document.querySelectorAll('#preview-stage video')].map(v=>({clipId:v.dataset.clipId,src:v.src,error:v.error?.message,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,time:v.currentTime,paused:v.paused,transform:v.style.transform,opacity:v.style.opacity})),
    timecode:document.querySelector('#timecode').textContent, timeOrigin:performance.timeOrigin, url:location.href}; })()`;
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let server, gui, cdp, workspace;
let serverError = '', guiError = '';
try {
  const tempRoot = path.join(ROOT, '.tmp'); await fs.mkdir(tempRoot, { recursive: true });
  workspace = await fs.mkdtemp(path.join(tempRoot, 'live-'));
  const port = await freePort(), debugPort = await freePort();
  const output = path.join(workspace, 'gui-export.mp4');
  const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port),
    FREEMIER_TEST_MODE: '1', FREEMIER_TEST_DIALOGS: JSON.stringify({ media: [path.join(ROOT, 'fixtures/media/clipB.mp4')], output }) };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn(process.execPath, [path.join(ROOT, 'packages/mcp/dist/cli.js')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  server.stderr.on('data', (d) => { serverError += d; });
  const rpc = new Rpc(server);
  await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'electron-acceptance', version: '1' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await rpc.request('tools/list')).tools; assert.ok(tools.length >= 30);
  check('stdio MCP handshake and >=30 tools', { toolCount: tools.length });
  await waitFor('MCP bridge', async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);
  await rpc.call('project_create', { name: screenshotOnly ? 'Launch Video' : 'MCP Live Acceptance', fps: 30, width: 640, height: 360 });
  gui = spawn(ELECTRON, [path.join(ROOT, 'packages/gui'), `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  gui.stdout.on('data', (d) => { guiError += d; }); gui.stderr.on('data', (d) => { guiError += d; });
  const target = await waitFor('Electron renderer CDP', async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
  });
  cdp = new Cdp(); await cdp.connect(target.webSocketDebuggerUrl);
  const read = () => cdp.evaluate(snapshotExpression);
  const initial = await waitFor('initial rendered project', async () => { const s = await read(); return s.revision >= 1 && s.name.includes(screenshotOnly ? 'Launch' : 'Acceptance') && s; });
  const loadCount = cdp.loadEvents;
  check('actual Electron loaded project', initial);
  const media = await rpc.call('media_import', { path: path.join(ROOT, 'fixtures/media/clipA.mp4'), copyIntoProject: true });
  assert.equal(media.asset.copied, true);
  await waitFor('MCP media rendered', async () => (await read()).media === 1);
  const timeline = await rpc.call('timeline_inspect');
  const videoTrack = timeline.tracks.find((t) => t.kind === 'video');
  const added = await rpc.call('clip_add', { trackId: videoTrack.id, assetId: media.asset.id, start: 0, duration: 3, label: 'Opening shot' });
  const decoded = await waitFor('decoded preview and painted clip', async () => {
    const s = await read(); if(s.videos.some(v=>v.error)) throw new Error(JSON.stringify(s)); return s.videos.some((v) => v.width === 640 && v.height === 360 && v.readyState >= 2) && s.canvas.clipPixels > 100 && s.thumbs === 1 && s;
  });
  assert.notEqual(decoded.canvas.hash, initial.canvas.hash);
  check('MCP import/add painted timeline, thumbnail and decoded preview', decoded);
  await rpc.call('clip_set_transform', { clipId: added.clip.id, scale: 0.5, x: 0.2, opacity: 0.8 });
  const transformed = await waitFor('rendered MCP transform', async () => { const s = await read(); return s.videos.some((v) => v.transform.includes('scale(0.5)') && v.opacity === '0.8') && s; });
  assert.ok(transformed.revision > decoded.revision);
  assert.equal(transformed.timeOrigin, initial.timeOrigin); assert.equal(transformed.url, initial.url); assert.equal(cdp.loadEvents, loadCount);
  check('MCP transform/revision changed without renderer navigation/reload', transformed);
  // Only the native dialog's returned selection is controlled. Click the real renderer button.
  await cdp.evaluate(`document.querySelector('#btn-import').click()`);
  await waitFor('GUI import on owning store', async () => (await read()).media === 2);
  const library = await rpc.call('media_list');
  const importedB = library.media.find((m) => m.name === 'clipB.mp4'); assert.ok(importedB);
  await rpc.call('clip_add', { trackId: videoTrack.id, assetId: importedB.id, start: 3, duration: 2, label: 'Product demo' });
  await waitFor('second timeline clip rendered', async () => (await read()).timecode.endsWith('/ 00:05.00'));
  check('GUI import updated MCP-owned project', { mediaCount: library.media.length });
  await cdp.evaluate(`(() => { const c=document.querySelector('#timeline'),r=c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+54+(r.width-54)*.1,clientY:r.top+22+18,bubbles:true})); })()`);
  await waitFor('inspector controls', () => cdp.evaluate(`!!document.querySelector('input[aria-label="Scale"]')`));
  await cdp.evaluate(`(() => { const i=document.querySelector('input[aria-label="Scale"]'); i.value='0.65'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor('inspector scale reflected in decoded preview', async () => (await read()).videos.some((v) => v.transform.includes('scale(0.65)')));
  assert.equal((await rpc.call('clip_inspect', { clipId: added.clip.id })).clip.transform.scale.value, 0.65);
  check('inspector edited same project and preview', { scale: 0.65 });
  await cdp.evaluate(`document.querySelector('#btn-play').click()`);
  const played = await waitFor('actual video playback', async () => { const s = await read(); return s.videos.some((v) => !v.paused && v.time > .6) && s; });
  await cdp.evaluate(`document.querySelector('#btn-play').click(); (() => { const i=document.querySelector('#scrub'); i.value='700'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const scrubbed = await waitFor('scrub to second clip source', async () => { const s = await read(); return s.videos.some((v) => v.clipId !== added.clip.id && v.readyState >= 2 && Math.abs(v.time-.5) < .15) && s; });
  const paintedPlayhead = await cdp.evaluate(`(() => { const c=document.querySelector('#timeline'), dpr=devicePixelRatio, x=Math.round(c._xOf(3.5)*dpr), y=Math.round(30*dpr); return [...c.getContext('2d').getImageData(x,y,1,1).data]; })()`);
  assert.ok(paintedPlayhead[0] > 160 && paintedPlayhead[0] > paintedPlayhead[1] && paintedPlayhead[1] > paintedPlayhead[2], 'scrub must repaint the orange playhead at the requested time');
  check('real playback and scrub reached second decoded clip', { played, scrubbed, paintedPlayhead });
  const audioTrack = timeline.tracks.find((t) => t.kind === 'audio');
  await rpc.call('clip_add', { trackId: audioTrack.id, assetId: media.asset.id, start: 0, duration: 5, label: 'Soundtrack' });
  const audio = await waitFor('decoded audio and real waveform peaks', async () => { const s=await read(); return s.audio.some((a)=>a.readyState>=2) && s.canvas.waveformPeaks>=600 && s; });
  check('same-source audio uses separate decoder and actual waveform peaks', { audio:audio.audio,waveformPeaks:audio.canvas.waveformPeaks });
  if (!screenshotOnly) {
    await cdp.evaluate(`window.__exportUpdates=[]; new MutationObserver(()=>window.__exportUpdates.push({text:document.querySelector('#btn-export').textContent,progress:document.querySelector('#btn-export').dataset.progress})).observe(document.querySelector('#btn-export'),{childList:true,subtree:true,attributes:true}); document.querySelector('#btn-export').click();`);
    await waitFor('GUI export finished', async () => { await fs.stat(output); return cdp.evaluate(`!document.querySelector('#btn-export').disabled && document.querySelector('#toast').textContent.startsWith('Exported ')`); }, 120000);
    const progress = await cdp.evaluate('window.__exportUpdates');
    assert.ok(progress.some((p) => p.progress === '0')); assert.ok(progress.some((p) => p.progress === '1'));
    const probe = JSON.parse((await exec('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',output], { windowsHide:true })).stdout);
    assert.equal(probe.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
    assert.ok(Math.abs(Number(probe.format.duration)-5) <= 1/30);
    await exec('ffmpeg', ['-v','error','-i',output,'-f','null','-'], { windowsHide:true });
    await fs.copyFile(output, path.join(ROOT,'docs/acceptance-export.mp4'));
    check('GUI export reported 0..100%, H.264 duration within one frame and decoded completely', { progress, duration: probe.format.duration, size: probe.format.size });
  }
  await cdp.evaluate(`(() => { const i=document.querySelector('#scrub'); i.value='100'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor('screenshot decoded first clip and thumbnails', async () => { const s = await read(); return s.thumbs === 2 && s.videos.some((v) => v.clipId === added.clip.id && v.readyState >= 2 && Math.abs(v.time-.5)<.15); });
  const final = await read(); assert.equal(final.timeOrigin, initial.timeOrigin); assert.equal(cdp.loadEvents, loadCount); assert.deepEqual(cdp.errors, []);
  const capture = await cdp.send('Page.captureScreenshot', { format:'png' });
  await fs.mkdir(path.dirname(screenshotPath), { recursive:true }); await fs.writeFile(screenshotPath, Buffer.from(capture.data,'base64'));
  check('real app screenshot captured after decode', { screenshotPath, rendererErrors:cdp.errors, loadEvents:cdp.loadEvents });
  if (!screenshotOnly) await fs.writeFile(path.join(ROOT,'docs/live-acceptance.json'), JSON.stringify({ date:new Date().toISOString(), platform:process.platform, checks, final },null,2)+'\n');
  console.log(`RESULT: ${checks.length} real-app checks passed`);
} catch (error) {
  console.error(error.stack); console.error('MCP stderr:',serverError.slice(-2500)); console.error('Electron output:',guiError.slice(-4000)); process.exitCode=1;
} finally {
  cdp?.close(); await stop(gui); await stop(server);
  if (workspace) {
    const resolved=path.resolve(workspace); assert.ok(resolved.startsWith(path.join(ROOT,'.tmp')+path.sep));
    await fs.rm(resolved,{recursive:true,force:true});
  }
}
