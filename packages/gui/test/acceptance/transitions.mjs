/** Visible transition CRUD and decoded program preview through one real Electron session. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveTransition } from '@freemier/shared/transitions';
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
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(interval); }
  throw new Error(`Timeout: ${label}${last ? ` ${last.message}` : ''}`);
}
async function freePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
const workspace = await fs.mkdtemp(path.join(root, '.tmp', 'transition-gui-'));
const port = await freePort(), debugPort = await freePort(), bridge = `http://127.0.0.1:${port}`;
const saved = path.join(workspace, 'Transitions.freemier'), source = path.join(workspace, 'synthetic-av.mp4'), output = path.join(workspace, 'transition-export.mp4');
const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1', FREEMIER_TEST_DIALOGS: JSON.stringify({ project: saved, output }) }; delete env.ELECTRON_RUN_AS_NODE;
let client, child, socket; const errors = [];
try {
  await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]', '-map', '[v]', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { windowsHide: true });
  client = new Client({ name: 'transition-electron-acceptance', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/mcp/dist/cli.js')], env }));
  const call = async (name, args = {}) => { const response = await client.callTool({ name, arguments: args }); const value = JSON.parse(response.content[0].text); if (response.isError) throw new Error(value.error.message); return value; };
  await waitFor('bridge', async () => (await fetch(bridge + '/health')).ok);
  await call('project_create', { name: 'Transition GUI acceptance', width: 320, height: 180, fps: 30 });
  const asset = (await call('media_import', { path: source, copyIntoProject: true })).asset;
  const tracks = (await call('timeline_inspect')).tracks, video = tracks.find((track) => track.kind === 'video'), audio = tracks.find((track) => track.kind === 'audio');
  const left = (await call('clip_add', { trackId: video.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 1, strict: true })).clip;
  const right = (await call('clip_add', { trackId: video.id, assetId: asset.id, start: 1, sourceIn: 2, duration: 1, strict: true })).clip;
  const audioLeft = (await call('clip_add', { trackId: audio.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 1, strict: true })).clip;
  const audioRight = (await call('clip_add', { trackId: audio.id, assetId: asset.id, start: 1, sourceIn: 2, duration: 1, label: 'Audio transition right', strict: true })).clip;
  await call('clip_add', { trackId: audio.id, assetId: asset.id, start: 2, sourceIn: 0, duration: 2, strict: true });
  child = spawn(electron, [path.join(root, 'packages/gui'), '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (data) => log += data); child.stderr.on('data', (data) => log += data);
  const target = await waitFor('Electron', async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((entry) => entry.type === 'page' && entry.url.includes('renderer/index.html')));
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text); pending.get(message.id)?.(message); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 20000); pending.set(key, (message) => { clearTimeout(timer); pending.delete(key); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }); socket.send(JSON.stringify({ id: key, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const state = async () => (await (await fetch(bridge + '/state')).json());
  const click = async (selector) => { await waitFor(`painted panel ${selector}`, async () => { const revision = (await state()).revision; return evaluate(`Number(document.querySelector('#revision').textContent.replace('rev ',''))===${revision}&&!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`); }); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const input = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const point = (trackId, time) => evaluate(`(()=>{const c=document.querySelector('#timeline'),r=c.getBoundingClientRect(),s=document.querySelector('#timeline-scroll'),rows=[...document.querySelectorAll('#track-headers .track-header')];return{x:r.left+${time}*Number(c.dataset.pps)-s.scrollLeft,y:r.top+Number(c.dataset.rulerHeight)+rows.findIndex(row=>row.dataset.trackId===${JSON.stringify(trackId)})*Number(c.dataset.trackHeight)+35-s.scrollTop}})()`);
  await waitFor('transition controls rendered', () => evaluate(`!!document.querySelector('#transition-add')&&document.querySelector('#transition-left').options.length===5`));
  await input('#transition-left', left.id); await input('#transition-right', right.id); await input('#transition-type', 'dissolve'); await input('#transition-frames', '12'); await input('#transition-alignment', 'center');
  await click('#transition-add');
  await waitFor('visible transition and timeline marker', async () => evaluate(`document.querySelectorAll('#transition-list [data-transition-id]').length===1&&document.querySelectorAll('#timeline-area .transition-marker').length===1`));
  const afterAdd = await state(), transition = afterAdd.project.timeline.transitions[0];
  assert.equal(transition.durationFrames, 12); assert.equal(transition.alignment, 'center');
  await input('#transition-left', audioLeft.id); await input('#transition-right', audioRight.id); await input('#transition-type', 'audio_crossfade'); await input('#transition-frames', '30');
  await click('#transition-add');
  await waitFor('visible audio crossfade', async () => (await state()).project.timeline.transitions?.length === 2);
  await waitFor('painted audio crossfade marker', () => evaluate(`document.querySelectorAll('#timeline-area .transition-marker').length===2`));
  assert.equal(await evaluate(`document.querySelectorAll('#timeline-area .transition-marker').length===2`), true);
  await input('#timecode-input', '00:00:01:00');
  await waitFor('decoded transition interval and equal audio gains', () => evaluate(`(()=>{const videos=[...document.querySelectorAll('#preview-stage video')],audios=[...document.querySelectorAll('#preview-stage audio')];return videos.length===2&&videos.every(el=>el.readyState>=2)&&audios.length===2&&audios.every(el=>el.readyState>=2&&Math.abs(Number(el.dataset.gain)-.5)<.02)})()`));
  const previewRevision = (await state()).revision;
  await waitFor('painted decoded transition frame', () => evaluate(`document.querySelector('#preview-stage').dataset.paintedRevision===${JSON.stringify(String(previewRevision))}`));
  const audioPoint = await point(audio.id, 1.8);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...audioPoint, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...audioPoint, button: 'left', clickCount: 1 });
  await waitFor('select audio crossfade endpoint', () => evaluate(`document.querySelector('#selection-info').textContent.includes('Audio transition right')`));
  await input('#timecode-input', '00:00:01:00');
  await waitFor('audio decoders settled at the crossfade midpoint', () => evaluate(`(()=>{const audios=[...document.querySelectorAll('#preview-stage audio')];return audios.length===2&&audios.every(el=>el.readyState>=2&&!el.seeking&&Math.abs(el.dataset.gain-.5)<.02)})()`));
  await click('#btn-play');
  await waitFor('audible decoded crossfade bus', () => evaluate(`(()=>{const label=document.querySelector('#audio-meter-label')?.textContent,db=Number(/RMS (-?[0-9.]+)/.exec(label??'')?.[1]),audios=[...document.querySelectorAll('#preview-stage audio')];return document.querySelector('#selection-info').textContent.includes('Audio transition right')&&Number.isFinite(db)&&db>-40&&audios.length===2&&audios.every(el=>!el.paused)})()`), 3000, 100).catch(async (error) => { console.error('AUDIO DEBUG', await evaluate(`(()=>({label:document.querySelector('#audio-meter-label')?.textContent,selected:document.querySelector('#selection-kind')?.textContent,selection:document.querySelector('#selection-info')?.textContent,head:document.querySelector('#timecode-input')?.value,audios:[...document.querySelectorAll('#preview-stage audio')].map(el=>({paused:el.paused,time:el.currentTime,gain:el.dataset.gain,ready:el.readyState,seeking:el.seeking})),painted:document.querySelector('#preview-stage').dataset.paintedRevision}))()`)); throw error; });
  await click('#btn-play');
  const previewPixel = async (time, timecode) => {
    await input('#timecode-input', timecode);
    await waitFor(`decoded program at ${time}s`, () => evaluate(`(()=>{const v=[...document.querySelectorAll('#preview-stage video')],times=v.map(el=>el.currentTime);return Math.abs(Number(document.querySelector('#program-canvas').dataset.paintedTime)-${time})<.002&&v.length===2&&v.every(el=>el.readyState>=2&&!el.seeking)&&times.some(t=>Math.abs(t-${time})<.03)&&times.some(t=>Math.abs(t-${1 + time})<.03)})()`)).catch(async (error) => { console.error('VIDEO DEBUG', await evaluate(`(()=>({paintedTime:document.querySelector('#program-canvas').dataset.paintedTime,head:document.querySelector('#timecode-input').value,videos:[...document.querySelectorAll('#preview-stage video')].map(el=>({time:el.currentTime,ready:el.readyState,seeking:el.seeking,clip:el.dataset.clipId})),preview:document.querySelector('#preview-note').textContent}))()`)); throw error; });
    return evaluate(`(()=>{const c=document.querySelector('#program-canvas'),p=c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data;return[p[0],p[1],p[2]]})()`);
  };
  const tailTime = 1 + 5 / 30;
  const leftPixel = await previewPixel(.8, '00:00:00:24'), middlePixel = await previewPixel(1, '00:00:01:00'), rightPixel = await previewPixel(tailTime, '00:00:01:05');
  assert.ok(leftPixel[0] > leftPixel[2] * 2, `left decoded endpoint should be red: ${leftPixel}`);
  assert.ok(middlePixel[0] > 70 && middlePixel[2] > 70 && Math.abs(middlePixel[0] - middlePixel[2]) < 50, `midpoint should contain both decoded endpoints: ${middlePixel}`);
  assert.ok(rightPixel[2] > rightPixel[0] * 2, `right decoded endpoint should be blue: ${rightPixel}`);
  const audioTransition = (await state()).project.timeline.transitions.find((item) => item.type === 'audio_crossfade');
  assert.ok(audioTransition);
  await evaluate(`document.querySelector('#transition-list [data-transition-id="${audioTransition.id}"] .transition-select').click()`);
  await input('#transition-frames', '18'); await input('#transition-alignment', 'start'); await click('#transition-update');
  await waitFor('transition timing update', async () => (await state()).project.timeline.transitions.find((item) => item.id === audioTransition.id)?.durationFrames === 18);
  assert.equal((await state()).project.timeline.tracks.find((track) => track.id === video.id).clips.find((clip) => clip.id === right.id).start, 1);
  await click('#btn-undo'); await waitFor('undo timing update', async () => (await state()).project.timeline.transitions.find((item) => item.id === audioTransition.id)?.durationFrames === 30);
  await click('#btn-redo'); await waitFor('redo timing update', async () => (await state()).project.timeline.transitions.find((item) => item.id === audioTransition.id)?.alignment === 'start');
  await click(`[data-track-lock="${audio.id}"]`);
  const lockedSnapshot = JSON.stringify((await state()).project.timeline);
  await click('#transition-remove');
  await waitFor('locked transition removal refusal', () => evaluate(`document.querySelector('#toast').classList.contains('error')`));
  assert.equal(JSON.stringify((await state()).project.timeline), lockedSnapshot);
  await click(`[data-track-lock="${audio.id}"]`);
  await click('#btn-save'); await waitFor('saved transitions', async () => (await fs.readFile(path.join(saved, 'project.json'), 'utf8')).includes(transition.id));
  const savedProject = JSON.parse(await fs.readFile(path.join(saved, 'project.json'), 'utf8'));
  for (const track of savedProject.timeline.tracks) track.clips.reverse();
  await fs.writeFile(path.join(saved, 'project.json'), JSON.stringify(savedProject, null, 2));
  await click('#transition-remove'); await waitFor('visible GUI removal', async () => (await state()).project.timeline.transitions?.length === 1 && await evaluate(`document.querySelectorAll('#timeline-area .transition-marker').length===1`));
  await click('#btn-undo'); await waitFor('undo visible GUI removal', async () => (await state()).project.timeline.transitions?.length === 2 && await evaluate(`document.querySelectorAll('#timeline-area .transition-marker').length===2`));
  await click('#transition-remove'); await waitFor('second visible GUI removal', async () => (await state()).project.timeline.transitions?.length === 1);
  await click('#btn-open'); await waitFor('reopened transitions', async () => (await state()).project.timeline.transitions?.length === 2);
  assert.equal((await state()).project.timeline.tracks.find((track) => track.id === video.id).clips[0].id, right.id, 'reopen must preserve deliberately reversed serialized clip order');
  const reopenedPixel = await previewPixel(1, '00:00:01:00');
  assert.ok(reopenedPixel[0] > 70 && reopenedPixel[2] > 70 && Math.abs(reopenedPixel[0] - reopenedPixel[2]) < 50, `reopened reversed clip order still paints one mixed transition layer: ${reopenedPixel}`);
  const reopenedProject = (await state()).project;
  await click('#btn-export'); await waitFor('real transition export', () => evaluate(`document.querySelector('#toast').textContent.startsWith('Exported')`), 120000);
  const decodeFrame = async (time) => {
    const { stdout } = await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
    const offset = ((90 * 320) + 160) * 3; return [stdout[offset], stdout[offset + 1], stdout[offset + 2]];
  };
  const exportLeft = await decodeFrame(.8), exportMiddle = await decodeFrame(1), exportRight = await decodeFrame(1.15);
  assert.ok(exportLeft[0] > exportLeft[2] * 2, `exported left endpoint should be red: ${exportLeft}`);
  assert.ok(exportMiddle[0] > 60 && exportMiddle[2] > 60 && Math.abs(exportMiddle[0] - exportMiddle[2]) < 60, `exported dissolve midpoint should mix both colors: ${exportMiddle}`);
  assert.ok(exportRight[2] > exportRight[0] * 2, `exported right endpoint should be blue: ${exportRight}`);
  const { stdout: pcm } = await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
  const tone = (time, frequency) => {
    const start = Math.round(time * 48000), count = 4800; let real = 0, imaginary = 0;
    for (let i = 0; i < count; i++) { const value = samples[start + i] ?? 0, phase = 2 * Math.PI * frequency * i / 48000; real += value * Math.cos(phase); imaginary += value * Math.sin(phase); }
    return 2 * Math.hypot(real, imaginary) / count;
  };
  const toneMatrix = Object.fromEntries([1.05, 1.3, 1.55].map((time) => [time, { 440: tone(time, 440), 880: tone(time, 880) }]));
  const transitionSummary = (project) => (project?.timeline?.transitions ?? []).map(transition => {
    const { startFrame, endFrame } = resolveTransition(project.timeline, project.media, transition);
    return { type: transition.type, durationFrames: transition.durationFrames, alignment: transition.alignment, startFrame, endFrame };
  });
  const audioDiagnostics = JSON.stringify({ toneMatrix, savedTransitions: transitionSummary(savedProject), reopenedTransitions: transitionSummary(reopenedProject), pcmDurationSeconds: samples.length / 48000 });
  assert.ok(toneMatrix[1.05][440] > toneMatrix[1.05][880] * 2, `crossfade export starts with left frequency; ${audioDiagnostics}`);
  assert.ok(toneMatrix[1.3][440] > .015 && toneMatrix[1.3][880] > .015, `crossfade export midpoint contains both frequencies; ${audioDiagnostics}`);
  assert.ok(toneMatrix[1.55][880] > toneMatrix[1.55][440] * 2, `crossfade export ends with right frequency; ${audioDiagnostics}`);
  assert.deepEqual(errors, [], `renderer exceptions: ${errors.join('\n')}\n${log}`);
  console.log('Transition Electron acceptance: visible CRUD/interval marker/undo-lock-save-reopen/decoded revision/export passed.');
} catch (error) { console.error(error); throw error; }
finally {
  socket?.close();
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); else child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(4000)]);
  }
  await client?.close();
  if (!path.resolve(workspace).startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Unsafe fixture cleanup');
  await fs.rm(workspace, { recursive: true, force: true });
}
