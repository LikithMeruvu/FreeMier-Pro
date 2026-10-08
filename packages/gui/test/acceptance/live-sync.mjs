/** Real stdio MCP + production Electron acceptance. Only native dialog selections are substituted. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ELECTRON = createRequire(import.meta.url)('electron');
const screenshotOnly = process.argv.includes('--screenshot-only');
const textOnly = process.argv.includes('--text-only');
const screenshotPath = process.argv.find((v) => v.endsWith('.png')) ?? path.join(ROOT, 'docs/freemier-pro.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), exec = promisify(execFile), checks = [];
const check = (name, evidence = {}) => { checks.push({ name, evidence }); console.log('PASS: ' + name); };
async function waitFor(label, fn, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await sleep(100); }
  throw new Error('Timeout: ' + label + (last ? ' (' + last.message + ')' : ''));
}
async function freePort() { const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }
class Rpc {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); let buffer = '';
    child.stdout.on('data', (chunk) => { buffer += chunk; let split; while ((split = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); try { const result = JSON.parse(line); this.pending.get(result.id)?.(result); } catch {} } });
  }
  request(method, params = {}) {
    const id = ++this.id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP timeout: ' + method)); }, 120000);
      this.pending.set(id, (result) => { clearTimeout(timer); this.pending.delete(id); result.error ? reject(new Error(result.error.message)) : resolve(result.result); }); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args = {}) { const result = await this.request('tools/call', { name, arguments: args }), body = JSON.parse(result.content[0].text); if (result.isError) throw new Error(name + ': ' + body.error.message); return body; }
}
class Cdp {
  async connect(url) {
    this.id = 0; this.pending = new Map(); this.errors = []; this.loads = 0; this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = ({ data }) => { const result = JSON.parse(data); if (result.method === 'Page.loadEventFired') this.loads++; if (result.method === 'Runtime.exceptionThrown') this.errors.push(result.params.exceptionDetails.exception?.description ?? result.params.exceptionDetails.text); this.pending.get(result.id)?.(result); };
    await this.send('Page.enable'); await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this.id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000); this.pending.set(id, (result) => { clearTimeout(timer); this.pending.delete(id); result.error ? reject(new Error(result.error.message)) : resolve(result.result); }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.socket?.close(); }
}
const snapshot = `(() => {
  const canvas=document.querySelector('#timeline'), pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  let hash=0,clipPixels=0,markerPixels=0;for(let i=0;i<pixels.length;i+=4){hash=Math.imul(hash^pixels[i]^pixels[i+1]^pixels[i+2],16777619);if(pixels[i]===59&&pixels[i+1]===110&&pixels[i+2]===165)clipPixels++;if(i<canvas.width*Number(canvas.dataset.rulerHeight)*devicePixelRatio*4&&pixels[i]===255&&pixels[i+1]===0&&pixels[i+2]===128)markerPixels++;}
  const program=document.querySelector('#program-canvas'),data=program.getContext('2d').getImageData(0,0,program.width,program.height).data;
  let spread=0,luma=0;for(let i=0;i<data.length;i+=4){spread+=Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2]);luma+=(data[i]+data[i+1]+data[i+2])/3;}
  const media=(selector)=>[...document.querySelectorAll(selector)].map(v=>{
    let decodedLuma; if(v.tagName==='VIDEO'&&v.readyState>=2){const c=document.createElement('canvas');c.width=c.height=16;const x=c.getContext('2d');x.drawImage(v,0,0,16,16);const p=x.getImageData(0,0,16,16).data;let sum=0;for(let i=0;i<p.length;i+=4)sum+=(p[i]+p[i+1]+p[i+2])/3;decodedLuma=sum/256;}
    return {clipId:v.dataset.clipId,assetId:v.dataset.assetId,width:v.videoWidth,height:v.videoHeight,ready:v.readyState,time:v.currentTime,paused:v.paused,decodedLuma,gain:Number(v.dataset.gain??1),transform:v.dataset.transform?JSON.parse(v.dataset.transform):null,error:v.error?.message};});
  return {name:document.querySelector('#project-name').textContent,revision:Number(document.querySelector('#revision').textContent.replace('rev ','')),media:document.querySelectorAll('.media-item').length,thumbs:[...document.querySelectorAll('.media-thumb')].filter(i=>i.complete&&i.naturalWidth>0).length,
    timeline:{width:canvas.width,height:canvas.height,hash:hash>>>0,clipPixels,markerPixels,waveformPeaks:Number(canvas.dataset.waveformPeaks??0),pps:Number(canvas.dataset.pps)},
    program:{width:program.width,height:program.height,spread:spread/(data.length/4),luma:luma/(data.length/4)},videos:media('#preview-stage video'),audio:media('#preview-stage audio'),source:media('#source-stage video'),timecode:document.querySelector('#timecode').textContent,
    sourceTime:document.querySelector('#source-timecode').textContent,sourceRange:document.querySelector('#source-range').textContent,workspace:document.body.dataset.workspace,tool:document.querySelector('[data-tool].active')?.dataset.tool,note:document.querySelector('#preview-note').textContent,toast:document.querySelector('#toast').textContent,origin:performance.timeOrigin};})()`;
async function stop(child) { if (!child || child.exitCode !== null) return; if (process.platform === 'win32') await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else child.kill(); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(4000)]); if (child.exitCode === null) child.kill('SIGKILL'); }

let server, gui, cdp, workspace, serverError = '', guiError = '';
try {
  await fs.mkdir(path.join(ROOT, '.tmp'), { recursive: true }); workspace = await fs.mkdtemp(path.join(ROOT, '.tmp/live-'));
  const port = await freePort(), debugPort = await freePort(), output = path.join(workspace, 'gui-export.mp4'), projectPath = path.join(workspace, 'Acceptance.freemier');
  const presetFile = path.join(workspace, 'Sepia.fmfx.json'), presetOutput = path.join(workspace, 'Saved.fmfx.json');
  await fs.writeFile(presetFile, JSON.stringify({ format: 'freemier-effect-preset', version: 1, name: 'Imported warm image', description: 'Independent golden tone with one adjustable amount', author: 'Synthetic acceptance', tags: ['golden'], media: 'video', effects: [{ type: 'sepia', enabled: true, params: { amount: 1 } }] }));
  const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1', FREEMIER_TEST_DIALOGS: JSON.stringify({ media: [path.join(ROOT, 'fixtures/media/clipB.mp4')], output, project: projectPath, preset: presetFile, presetOutput }) }; delete env.ELECTRON_RUN_AS_NODE;
  server = spawn(process.execPath, [path.join(ROOT, 'packages/mcp/dist/cli.js')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); server.stderr.on('data', (d) => serverError += d);
  const rpc = new Rpc(server); await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'professional-electron-acceptance', version: '2' } }); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc.request('tools/list')).tools; assert.equal(tools.length, 82); check('real stdio handshake discovers 82 tools', { count: tools.length });
  await waitFor('owning bridge', async () => (await fetch('http://127.0.0.1:' + port + '/health')).ok);
  await rpc.call('project_create', { name: 'Framecraft · Launch Film', fps: 30, width: 640, height: 360 });
  gui = spawn(ELECTRON, [path.join(ROOT, 'packages/gui'), '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); gui.stdout.on('data', (d) => guiError += d); gui.stderr.on('data', (d) => guiError += d);
  const target = await waitFor('production Electron CDP', async () => (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => t.type === 'page' && t.url.includes('renderer/index.html')));
  cdp = new Cdp(); await cdp.connect(target.webSocketDebuggerUrl);
  await cdp.evaluate('window.__nativeClicks=[];document.addEventListener("pointerdown",e=>window.__nativeClicks.push({type:"down",id:e.target.id,tag:e.target.tagName,x:e.clientX,y:e.clientY}),true);document.addEventListener("click",e=>window.__nativeClicks.push({type:"click",id:e.target.id,tag:e.target.tagName,x:e.clientX,y:e.clientY}),true)');
  // Use the production window's real viewport and DPI. A larger emulated
  // viewport would hide the bottom of the UI in native Windows captures.
  const read = () => cdp.evaluate(snapshot);
  async function click(selector) {
    const point = await waitFor('enabled hit-testable control ' + selector, () => cdp.evaluate('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');if(!e||e.disabled||!e.getClientRects().length)return false;e.scrollIntoView({block:"nearest",inline:"nearest"});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return e.contains(document.elementFromPoint(x,y))&&{x,y};})()'));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  const input = (selector, value, event = 'change') => cdp.evaluate('(()=>{const i=document.querySelector(' + JSON.stringify(selector) + ');i.value=' + JSON.stringify(String(value)) + ';i.dispatchEvent(new Event(' + JSON.stringify(event) + ',{bubbles:true}));})()');
  const keyboard = (key, extra = {}) => cdp.evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",' + JSON.stringify({ key, bubbles: true, ...extra }) + '))');
  const initial = await waitFor('rendered owning project', async () => { const s = await read(); return s.name.includes('Framecraft') && s.revision >= 1 && s; }), loads = cdp.loads;
  check('professional workspace attaches to owning MCP project', { revision: initial.revision, programSize: initial.program });
  let final;
  if (!textOnly) {
  const imported = await rpc.call('media_import', { path: path.join(ROOT, 'fixtures/media/clipA.mp4'), copyIntoProject: true }), assetA = imported.asset;
  const timeline = await rpc.call('timeline_inspect'), v1 = timeline.tracks.find((t) => t.kind === 'video').id, a1 = timeline.tracks.find((t) => t.kind === 'audio').id;
  const first = (await rpc.call('clip_add', { trackId: v1, assetId: assetA.id, duration: 3, label: '01  Opening motion' })).clip;
  const decoded = await waitFor('decoded program/thumbnails/timeline', async () => { const s = await read(); return s.thumbs === 1 && s.videos.some((v) => v.ready >= 2 && v.width === 640) && s.timeline.clipPixels > 100 && s.program.luma > 10 && s; });
  assert.notEqual(initial.timeline.hash, decoded.timeline.hash); assert.ok(!decoded.note.includes('error')); check('MCP import/add paints timeline and real Program canvas', decoded.program);
  const range = await fetch('http://127.0.0.1:' + port + '/media/' + assetA.id, { headers: { Range: 'bytes=0-31', Origin: 'null' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32); assert.equal(range.headers.get('access-control-allow-origin'), 'null');
  assert.equal((await fetch('http://127.0.0.1:' + port + '/media/not-imported')).status, 404); check('range-aware imported-media route supplies CORS-safe pixels');
  await rpc.call('clip_set_transform', { clipId: first.id, scale: .65, x: .12, opacity: .8 });
  await waitFor('MCP transform', async () => (await read()).videos.some((v) => v.transform?.scale === .65 && v.transform?.opacity === .8)); check('live MCP transform uses shared Program evaluation without reload');
  await click('#btn-import'); await waitFor('GUI import', async () => (await read()).media === 2);
  const assetB = (await rpc.call('media_list')).media.find((a) => a.name === 'clipB.mp4');
  const second = (await rpc.call('clip_add', { trackId: v1, assetId: assetB.id, start: 3, duration: 2, label: '02  Product detail' })).clip;
  await waitFor('frame timecode', async () => (await read()).timecode.endsWith('/ 00:00:05:00')); check('native GUI import edits the owning MCP library');
  async function point(trackId, time) {
    await waitFor('timeline snapshot reaches renderer before gesture', async () => (await read()).revision === (await rpc.call('project_info')).revision);
    await waitFor('painted track header ' + trackId, () => cdp.evaluate('!!document.querySelector(".track-header[data-track-id=' + trackId + ']")'));
    return cdp.evaluate('(()=>{const c=document.querySelector("#timeline"),s=document.querySelector("#timeline-scroll"),i=[...document.querySelectorAll(".track-header")].findIndex(t=>t.dataset.trackId===' + JSON.stringify(trackId) + '),y=Number(c.dataset.rulerHeight)+i*Number(c.dataset.trackHeight)+30;if(y<s.scrollTop||y>s.scrollTop+s.clientHeight-8)s.scrollTop=Math.max(0,y-s.clientHeight/2);const x=c._xOf(' + time + ');if(x<s.scrollLeft||x>s.scrollLeft+s.clientWidth-8)s.scrollLeft=Math.max(0,x-s.clientWidth/2);const r=c.getBoundingClientRect();return {x:r.left+x-s.scrollLeft,y:r.top+y-s.scrollTop};})()');
  }
  async function gesture(trackId, time, delta = 0) {
    const p = await point(trackId, time), pixels = (await read()).timeline.pps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    if (delta) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + delta * pixels, y: p.y, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + delta * pixels, y: p.y, button: 'left', clickCount: 1 });
  }
  await gesture(v1, .5); await input('input[aria-label="Scale"]', .75);
  await waitFor('inspector scale in MCP', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.transform.scale.value === .75); check('real clip selection and transform inspector update MCP');
  await click('#btn-play'); await waitFor('actual playback', async () => (await read()).videos.some((v) => !v.paused && v.time > .7)); await click('#btn-play');
  await input('#scrub', 700, 'input'); await waitFor('second decoded clip scrub', async () => (await read()).videos.some((v) => v.clipId === second.id && v.ready >= 2 && Math.abs(v.time - .5) < .15)); check('Program playback and scrub decode the correct source window');
  await click('#btn-next'); await waitFor('decoded next Program frame', async () => (await read()).videos.some((v) => v.clipId === second.id && Math.abs(v.time - 16 / 30) < .001)); assert.ok((await read()).timecode.startsWith('00:00:03:16'));
  await click('#btn-prev'); await waitFor('decoded previous Program frame', async () => (await read()).videos.some((v) => v.clipId === second.id && Math.abs(v.time - .5) < .001)); check('frame stepping seeks real decoded Program media and HH:MM:SS:FF transport');
  await cdp.evaluate('document.querySelector(".media-item[data-asset-id=' + assetB.id + ']").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
  await waitFor('independent decoded source', async () => (await read()).source.some((v) => v.width === 640 && v.ready >= 2));
  await click('#source-next'); await waitFor('decoded next Source frame', async () => (await read()).source.some((v) => Math.abs(v.time - 1 / 30) < .001)); await click('#source-prev'); await waitFor('decoded previous Source frame', async () => (await read()).source.some((v) => Math.abs(v.time) < .001));
  const programTime = (await read()).timecode; await input('#source-scrub', 1000 / assetB.duration, 'input'); await click('#source-in'); await input('#source-scrub', 3000 / assetB.duration, 'input'); await click('#source-out');
  assert.equal((await read()).timecode, programTime); assert.ok((await read()).sourceRange.includes('I 00:00:01:00') && (await read()).sourceRange.includes('O 00:00:03:00'));
  await input('#source-placement', 'append'); await input('#source-track', v1); await click('#source-place');
  const placed = await waitFor('marked source placed', async () => { const clips = (await rpc.call('track_inspect', { trackId: v1 })).track.clips; return clips.find((c) => c.start === 5 && c.sourceIn === 1 && c.duration === 2); });
  check('independent Source I/O places a real marked range on selected track', { start: placed.start, sourceIn: placed.sourceIn, duration: placed.duration });
  await input('#bin-search', 'clipB', 'input'); await waitFor('shared media search painted', async () => (await read()).media === 1 && await cdp.evaluate('document.querySelector(".media-item").dataset.assetId===' + JSON.stringify(assetB.id))); await click('#bin-view'); assert.equal(await cdp.evaluate('document.querySelector("#media-bin").classList.contains("list")'), true); await input('#bin-search', '', 'input'); await waitFor('cleared media search painted', async () => (await read()).media === 2); await click('#bin-view'); check('searchable media bin with functional grid/list view');
  await click('#btn-add-video'); const v2 = await waitFor('GUI added video track', async () => (await rpc.call('timeline_inspect')).tracks.find((t) => t.kind === 'video' && t.id !== v1)?.id);
  const drop = await point(v2, 1); await cdp.evaluate('(()=>{const d=new DataTransfer();d.setData("application/x-freemier-asset",' + JSON.stringify(assetA.id) + ');document.querySelector("#timeline").dispatchEvent(new DragEvent("drop",{dataTransfer:d,clientX:' + drop.x + ',clientY:' + drop.y + ',bubbles:true}));})()');
  await waitFor('dropped media placed and painted', async () => (await rpc.call('track_inspect', { trackId: v2 })).track.clips.length === 1 && (await read()).timecode.endsWith('/ 00:00:11:00'));
  const droppedPixels = (await read()).timeline.clipPixels;
  await click('#btn-undo'); await waitFor('GUI undo repaints', async () => (await rpc.call('track_inspect', { trackId: v2 })).track.clips.length === 0 && (await read()).timeline.clipPixels < droppedPixels && (await read()).timecode.endsWith('/ 00:00:07:00'));
  await click('#btn-redo'); await waitFor('GUI redo repaints', async () => (await rpc.call('track_inspect', { trackId: v2 })).track.clips.length === 1 && (await read()).timeline.clipPixels >= droppedPixels && (await read()).timecode.endsWith('/ 00:00:11:00'));
  await click('#btn-undo'); await waitFor('drop cleanup undo', async () => (await rpc.call('track_inspect', { trackId: v2 })).track.clips.length === 0 && (await read()).timecode.endsWith('/ 00:00:07:00'));
  check('media drag/drop, add track and GUI undo/redo use one owning history');
  await rpc.call('clip_add', { trackId: v2, assetId: assetB.id, start: 5, duration: 2, label: 'Detail alternate' });
  await gesture(v1, .5); await click('[data-browser="effects"]'); await click('[data-effect-type="grayscale"]');
  await waitFor('real grayscale preview', async () => { const s = await read(); return (await rpc.call('clip_inspect', { clipId: first.id })).clip.effects.some((e) => e.type === 'grayscale') && s.program.luma > 10 && s.program.spread < .1; }); check('effects browser creates real grayscale pixels in Program');
  await click('[data-browser="presets"]'); await input('#preset-name', 'Captured monochrome'); await input('#preset-description', 'Color removal for a documentary'); await click('#preset-capture');
  await waitFor('captured JSON', () => cdp.evaluate('document.querySelector("#preset-json").value.includes("Captured monochrome")'));
  const inspectRevision = (await rpc.call('project_info')).revision; await click('#preset-inspect'); await waitFor('descriptive dry-run', () => cdp.evaluate('document.querySelector("#preset-inspection").textContent.includes("declared-author-text")')); assert.equal((await rpc.call('project_info')).revision, inspectRevision);
  await click('#preset-import-json'); await waitFor('GUI captured preset import', async () => (await rpc.call('effect_preset_list')).presets.length === 1);
  await click('#preset-import-file'); const importedPreset = await waitFor('native file import described through MCP', async () => (await rpc.call('effect_preset_list', { query: 'golden' })).presets[0]);
  assert.equal(importedPreset.descriptionSource, 'declared-author-text'); assert.equal(importedPreset.effects[0].descriptor.params.amount.max, 1);
  await waitFor('imported preset card', () => cdp.evaluate('!!document.querySelector("[data-preset-id=' + importedPreset.id + ']")'));
  const presetCard = '[data-preset-id="' + importedPreset.id + '"]'; await click(presetCard + ' button[data-preset-apply="replace"]');
  await waitFor('preset produces actual sepia Program pixels', async () => (await read()).program.spread > 5 && (await rpc.call('effect_list', { clipId: first.id })).effects[0]?.type === 'sepia');
  await click('#btn-undo'); await waitFor('preset undo restores grayscale pixels', async () => (await read()).program.spread < .1); await click('#btn-redo'); await waitFor('preset redo restores sepia pixels', async () => (await read()).program.spread > 5); await click('#btn-undo'); await waitFor('preset restores original stack', async () => (await read()).program.spread < .1);
  await click(presetCard + ' button[title="Create a new .fmfx.json file"]'); await waitFor('GUI file export', async () => { try { return JSON.parse(await fs.readFile(presetOutput, 'utf8')).name === importedPreset.name; } catch { return false; } });
  check('GUI preset capture/inspect/import/export uses descriptive standard MCP and decoded Program/history');
  await rpc.call('effect_preset_apply', { presetId: importedPreset.id, clipId: first.id, mode: 'replace' }); await waitFor('MCP preset changes native preview', async () => (await read()).program.spread > 5); await rpc.call('undo'); await waitFor('MCP preset undo', async () => (await read()).program.spread < .1);
  assert.equal(cdp.loads, loads); check('MCP imported preset application updates actual Electron without reload');
  await click('[data-browser="effects"]');
  await click('#btn-start'); await input('input[aria-label="Opacity"]', .2); await waitFor('opacity static', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.transform.opacity.value === .2); await click('[data-key-property="opacity"]'); await waitFor('first key', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.transform.opacity.keyframes.length === 1);
  const dark = (await read()).program.luma; await input('#timecode-input', '00:00:01:00'); await input('input[aria-label="Opacity"]', 1);
  await waitFor('second key and brighter preview', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.transform.opacity.keyframes.length === 2 && (await read()).program.luma > dark * 3);
  await input('select[aria-label="Keyframe easing at 0"]', 'ease-in'); await waitFor('easing update', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.transform.opacity.keyframes[0].easing === 'ease-in');
  check('GUI keyframe CRUD/easing produces actual animated Program alpha', { firstLuma: dark, secondLuma: (await read()).program.luma });
  await keyboard('c'); const beforeReject = (await rpc.call('project_info')).revision; await gesture(v1, .5); await waitFor('truthful split refusal', async () => (await read()).toast.includes('local animation origin')); assert.equal((await rpc.call('project_info')).revision, beforeReject); await keyboard('v'); check('razor refuses unsupported animation rebasing without mutation');
  await cdp.evaluate('(()=>{const i=document.querySelector("#bin-search");i.focus();i.dispatchEvent(new KeyboardEvent("keydown",{key:"c",bubbles:true}));i.blur();})()'); assert.equal((await read()).tool, 'select'); check('keyboard editing shortcuts ignore editable input');
  await click('[data-workspace="color"]'); await click('#inspector button.accent'); await waitFor('color effect card', () => cdp.evaluate('!!document.querySelector("[data-effect-type=color_adjust] input[aria-label=gamma]")')); await input('[data-effect-type="color_adjust"] input[aria-label="gamma"]', 1.4);
  await waitFor('real color control', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.effects.some((e) => e.type === 'color_adjust' && e.params.gamma === 1.4));
  const gray = (await rpc.call('clip_inspect', { clipId: first.id })).clip.effects.find((e) => e.type === 'grayscale'); await click('input[aria-label="Enable grayscale"]'); await waitFor('disabled grayscale pixels', async () => (await read()).program.spread > 3); await click('input[aria-label="Enable grayscale"]'); check('Color workspace gamma and ordered effect enable controls are functional');
  const audio = (await rpc.call('clip_add', { trackId: a1, assetId: assetA.id, duration: 7, label: 'Production bed' })).clip;
  await waitFor('actual audio waveform', async () => (await read()).timeline.waveformPeaks >= 600);
  await gesture(a1, .5); await click('[data-workspace="audio"]'); await input('input[aria-label="Volume"]', 3); await waitFor('Web Audio gain > unity', async () => (await read()).audio.some((a) => a.clipId === audio.id && a.gain === 3)); await click('[data-effect-type="audio_fade"]');
  await waitFor('clip-local audio fade gain', async () => (await read()).audio.some((a) => a.clipId === audio.id && Math.abs(a.gain - 1.5) < .02)); await click('#btn-play'); await waitFor('measured decoded audio meter', () => cdp.evaluate('!document.querySelector("#audio-meter-label").textContent.includes("−∞")')); await click('#btn-play'); check('Audio workspace applies >unity gain/fade and measures real decoded RMS');
  await click('[data-workspace="edit"]'); await click('[data-track-lock="' + v1 + '"]'); await waitFor('locked track', async () => (await rpc.call('track_inspect', { trackId: v1 })).track.locked); await keyboard('y'); const lockedRev = (await rpc.call('project_info')).revision; await gesture(v1, .5, .2); await waitFor('locked GUI edit refusal', async () => (await read()).toast.includes('locked')); assert.equal((await rpc.call('project_info')).revision, lockedRev); await click('[data-track-lock="' + v1 + '"]'); await waitFor('unlocked track', async () => !(await rpc.call('track_inspect', { trackId: v1 })).track.locked); check('track lock protects actual GUI gestures with structured refusal');
  await gesture(v1, .5, .2); await waitFor('slip tool', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.sourceIn > .15); await click('#btn-undo'); await waitFor('slip undo', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.sourceIn === 0); check('slip drag adjusts source handles while preserving timeline/animation');
  await keyboard('n'); await gesture(v1, 1, .2); await waitFor('roll tool', async () => Math.abs((await rpc.call('clip_inspect', { clipId: first.id })).clip.duration - 3.2) < .01); await click('#btn-undo'); await waitFor('roll undo', async () => (await rpc.call('clip_inspect', { clipId: first.id })).clip.duration === 3); check('roll drag changes adjacent boundary atomically');
  await keyboard('c'); await gesture(v1, 4); await waitFor('razor unanimated clip', async () => (await rpc.call('track_inspect', { trackId: v1 })).track.clips.length === 4); await click('#btn-undo'); await waitFor('razor undo', async () => (await rpc.call('track_inspect', { trackId: v1 })).track.clips.length === 3); await keyboard('v'); await gesture(v1, 4.99, -.2); await waitFor('edge trim', async () => (await rpc.call('clip_inspect', { clipId: second.id })).clip.duration < 1.9); await click('#btn-undo'); check('razor and edge-trim gestures execute real edits and undo');
  await click('[data-track-mute="' + a1 + '"]'); await waitFor('audio mute removes decoder', async () => (await read()).audio.length === 0); await click('[data-track-mute="' + a1 + '"]'); await waitFor('audio unmute restores decoder', async () => (await read()).audio.some((a) => a.ready >= 2)); check('track mute/unmute controls actual media preview');
  const oldPps = (await read()).timeline.pps; await input('#timeline-zoom', 180, 'input'); assert.ok((await read()).timeline.pps > oldPps); await click('#btn-snap'); assert.equal(await cdp.evaluate('document.querySelector("#btn-snap").classList.contains("active")'), false); await click('#btn-snap'); await click('#zoom-fit'); check('timeline zoom/fit and snap toggle use real coordinate mapping');
  const hook = (await rpc.call('marker_add', { time: 1.5, label: 'Hook', notes: 'Opening\nBeat', color: '#ff0080' })).marker;
  await waitFor('actual MCP marker flag pixels', async () => (await read()).timeline.markerPixels > 20); await click('[data-browser="markers"]');
  await input('input[aria-label="Marker label ' + hook.id + '"]', 'Opening hook'); await waitFor('GUI marker edit', async () => (await rpc.call('marker_list')).markers.some((m) => m.id === hook.id && m.label === 'Opening hook'));
  await input('.marker-card[data-marker-id="' + hook.id + '"] input[aria-label="Time (seconds)"]', 1.6); await waitFor('marker time frame 48', async () => (await rpc.call('marker_list')).markers.some((m) => m.id === hook.id && m.frame === 48));
  await input('#timecode-input', '00:00:06:00'); await input('#marker-label', 'Detail beat'); await click('#marker-create');
  const detail = await waitFor('GUI marker creation reflected in MCP', async () => (await rpc.call('marker_list')).markers.find((m) => m.label === 'Detail beat' && m.frame === 180));
  await click('#marker-prev'); await waitFor('previous marker actual decoded frame', async () => (await read()).timecode.startsWith('00:00:01:18') && (await read()).videos.some((v) => v.clipId === first.id && Math.abs(v.time - 1.6) < .001)).catch(async (error) => { console.error('Marker navigation state:', JSON.stringify(await rpc.call('marker_list'))); console.error('Marker controls:', await cdp.evaluate('[...document.querySelectorAll(".marker-card")].map(e=>({id:e.dataset.markerId,time:e.querySelector("input[type=number]").value,button:e.querySelector("button").textContent}))')); console.error('Native click trace:', await cdp.evaluate('window.__nativeClicks.slice(-10)')); throw error; });
  await click('#marker-next'); await waitFor('next marker navigation', async () => (await read()).timecode.startsWith('00:00:06:00'));
  const outside = (await rpc.call('marker_add', { time: 11, label: 'Planning note beyond media' })).marker;
  await click('[data-marker-jump="' + outside.id + '"]'); await waitFor('marker outside content navigates without rendered-duration inflation', async () => (await read()).timecode === '00:00:11:00 / 00:00:07:00' && (await read()).videos.length === 0 && (await read()).program.luma === 0);
  await click('[data-marker-remove="' + detail.id + '"]'); await waitFor('marker deletion painted', async () => (await rpc.call('marker_list')).markers.length === 2 && !await cdp.evaluate('!!document.querySelector("[data-marker-id=' + detail.id + ']")'));
  await click('#btn-undo'); await waitFor('marker undo restores GUI', async () => (await rpc.call('marker_list')).markers.length === 3 && await cdp.evaluate('!!document.querySelector("[data-marker-id=' + detail.id + ']")'));
  await click('[data-marker-jump="' + hook.id + '"]'); await waitFor('hook decoded after marker undo', async () => (await read()).program.luma > 10); await click('[data-browser="project"]');
  check('MCP marker flags, GUI edit/create/delete/undo and navigation use fixed sequence frames');
  const openingTitle = (await rpc.call('title_add', { text: 'FreeMier Pro\nLaunch film', start: 0, end: 3, style: { fontSize: 26, x: .08, y: .88, align: 'left', verticalAlign: 'bottom', backgroundOpacity: .5, padding: 7 } })).title;
  await waitFor('MCP title receives rendered glyph preview', () => cdp.evaluate('document.querySelector("#preview-quality").textContent==="Shared CPU preview"&&document.querySelectorAll(".text-card[data-title-id]").length===1'));
  await click('#btn-save'); await waitFor('portable GUI save', async () => (await fs.stat(path.join(projectPath, 'project.json'))).size > 100); const saved = JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8')); assert.ok(saved.media.find((m) => m.id === assetA.id).copied); assert.ok((await fs.stat(path.join(projectPath, 'media', saved.media.find((m) => m.id === assetA.id).path))).size > 1000);
  await gesture(v1, 5.5); await click('#btn-delete'); await waitFor('edit after save', async () => (await rpc.call('track_inspect', { trackId: v1 })).track.clips.length === 2); await fs.unlink(path.join(workspace, 'media', assetA.path)); await click('#btn-open'); await waitFor('GUI load restores saved sequence', async () => (await rpc.call('track_inspect', { trackId: v1 })).track.clips.length === 3);
  assert.ok(path.isAbsolute((await rpc.call('media_inspect', { assetId: assetA.id })).asset.path)); check('save/load packages copied media and restores owning store after original copy removal');
  assert.equal((await rpc.call('effect_preset_list')).presets.length, 2);
  assert.equal((await rpc.call('marker_list')).markers.length, 3); assert.ok((await read()).timeline.markerPixels > 20); check('markers survive portable save/load without extending the seven-second export');
  const projectFile = path.join(projectPath, 'project.json'), validBytes = await fs.readFile(projectFile);
  const historyMarker = (await rpc.call('marker_add', { time: 0, label: 'Preserved load history' })).marker;
  await waitFor('history marker reaches GUI', async () => (await rpc.call('marker_list')).markers.length === 4 && (await read()).revision === (await rpc.call('project_info')).revision);
  const protectedInfo = await rpc.call('project_info'), protectedPaint = await read(), invalid = JSON.parse(validBytes);
  invalid.timeline.tracks.find((t) => t.clips.length).clips[0].transform.x.keyframes = [null];
  try {
    await fs.writeFile(projectFile, JSON.stringify(invalid));
    const refusal = await rpc.request('tools/call', { name: 'project_load', arguments: { path: projectPath } });
    assert.equal(refusal.isError, true); assert.equal(JSON.parse(refusal.content[0].text).error.code, 'INVALID_ARGUMENT');
    await click('#btn-open'); await waitFor('native invalid project error', async () => (await read()).toast.includes('Invalid project field'));
    assert.deepEqual(await rpc.call('project_info'), protectedInfo);
    const current = await read(); assert.equal(current.name, protectedPaint.name); assert.equal(current.revision, protectedPaint.revision); assert.equal(current.origin, protectedPaint.origin); assert.ok(current.program.luma > 10);
    await click('#btn-undo'); await waitFor('GUI undo retained after failed load', async () => !(await rpc.call('marker_list')).markers.some((m) => m.id === historyMarker.id));
    await click('#btn-redo'); await waitFor('GUI redo retained after failed load', async () => (await rpc.call('marker_list')).markers.some((m) => m.id === historyMarker.id));
    await click('#btn-undo'); await waitFor('restore original markers', async () => (await rpc.call('marker_list')).markers.length === 3);
    check('malformed project refused by MCP and native Open while decoded preview and GUI history survive');
  } finally { await fs.writeFile(projectFile, validBytes); }
  if (!screenshotOnly) {
    await cdp.evaluate('window.__exportUpdates=[];new MutationObserver(()=>window.__exportUpdates.push(document.querySelector("#btn-export").dataset.progress)).observe(document.querySelector("#btn-export"),{attributes:true});document.querySelector("#btn-export").click();');
    await waitFor('actual GUI export', async () => { await fs.stat(output); return cdp.evaluate('!document.querySelector("#btn-export").disabled&&document.querySelector("#toast").textContent.startsWith("Exported")'); }, 120000);
    const progress = await cdp.evaluate('window.__exportUpdates'); assert.ok(progress.includes('0')); assert.ok(progress.includes('1'));
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { windowsHide: true })).stdout); assert.equal(probe.streams.find((s) => s.codec_type === 'video').codec_name, 'h264'); assert.ok(Math.abs(Number(probe.format.duration) - 7) <= 1 / 30); await exec('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'], { windowsHide: true });
    await fs.copyFile(output, path.join(ROOT, 'docs/acceptance-export.mp4')); check('GUI effect/animation/audio export reports 0..100%, lasts seven seconds and fully decodes', { duration: probe.format.duration, progressEvents: progress.length });
  }
  // Actual decoded synthetic media and a clean published screenshot without path-bearing toasts.
  await rpc.call('effect_update', { clipId: first.id, effectId: gray.id, enabled: false }); await rpc.call('clip_set_transform', { clipId: first.id, scale: .95, x: .02, opacity: 1 });
  await rpc.call('keyframe_set', { clipId: first.id, property: 'opacity', time: 0, value: .75, easing: 'ease-in-out' }); await rpc.call('keyframe_set', { clipId: first.id, property: 'opacity', time: 2, value: 1 });
  await click('[data-workspace="edit"]'); await click('[data-browser="project"]'); await gesture(v1, 1); await input('#source-scrub', 1000 / assetB.duration, 'input');
  await waitFor('clean screenshot decoders', async () => { const s = await read(); return s.thumbs === 2 && s.source.some((v) => v.ready >= 2) && s.videos.some((v) => v.clipId === first.id && v.ready >= 2) && s.program.luma > 10; }).catch(async (error) => { console.error('Final clip:', JSON.stringify((await rpc.call('clip_inspect', { clipId: first.id })).clip)); throw error; }); await sleep(3500);
  final = await read(); assert.equal(final.origin, initial.origin); assert.equal(cdp.loads, loads); assert.deepEqual(cdp.errors, []); assert.ok(!final.note.includes('error'));
  assert.equal(await cdp.evaluate('(()=>{const e=document.querySelector("#source-place"),r=e.getBoundingClientRect(),p=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2),f=document.querySelector(".timeline-foot").getBoundingClientRect();return e.contains(p)&&r.bottom<=document.querySelector("#source-monitor").getBoundingClientRect().bottom&&f.bottom<=innerHeight;})()'), true);
  check('Source placement and timeline footer remain visible and hit-testable at native viewport');
  const capture = await cdp.evaluate('window.freemier.captureForTest()');
  const png = Buffer.from(capture, 'base64'); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(png.length > 10000);
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true }); await fs.writeFile(screenshotPath, png);
  check('decoded professional workspace screenshot with zero renderer errors/reloads', { screenshotPath: path.relative(ROOT, screenshotPath), source: final.source.map((s) => ({ width: s.width, height: s.height, ready: s.ready })), program: final.program });
  }
  await rpc.call('project_create', { name: 'Fractional-rate marker navigation', fps: 23.976 });
  await rpc.call('marker_add', { time: 14400 / 23.976, label: 'Ten minutes NDF', color: '#ff0080' });
  await waitFor('fractional project snapshot', async () => (await read()).name === 'Fractional-rate marker navigation');
  await input('#timecode-input', '00:10:00:00');
  await waitFor('fractional timecode navigation and virtual marker painting', async () => (await read()).timecode.startsWith('00:10:00:00') && (await read()).timeline.markerPixels > 20);
  assert.ok((await read()).timeline.width < 8192); assert.ok(await cdp.evaluate('document.querySelector("#timeline-scroll").scrollLeft>50000'));
  await input('#timecode-input', '00:60:00:00'); await waitFor('invalid timecode refusal', async () => (await read()).toast.includes('Invalid timecode')); assert.ok((await read()).timecode.startsWith('00:10:00:00'));
  assert.deepEqual(cdp.errors, []); assert.equal(cdp.loads, loads);
  check('fractional NDF parsing, invalid clock refusal and bounded Canvas paint at ten-minute marker');
  await rpc.call('project_create', { name: 'Styled title composition', width: 320, height: 180, fps: 10 });
  await waitFor('title project snapshot', async () => (await read()).name === 'Styled title composition');
  const title = (await rpc.call('title_add', { text: 'Real glyphs Δ Ж', start: .5, end: 2.5, style: { fontSize: 36, outlineWidth: 0 } })).title;
  const glyphs = () => cdp.evaluate('(()=>{const c=document.querySelector("#program-canvas"),d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let white=0,green=0,left=c.width,right=0;for(let i=0;i<d.length;i+=4){if(d[i]>180&&d[i+1]>180&&d[i+2]>180)white++;if(d[i]<30&&d[i+1]>150&&d[i+2]<30){green++;left=Math.min(left,i/4%c.width);right=Math.max(right,i/4%c.width)}}return{white,green,center:(left+right)/2,width:c.width}})()');
  await input('#timecode-input', '00:00:01:00'); await waitFor('actual white title-only preview pixels', async () => (await glyphs()).white > 400);
  await rpc.call('title_update', { titleId: title.id, style: { color: '#00ff00' } }); await waitFor('live title style changes rendered pixels', async () => (await glyphs()).green > 400 && (await glyphs()).white === 0);
  await input('#timecode-input', '00:00:02:05'); await waitFor('exclusive title end is black', async () => (await read()).program.luma === 0);
  await input('#timecode-input', '00:00:01:00'); await click('[data-browser="titles"]');
  await input('.text-card[data-title-id="' + title.id + '"] input[aria-label="Anchor X"]', .45); await waitFor('GUI anchor commits and actual glyphs move', async () => ((await rpc.call('title_list')).titles[0].style.x === .45) && Math.abs((await glyphs()).center - (await glyphs()).width * .45) < 5);
  await input('.text-card[data-title-id="' + title.id + '"] textarea', 'Edited title Δ Ж'); await waitFor('GUI title text commits', async () => (await rpc.call('title_list')).titles[0].text === 'Edited title Δ Ж');
  await click('.text-card[data-title-id="' + title.id + '"] button[title="Delete title"]'); await waitFor('title delete paints black', async () => (await rpc.call('title_list')).titles.length === 0 && (await read()).program.luma === 0);
  await click('#btn-undo'); await waitFor('title undo restores authored and painted range', async () => (await rpc.call('title_list')).titles.length === 1 && await cdp.evaluate('document.querySelectorAll(".text-card").length===1&&document.querySelector("#timecode").textContent.endsWith(" / 00:00:02:05")')); await input('#timecode-input', '00:00:01:00'); await waitFor('title undo restores actual glyphs', async () => (await glyphs()).green > 400);
  await input('#timecode-input', '00:00:03:00'); await input('#title-text', 'GUI created'); await click('#title-create'); await waitFor('GUI title creation changes content duration', async () => (await rpc.call('title_list')).titles.length === 2 && (await read()).timecode.endsWith(' / 00:00:05:05'));
  check('real title PNG preview, typed MCP/GUI CRUD, anchor movement, exclusive timing and undo');
  await click('#btn-save'); await waitFor('title portable save', async () => JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8')).timeline.titles?.length === 2);
  await rpc.call('title_remove', { titleId: title.id }); await click('#btn-open'); await waitFor('title portable load restores glyphs', async () => (await rpc.call('title_list')).titles.length === 2); await input('#timecode-input', '00:00:01:00'); await waitFor('loaded title glyphs', async () => (await glyphs()).green > 400);
  check('styled title persistence restores portable project and decoded preview');
  if (!screenshotOnly) {
    await click('#btn-export'); await waitFor('real title-only GUI export', async () => cdp.evaluate('!document.querySelector("#btn-export").disabled&&document.querySelector("#toast").textContent.startsWith("Exported")'), 120000);
    const { stdout } = await exec(process.env.FREEMIER_FFPROBE ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output], { windowsHide: true }); assert.ok(Math.abs(Number(JSON.parse(stdout).format.duration) - 5.5) < .15);
    const { stdout: rgba } = await exec(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-ss', '1', '-i', output, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); let green = 0; for (let i = 0; i < rgba.length; i += 4) if (rgba[i] < 40 && rgba[i+1] > 120 && rgba[i+2] < 40) green++; assert.ok(green > 400);
    check('native GUI exports title-only video with actual styled glyph pixels and text duration');
  }
  for (const item of (await rpc.call('title_list')).titles) await rpc.call('title_remove', { titleId: item.id });
  const captionImport = await rpc.call('captions_import', { content: '4\n00:00:00,503 --> 00:00:01,101\nCaption live pixels' });
  const cue = captionImport.imported[0]; assert.equal(cue.startMs, 503); assert.equal(cue.hasFrame, true);
  await input('#timecode-input', '00:00:01:00'); await waitFor('actual subtitle glyph preview', async () => (await glyphs()).white > 100);
  await click('[data-browser="captions"]'); await waitFor('professional captions panel and timeline', async () => cdp.evaluate('document.querySelectorAll(".caption-card").length===1&&document.querySelector("#caption-track-state").textContent.includes("enabled")'));
  await input('.caption-card[data-cue-id="' + cue.id + '"] textarea', 'GUI edited caption'); await waitFor('GUI caption edit reaches standard MCP', async () => (await rpc.call('captions_list')).cues[0].text === 'GUI edited caption');
  await click('.caption-card[data-cue-id="' + cue.id + '"] button[title="Seek caption"]');
  await waitFor('cue jump lands on first covered frame with painted glyphs', async () => (await read()).timecode.startsWith('00:00:00:06') && (await glyphs()).white > 100);
  await input('#caption-name', 'Dialogue'); await waitFor('caption label reaches owner', async () => (await rpc.call('captions_list')).track.name === 'Dialogue');
  await click('#caption-enabled'); await waitFor('native visibility disables pixels without truncating sequence', async () => (await rpc.call('captions_list')).track.enabled === false && (await glyphs()).white === 0 && (await read()).timecode.endsWith(' / 00:00:01:02'));
  await click('#btn-undo'); await waitFor('caption visibility undo restores glyphs', async () => (await rpc.call('captions_list')).track.enabled === true && (await glyphs()).white > 100);
  check('caption jump uses first covered frame and visibility/name/history preserve authored extent');
  await click('#caption-lock'); await waitFor('caption track lock state', async () => (await rpc.call('captions_list')).track.locked === true);
  await assert.rejects(rpc.call('caption_update', { cueId: cue.id, text: 'must refuse' }));
  await click('#caption-lock'); await waitFor('caption unlock reaches owning store', async () => (await rpc.call('captions_list')).track.locked === false);
  check('MCP SRT import, actual caption preview pixels, GUI edit and lock enforcement');
  await click('#btn-save'); await waitFor('caption portable save', async () => JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8')).timeline.captions?.name === 'Dialogue');
  await click('.caption-card[data-cue-id="' + cue.id + '"] button[title="Delete caption"]'); await waitFor('caption deletion paints black', async () => (await rpc.call('captions_list')).cues.length === 0 && (await read()).program.luma === 0);
  await click('#btn-open'); await waitFor('caption reload restores exact authored cue', async () => (await rpc.call('captions_list')).cues[0]?.startMs === 503);
  await click('.caption-card[data-cue-id="' + cue.id + '"] button[title="Seek caption"]'); await waitFor('caption reload glyphs', async () => (await glyphs()).white > 100);
  if (!screenshotOnly) {
    await input('#caption-policy', 'sidecar'); await click('#btn-export'); await waitFor('native caption sidecar export', async () => cdp.evaluate('!document.querySelector("#btn-export").disabled&&document.querySelector("#toast").textContent.startsWith("Exported")'), 120000);
    assert.ok((await fs.readFile(output + '.srt', 'utf8')).includes('00:00:00,503 --> 00:00:01,101\nGUI edited caption'));
    const probe = JSON.parse((await exec(process.env.FREEMIER_FFPROBE ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output], { windowsHide: true })).stdout); assert.ok(Math.abs(Number(probe.format.duration) - 1.2) < .01);
    const frame = (await exec(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-ss', '0.6', '-i', output, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout; assert.ok(frame.length > 0); assert.ok(frame.every((value) => value === 0));
    await input('#caption-policy', 'burn-in'); await click('#btn-export'); await waitFor('native caption burn-in export', async () => cdp.evaluate('!document.querySelector("#btn-export").disabled&&document.querySelector("#toast").textContent.startsWith("Exported")'), 120000);
    const pixels = (await exec(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-ss', '0.6', '-i', output, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout; assert.ok(pixels.some((value) => value > 180));
  }
  check('caption portable reload and native GUI burn-in/sidecar exports preserve milliseconds and decoded pixels');
  assert.deepEqual(cdp.errors, []); assert.equal(cdp.loads, loads);
  if (!screenshotOnly && !textOnly) await fs.writeFile(path.join(ROOT, 'docs/live-acceptance.json'), JSON.stringify({ date: new Date().toISOString(), platform: process.platform, checks, final }, null, 2) + '\n');
  console.log('RESULT: ' + checks.length + ' real-app checks passed');
} catch (error) {
  console.error(error.stack);
  if (cdp) try { console.error('Rendered failure state:', JSON.stringify(await cdp.evaluate(snapshot), null, 2)); const capture = await cdp.evaluate('window.freemier.captureForTest()'); await fs.writeFile(path.join(ROOT, '.tmp/gui-failure.png'), Buffer.from(capture, 'base64')); } catch {}
  console.error('MCP stderr:', serverError.slice(-2000)); console.error('Electron output:', guiError.slice(-3000)); process.exitCode = 1;
}
finally { cdp?.close(); await stop(gui); await stop(server); if (workspace) { const resolved = path.resolve(workspace); assert.ok(resolved.startsWith(path.join(ROOT, '.tmp') + path.sep)); await fs.rm(resolved, { recursive: true, force: true }); } }
