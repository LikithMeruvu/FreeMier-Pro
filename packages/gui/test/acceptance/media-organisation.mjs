/** Visible media organisation controls backed by the standard MCP service. */
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
async function waitFor(label, fn, timeout = 25000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
const workspace = await fs.mkdtemp(path.join(root, '.tmp', 'media-organisation-'));
const port = await freePort(), debugPort = await freePort(), bridge = `http://127.0.0.1:${port}`;
const projectPath = path.join(workspace, 'Media organisation.freemier');
const outputPath = path.join(workspace, 'media-organisation.mp4');
const sourceDir = path.join(workspace, 'source'), searchRoot = path.join(workspace, 'candidates');
await fs.mkdir(sourceDir); await fs.mkdir(searchRoot);
const missingPath = path.join(sourceDir, 'Offline source.mp4');
await fs.copyFile(path.join(root, 'fixtures/media/clipA.mp4'), missingPath);
const secondImagePath = path.join(sourceDir, 'Second source.png');
await fs.copyFile(path.join(root, 'fixtures/media/still.png'), secondImagePath);
const candidatePath = path.join(searchRoot, 'Recovered source.mp4');
const env = { ...process.env, FREEMIER_WORKSPACE: workspace, FREEMIER_BRIDGE_PORT: String(port), FREEMIER_TEST_MODE: '1', FREEMIER_TEST_DIALOGS: JSON.stringify({ media: [secondImagePath], project: projectPath, output: outputPath }) };
delete env.ELECTRON_RUN_AS_NODE;
let client, child, socket, log = '';
const errors = [];
try {
  client = new Client({ name: 'media-organisation-electron-acceptance', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/mcp/dist/cli.js')], env }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const value = JSON.parse(response.content[0].text);
    if (response.isError) throw new Error(value.error?.message ?? `${name} failed`);
    return value;
  };
  await waitFor('bridge', async () => (await fetch(`${bridge}/health`)).ok);
  await call('project_create', { name: 'Media organisation acceptance', width: 320, height: 180, fps: 30 });
  const asset = (await call('media_import', { path: missingPath, copyIntoProject: false })).asset;
  const rootBin = (await call('media_bin_create', { name: 'Footage' })).bin;
  const childBin = (await call('media_bin_create', { name: 'Recovered', parentId: rootBin.id })).bin;
  await call('media_assign_bin', { assetIds: [asset.id], binId: childBin.id });
  await call('media_metadata_update', { assetId: asset.id, description: 'Acceptance source', tags: ['interview', 'recovered'], rating: 4 });
  const tracks = (await call('timeline_inspect')).tracks;
  const videoTrack = tracks.find((track) => track.kind === 'video');
  assert.ok(videoTrack, 'default video track exists');

  child = spawn(electron, [path.join(root, 'packages/gui'), '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => log += data); child.stderr.on('data', (data) => log += data);
  const target = await waitFor('Electron page', async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((entry) => entry.type === 'page' && entry.url.includes('renderer/index.html')));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const input = (selector, value, eventName = 'change') => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event(${JSON.stringify(eventName)},{bubbles:true}));})()`);
  const click = async (selector) => {
    await waitFor(`painted enabled control ${selector}`, async () => {
      const revision = (await (await fetch(`${bridge}/state`)).json()).revision;
      return evaluate(`Number(document.querySelector('#revision').textContent.replace('rev ',''))===${revision}&&!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);
    });
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const waitCard = () => waitFor('painted media tile', () => evaluate(`!!document.querySelector('.media-item[data-asset-id="${asset.id}"]')`));
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeFetch = window.fetch.bind(window);
    let thumbnailGateEnabled = true;
    window.__mediaThumbnailReleases = [];
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (!thumbnailGateEnabled || !url?.includes('/thumbnail')) return nativeFetch(input, init);
      return new Promise((resolve, reject) => {
        window.__mediaThumbnailReleases.push(() => nativeFetch(input, init).then(resolve, reject));
      });
    };
    window.__releaseMediaThumbnails = () => {
      thumbnailGateEnabled = false;
      const releases = window.__mediaThumbnailReleases.splice(0);
      for (const release of releases) release();
      return releases.length;
    };
  })();` });
  await send('Page.reload', { ignoreCache: true });
  await waitCard();
  await waitFor('held thumbnail request', () => evaluate(`window.__mediaThumbnailReleases?.length===1`));
  const thumbnailPaintGeneration = await evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)`);
  await call('media_metadata_update', { assetId: asset.id, description: 'Thumbnail waiter check' });
  await waitFor('second paint while thumbnail request is held', async () => {
    const state = await (await fetch(`${bridge}/state`)).json();
    return evaluate(`Number(document.querySelector('#revision').textContent.replace('rev ',''))===${state.revision}&&Number(document.querySelector('#media-bin').dataset.queryGeneration)>${thumbnailPaintGeneration}&&Number(document.querySelector('#media-bin').dataset.queryRevision)===${state.revision}`);
  });
  assert.equal(await evaluate(`window.__mediaThumbnailReleases.length`), 1, 'the repaint shares the original pending thumbnail request');
  await evaluate(`(()=>{window.__mediaBinChildChanges=0;new MutationObserver((records)=>{if(records.some((record)=>record.type==='childList'))window.__mediaBinChildChanges++}).observe(document.querySelector('#media-bin'),{childList:true,subtree:true})})()`);
  assert.equal(await evaluate(`window.__releaseMediaThumbnails()`), 1);
  await waitFor('current tile thumbnail decodes after shared request', () => evaluate(`(()=>{const image=document.querySelector('.media-item[data-asset-id="${asset.id}"] .media-thumb');return image?.complete&&image.naturalWidth>0&&image.src.startsWith('data:image/')})()`), 60000);
  await sleep(150);
  assert.equal(await evaluate(`window.__mediaBinChildChanges`), 0, 'thumbnail completion paints the current tile without another library render');
  const resetDescriptionRevision = (await (await fetch(`${bridge}/state`)).json()).revision;
  await call('media_metadata_update', { assetId: asset.id, description: 'Acceptance source' });
  await waitFor('thumbnail test restores source metadata', async () => {
    const state = await (await fetch(`${bridge}/state`)).json();
    return state.revision > resetDescriptionRevision && await evaluate(`Number(document.querySelector('#revision').textContent.replace('rev ',''))===${state.revision}&&Number(document.querySelector('#media-bin').dataset.queryRevision)===${state.revision}`);
  });
  assert.equal(await evaluate(`!!document.querySelector('#media-bin-filter option[value="${childBin.id}"]')`), true);
  assert.equal(await evaluate(`!!document.querySelector('#media-selection-controls[hidden]')`), true);
  await evaluate(`document.querySelector('.media-library-details').open=true`);
  await input('#media-bin-parent', rootBin.id);
  await input('#media-bin-create-name', 'Temporary bin', 'input');
  await click('#media-bin-create');
  const temporaryBin = await waitFor('created bin from visible controls', async () => (await call('media_bins')).bins.find((bin) => bin.name === 'Temporary bin'));
  await input('#media-bin-filter', temporaryBin.id);
  await input('#media-bin-parent', childBin.id);
  await click('#media-bin-move');
  await waitFor('moved bin parent', async () => (await call('media_bins')).bins.find((bin) => bin.id === temporaryBin.id)?.parentId === childBin.id);
  await evaluate(`window.prompt=()=> 'Renamed bin'`);
  await click('#media-bin-rename');
  await waitFor('renamed visible bin', async () => (await call('media_bins')).bins.find((bin) => bin.id === temporaryBin.id)?.name === 'Renamed bin');
  await evaluate(`window.confirm=()=>true`);
  const removeGeneration = await evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)`);
  await click('#media-bin-remove');
  await waitFor('removed empty visible bin', async () => !(await call('media_bins')).bins.some((bin) => bin.id === temporaryBin.id));
  await waitFor('visible bin removal repaint settled', () => evaluate(`document.querySelector('#media-bin-filter').value===''&&![...document.querySelectorAll('#media-bin-tree button')].some((button)=>button.textContent==='Renamed bin')&&Number(document.querySelector('#media-bin').dataset.queryGeneration)>${removeGeneration}`));
  await input('#media-bin-filter', childBin.id);
  const binFilterGeneration = await evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)`);
  await waitFor('bin-filtered card', () => evaluate(`document.querySelector('#media-bin-filter').value==='${childBin.id}'&&Number(document.querySelector('#media-bin').dataset.queryGeneration)>${binFilterGeneration}&&document.querySelectorAll('.media-item').length===1`));
  await click('#btn-import');
  await waitFor('visible import reaches the owning project', async () => (await call('media_list')).media.length === 2);
  const importedAssets = (await call('media_list')).media;
  const secondAsset = importedAssets.find((item) => item.path === secondImagePath);
  assert.ok(secondAsset, 'GUI import added the second source');
  const selectedBinResults = await call('media_query', { binId: childBin.id });
  assert.equal(selectedBinResults.total, 2, `GUI import should target ${childBin.id}; actual memberships: ${JSON.stringify(selectedBinResults.assets.map(({ asset, binId }) => ({ id: asset.id, path: asset.path, binId })))}`);
  assert.equal(secondAsset.kind, 'image');
  await waitFor('second imported tile painted', () => evaluate(`!!document.querySelector('.media-item[data-asset-id="${secondAsset.id}"]')`));
  await click(`.media-item[data-asset-id="${secondAsset.id}"]`);
  await input('#media-asset-name', 'B-roll', 'change');
  await waitFor('second asset name saved', async () => (await call('media_query', { text: 'B-roll' })).total === 1);
  await input('#media-asset-rating', '1');
  await waitFor('second asset rating saved', async () => (await call('media_query', { text: 'B-roll' })).assets[0]?.rating === 1);
  await input('#media-kind-filter', 'image');
  await waitFor('visible image kind filter', () => evaluate(`document.querySelectorAll('.media-item').length===1&&document.querySelector('.media-item').dataset.assetId==='${secondAsset.id}'`));
  await input('#media-kind-filter', 'video');
  await waitFor('visible video kind filter', () => evaluate(`document.querySelectorAll('.media-item').length===1&&document.querySelector('.media-item').dataset.assetId==='${asset.id}'`));
  await input('#media-kind-filter', '');
  const sortGenerationBefore = await evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)`);
  await input('#media-sort', 'rating:desc');
  await waitFor('visible rating sort order', () => evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)>${sortGenerationBefore}&&document.querySelector('#media-bin').dataset.querySort==='rating:desc'&&document.querySelectorAll('.media-item').length===2`));
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.media-item')).map((item)=>item.dataset.assetId)`), [asset.id, secondAsset.id]);
  await input('#bin-search', 'does-not-match', 'input');
  await waitFor('painted text search result', () => evaluate(`document.querySelectorAll('.media-item').length===0`));
  await input('#bin-search', 'Offline source', 'input');
  await waitCard();
  await input('#media-kind-filter', 'video');
  await waitFor('painted kind filter', () => evaluate(`document.querySelectorAll('.media-item').length===1`));
  await click(`.media-item[data-asset-id="${asset.id}"]`);
  await waitFor('visible selected metadata fields', () => evaluate(`!document.querySelector('#media-selection-controls').hidden&&document.querySelector('#media-asset-description').value==='Acceptance source'`));
  await input('#media-selected-bin', rootBin.id);
  await waitFor('visible asset assignment reaches the service', async () => (await call('media_query', { binId: rootBin.id })).total === 1);
  await input('#media-selected-bin', childBin.id);
  await waitFor('visible asset returns to nested bin', async () => (await call('media_query', { binId: childBin.id })).total === 2);
  await input('#media-asset-description', 'Visible edit saved', 'change');
  await waitFor('metadata change reaches the service', async () => (await call('media_query', { text: 'Visible edit saved' })).total === 1);
  await click('#btn-save');
  await waitFor('saved library metadata', async () => {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8'));
      return saved.mediaLibrary?.entries?.some((entry) => entry.assetId === asset.id && entry.description === 'Visible edit saved' && entry.rating === 4 && entry.tags.includes('interview'));
    } catch { return false; }
  });
  const openGeneration = await evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)`);
  await click('#btn-open');
  await waitFor('GUI open command completed', () => evaluate(`document.querySelector('#toast').textContent.includes('Project opened')`));
  await waitFor('opened library repainted', () => evaluate(`Number(document.querySelector('#media-bin').dataset.queryGeneration)>${openGeneration}`));
  await waitCard();
  await click(`.media-item[data-asset-id="${asset.id}"]`);
  await waitFor('reopened metadata painted in GUI', () => evaluate(`document.querySelector('#media-asset-description').value==='Visible edit saved'&&document.querySelector('#media-asset-rating').value==='4'&&document.querySelector('#media-asset-tags').value.includes('interview')`));
  await click('#media-availability-refresh');
  await fs.rename(missingPath, path.join(sourceDir, 'temporarily-moved.mp4'));
  await click('#media-availability-refresh');
  await waitFor('offline status badge', () => evaluate(`document.querySelector('#media-availability-status').textContent.includes('missing')`));
  await fs.copyFile(path.join(sourceDir, 'temporarily-moved.mp4'), candidatePath);
  await input('#media-relink-root', searchRoot, 'input');
  await click('#media-relink-candidates');
  await waitFor('exact hash candidate displayed', () => evaluate(`document.querySelector('#media-relink-candidate-list').textContent.includes('Exact hash')`));
  await click('#media-relink-candidate-list button');
  await click('#media-relink-apply');
  await waitFor('visible asset is online again', () => evaluate(`document.querySelector('#media-availability-status').textContent.includes('available')`));

  const query = await call('media_query', { text: 'Visible edit saved', binId: childBin.id, includeChildren: true, sortBy: 'rating', sortDirection: 'desc' });
  assert.equal(query.total, 1); assert.equal(query.assets[0].asset.id, asset.id); assert.equal(query.assets[0].rating, 4);
  await call('clip_add', { assetId: asset.id, trackId: videoTrack.id, start: 0, sourceIn: 0, duration: Math.min(2, asset.duration), strict: true });
  await evaluate(`document.querySelector('.media-item[data-asset-id="${asset.id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await waitFor('decoded source preview after relink', () => evaluate(`(()=>{const v=document.querySelector('#source-stage video');return v&&v.readyState>=2&&v.videoWidth>0})()`), 60000);
  const screenshotPath = path.join(root, '.tmp', `media-organisation-visible-${process.pid}.png`);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log(`Visible media organisation screenshot: ${screenshotPath}`);
  await click('#btn-export');
  await waitFor('decoded export after relink', () => evaluate(`!document.querySelector('#btn-export').disabled&&document.querySelector('#toast').textContent.startsWith('Exported')`), 120000);
  await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-i', outputPath, '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true });
  assert.deepEqual(errors, [], `renderer exceptions: ${errors.join('\n')}`);
  console.log('Media organisation Electron acceptance: bins, search/filter/sort, metadata, offline badge, exact candidate relink, decoded source and export passed.');
} catch (error) {
  console.error(log);
  throw error;
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(4000)]);
  }
  await client?.close();
  if (!path.resolve(workspace).startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Unsafe acceptance fixture cleanup');
  await fs.rm(workspace, { recursive: true, force: true });
}
