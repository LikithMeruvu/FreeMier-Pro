import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore, updateProjectSettings, addMediaAsset, addClip } from '@freemier/engine';
import { importMedia, configureFfmpeg, exportProject, hashMediaSource } from '@freemier/media';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { ProjectProtectionOwner, getProjectProtectionOwner } from '../../src/recovery/protection.js';
import { saveOwnedProject, loadOwnedProject } from '../../src/persistence/projects.js';
import { LiveBridge } from '../../src/connection/bridge.js';

let root: string; const active: ProjectProtectionOwner[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-protection-')); });
afterEach(async () => {
  vi.restoreAllMocks(); active.splice(0).forEach(owner => owner.dispose());
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(root, { recursive: true, force: true });
});
async function owned(store = EditorStore.create(), workspace = root) {
  const owner = new ProjectProtectionOwner(store, workspace); active.push(owner); await owner.ready; return { owner, store };
}
function context(store: EditorStore, owner: ProjectProtectionOwner) { return { store, workspace: root, projectProtection: owner, notify: vi.fn() }; }
async function copiedFixture(store: EditorStore) {
  const directory = path.join(root, 'media'); await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, 'fixture.wav'); await fs.writeFile(source, 'synthetic source bytes');
  const asset = { id: 'med_fixture', path: 'fixture.wav', copied: true, name: 'Fixture', kind: 'audio' as const,
    duration: 2, width: 0, height: 0, fps: 0, hasAudio: true, sampleRate: 48000, videoCodec: null, audioCodec: 'pcm_s16le', probedAt: 0,
    sourceIdentity: await hashMediaSource(source) };
  addMediaAsset(store, asset); return { asset, source };
}

describe('project protection service', () => {
  it('shares one owner per store, refuses another workspace and bootstraps without writes', async () => {
    const store = EditorStore.create(), absent = path.join(root, 'absent'), owner = getProjectProtectionOwner(store, absent); active.push(owner); await owner.ready;
    expect(getProjectProtectionOwner(store, path.join(absent, '..', 'absent'))).toBe(owner);
    if (process.platform === 'win32') expect(getProjectProtectionOwner(store, absent.toUpperCase())).toBe(owner);
    expect(() => getProjectProtectionOwner(store, root)).toThrowError(/different workspace/);
    expect(await owner.listRecovery()).toEqual([]); await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains immutable completed versions across restart and restores dirty without editing history for config', async () => {
    const { store, owner } = await owned(); const before = store.state;
    await owner.configure({ enabled: false, retention: 2, intervalSeconds: 10 }); expect(store.state).toBe(before); expect(store.canUndo).toBe(false);
    updateProjectSettings(store, { name: 'First' }); const first = await owner.checkpoint();
    updateProjectSettings(store, { name: 'Second' }); const second = await owner.checkpoint();
    const fresh = await owned(); expect(fresh.owner.snapshot()).toMatchObject({ enabled: false, retention: 2, intervalSeconds: 10 });
    expect((await fresh.owner.listRecovery()).map(item => item.id).sort()).toEqual([first.id, second.id].sort());
    await fresh.owner.restoreRecovery(first.id, fresh.owner.snapshot().token);
    expect(fresh.store.project.name).toBe('First'); expect(fresh.owner.snapshot().dirty).toBe(true); expect(fresh.store.canUndo).toBe(false);
    await expect(fresh.owner.restoreRecovery(second.id, fresh.owner.snapshot().token)).rejects.toMatchObject({ code: 'CONFLICT' });
    await fresh.owner.restoreRecovery(second.id, fresh.owner.snapshot().token, true); expect(fresh.store.project.name).toBe('Second');
    await saveOwnedProject({ path: path.join(root, 'saved') }, context(fresh.store, fresh.owner)); expect(fresh.owner.snapshot().dirty).toBe(false);
  });

  it('reports late save receipts while newer edits stay dirty and checks guarded loads after I/O', async () => {
    const { store, owner } = await owned(); updateProjectSettings(store, { name: 'Captured' });
    const original = fs.rename.bind(fs); let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => { entered(); await gate; return original(a, b); });
    const before = owner.snapshot().token, save = saveOwnedProject({ path: path.join(root, 'save') }, context(store, owner)); await wait;
    updateProjectSettings(store, { name: 'Newer' }); release();
    expect(await save).toMatchObject({ savedToken: before, projectProtection: { dirty: true } });
    expect(JSON.parse(await fs.readFile(path.join(root, 'save.freemier', 'project.json'), 'utf8')).name).toBe('Captured');
    vi.restoreAllMocks();
    const originalRead = fs.readFile.bind(fs), token = owner.snapshot().token;
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args: any[]) => {
      const bytes = await (originalRead as any)(...args); updateProjectSettings(store, { name: 'Changed during load' }); return bytes;
    });
    await expect(loadOwnedProject({ path: path.join(root, 'save'), expectedProtectionToken: token, discardUnsaved: true }, context(store, owner))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.project.name).toBe('Changed during load');
  });

  it('preserves corrupt configuration until an explicit backed-up defaults reset', async () => {
    const directory = path.join(root, 'settings'); await fs.mkdir(directory); const file = path.join(directory, 'project-protection.json'), bytes = '{broken'; await fs.writeFile(file, bytes);
    const { owner } = await owned(); expect(owner.snapshot().configurationReadOnly).toBe(true);
    await expect(owner.configure({ enabled: false })).rejects.toMatchObject({ code: 'CONFLICT' });
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(owner.configure({}, true)).rejects.toMatchObject({ code: 'IO_ERROR' }); expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    await owner.configure({}, true); expect(owner.snapshot()).toMatchObject({ enabled: true, intervalSeconds: 60, retention: 10 });
    const backup = (await fs.readdir(directory)).find(name => name.startsWith('project-protection-recovery-'))!;
    expect(await fs.readFile(path.join(directory, backup), 'utf8')).toBe(bytes);
  });

  it('keeps older versions after publication failure and excludes interrupted staging/corruption', async () => {
    const { store, owner } = await owned(); const first = await owner.checkpoint(); updateProjectSettings(store, { name: 'New' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('injected'), { code: 'EIO' }));
    await expect(owner.checkpoint()).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(owner.snapshot().lastRecovery?.id).toBe(first.id); expect((await owner.listRecovery()).map(item => item.id)).toEqual([first.id]);
    expect((await fs.readdir(path.join(root, 'recovery'))).some(name => name.startsWith('.pending-'))).toBe(true);
    await fs.writeFile(path.join(root, 'recovery', first.id, 'project.json'), '{}'); expect(await owner.listRecovery()).toEqual([]);
    await expect(owner.inspectRecovery(first.id)).rejects.toBeInstanceOf(Error);
  });

  it('keeps content-addressed normal-save media intact and resolves offline copied media against its package', async () => {
    const { store, owner } = await owned(), fixture = await copiedFixture(store), target = path.join(root, 'saved');
    await saveOwnedProject({ path: target }, context(store, owner));
    const first = JSON.parse(await fs.readFile(path.join(target + '.freemier', 'project.json'), 'utf8'));
    const firstFile = path.join(target + '.freemier', 'media', first.media[0].path), firstBytes = await fs.readFile(firstFile);
    await fs.writeFile(fixture.source, 'different verified source bytes');
    const changedIdentity = await hashMediaSource(fixture.source);
    store.mutate('media', [fixture.asset.id], project => ({ ...project, media: project.media.map(asset => ({ ...asset, sourceIdentity: changedIdentity })) }));
    await saveOwnedProject({ path: target }, context(store, owner));
    const second = JSON.parse(await fs.readFile(path.join(target + '.freemier', 'project.json'), 'utf8'));
    expect(second.media[0].path).not.toBe(first.media[0].path); expect(await fs.readFile(firstFile)).toEqual(firstBytes);
    const packaged = path.join(target + '.freemier', 'media', second.media[0].path); await fs.unlink(packaged);
    await loadOwnedProject({ path: target }, context(store, owner));
    expect(store.project.media[0].path).toBe(packaged); expect(owner.snapshot().dirty).toBe(false);
  });

  it('rejects changed copied sources and corrupted copies while inspecting external missing/changed sources', async () => {
    const { store, owner } = await owned(), fixture = await copiedFixture(store);
    const external = path.join(root, 'external.wav'); await fs.writeFile(external, 'external synthetic');
    addMediaAsset(store, { ...fixture.asset, id: 'med_external', copied: false, path: external, sourceIdentity: await hashMediaSource(external) });
    const saved = await owner.checkpoint();
    await fs.writeFile(fixture.source, 'changed');
    await expect(owner.checkpoint()).rejects.toMatchObject({ code: 'CONFLICT' });
    await fs.writeFile(external, 'changed external');
    expect((await owner.inspectRecovery(saved.id)).media.find(item => !item.copied)?.status).toBe('changed');
    await fs.unlink(external); expect((await owner.inspectRecovery(saved.id)).media.find(item => !item.copied)?.status).toBe('missing');
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'recovery', saved.id, 'manifest.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'recovery', saved.id, 'media', manifest.media.find((item: any) => item.copied).path), 'corrupt');
    await expect(owner.restoreRecovery(saved.id, owner.snapshot().token, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.project.media[0].path).toBe(fixture.asset.path);
  });

  it('treats manifest identity key order as irrelevant while refusing different identity values', async () => {
    const { store, owner } = await owned(), fixture = await copiedFixture(store), saved = await owner.checkpoint();
    const file = path.join(root, 'recovery', saved.id, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    const identity = manifest.media[0].identity;
    manifest.media[0].identity = { size: identity.size, sha256: identity.sha256 };
    await fs.writeFile(file, JSON.stringify(manifest));
    expect((await owner.inspectRecovery(saved.id)).valid).toBe(true);
    await owner.restoreRecovery(saved.id, owner.snapshot().token, true);
    expect(store.project.media[0].path).toBe(path.join(root, 'recovery', saved.id, 'media', manifest.media[0].path));
    expect(owner.snapshot().dirty).toBe(true);

    manifest.media[0].identity = { size: identity.size + 1, sha256: identity.sha256 };
    await fs.writeFile(file, JSON.stringify(manifest));
    await expect(owner.inspectRecovery(saved.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects source replacement during copy, metadata traversal, oversize bytes and a linked storage ancestor', async () => {
    const { store, owner } = await owned(), fixture = await copiedFixture(store);
    const original = fs.copyFile.bind(fs);
    vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (...args: Parameters<typeof fs.copyFile>) => { await original(...args); await fs.writeFile(fixture.source, 'replacement'); });
    await expect(owner.checkpoint()).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await owner.listRecovery()).toEqual([]);
    vi.restoreAllMocks();
    await fs.writeFile(fixture.source, 'synthetic source bytes'); const version = await owner.checkpoint();
    const file = path.join(root, 'recovery', version.id, 'manifest.json'), raw = await fs.readFile(file, 'utf8'), manifest = JSON.parse(raw);
    manifest.media[0].path = '../outside'; await fs.writeFile(file, JSON.stringify(manifest));
    await expect(owner.inspectRecovery(version.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await fs.writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1, 32)); await expect(owner.inspectRecovery(version.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await fs.writeFile(file, raw);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    const workspace = path.join(root, 'linked'); await fs.symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await owned(EditorStore.create(), workspace); await expect(linked.owner.checkpoint()).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(['open', 'write', 'sync', 'rename'] as const)('preserves configuration and cleans only its own temporary file after %s failure', async stage => {
    const { owner } = await owned(); await owner.configure({ enabled: false });
    const file = path.join(root, 'settings', 'project-protection.json'), bytes = await fs.readFile(file, 'utf8'), before = owner.snapshot(), listener = vi.fn(); owner.subscribe(listener);
    const fault = Object.assign(new Error('injected'), { code: 'EIO' });
    if (stage === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(fault);
    else {
      const original = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
        if (stage === 'open') throw fault;
        const handle = await original(...args); vi.spyOn(handle, stage === 'write' ? 'writeFile' : 'sync').mockRejectedValueOnce(fault); return handle;
      });
    }
    await expect(owner.configure({ retention: 3 })).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(owner.snapshot()).toEqual(before); expect(listener).not.toHaveBeenCalled(); expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(await fs.readdir(path.dirname(file))).toEqual(['project-protection.json']);
    vi.restoreAllMocks(); await owner.configure({ retention: 3 }); expect(owner.snapshot().retention).toBe(3);
  });

  it('retains only recognized generations and refuses unknown files and links during delete', async () => {
    const { owner } = await owned(); await owner.configure({ retention: 1, enabled: false });
    const first = await owner.checkpoint(); await fs.writeFile(path.join(root, 'recovery', first.id, 'unknown'), 'preserve');
    const second = await owner.checkpoint(); expect(owner.snapshot().lastRecovery?.id).toBe(second.id); expect(owner.snapshot().recoveryError).toContain('Unknown');
    await expect(owner.deleteRecovery(first.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(path.join(root, 'recovery', first.id, 'unknown'), 'utf8')).toBe('preserve');
    await owner.deleteRecovery(second.id);
    await expect(owner.inspectRecovery('../escape')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    const linked = '11111111-1111-4111-8111-111111111111';
    await fs.symlink(outside, path.join(root, 'recovery', linked), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(owner.deleteRecovery(linked)).rejects.toMatchObject({ code: 'IO_ERROR' }); expect(await fs.readdir(outside)).toEqual([]);
  });

  it('runs the configured timer, deduplicates unchanged content and stops it on dispose', async () => {
    const { store, owner } = await owned(); await owner.configure({ intervalSeconds: 10 });
    const checkpoint = vi.spyOn(owner, 'checkpoint'); vi.useFakeTimers();
    try {
      await owner.configure({ intervalSeconds: 11 }); updateProjectSettings(store, { name: 'Timer' });
      await vi.advanceTimersByTimeAsync(11000);
      await owner.runOperation(async () => {});
      expect(checkpoint).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(22000); expect(checkpoint).toHaveBeenCalledTimes(1);
      owner.dispose(); await vi.advanceTimersByTimeAsync(22000); expect(checkpoint).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('separates a command selector from an action argument while retaining flat requests', async () => {
    const { store, owner } = await owned(), bridge = new LiveBridge({ store, workspace: root, projectProtection: owner, port: 0 });
    const base = `http://127.0.0.1:${await bridge.start()}`;
    const request = async (body: unknown) => (await fetch(`${base}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    try {
      const token = owner.snapshot().token;
      const replaced = await request({ action: 'project_replace', arguments: { action: 'create', name: 'Nested command', expectedProtectionToken: token } });
      expect(replaced).toMatchObject({ ok: true, name: 'Nested command', _bridge: { project: { name: 'Nested command' } } });
      expect(store.project.name).toBe('Nested command');
      const before = store.state;
      expect(await request({ action: 'project_replace', arguments: { action: 'create', expectedProtectionToken: token } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(await request({ action: 'project_info', arguments: [], surprise: true })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      expect(store.state).toBe(before);
      expect(await request({ action: 'project_info' })).toMatchObject({ ok: true, name: 'Nested command' });
      expect(await request({ action: 'project_info', arguments: {} })).toMatchObject({ ok: true, name: 'Nested command' });
    } finally { await bridge.stop(); }
  });

  it('broadcasts protection-only changes with a stable Bridge epoch without project sequence changes', async () => {
    const { store, owner } = await owned(), bridge = new LiveBridge({ store, workspace: root, projectProtection: owner, port: 0 });
    const base = `http://127.0.0.1:${await bridge.start()}`, abort = new AbortController();
    try {
      const before = await (await fetch(`${base}/state`)).json();
      const stream = await fetch(`${base}/events`, { signal: abort.signal }), reader = stream.body!.getReader(); let buffer = '';
      const event = async (): Promise<any> => {
        while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('ended'); buffer += new TextDecoder().decode(chunk.value); }
        const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: ')); return data ? JSON.parse(data.slice(6)) : event();
      };
      await event(); await owner.configure({ enabled: false });
      expect(await event()).toMatchObject({ type: 'project-protection', eventEpoch: before.eventEpoch, projectProtection: { enabled: false } });
      const after = await (await fetch(`${base}/state`)).json(); expect(after.eventSequence).toBe(before.eventSequence); expect(after.project).toEqual(before.project); expect(store.canUndo).toBe(false);
    } finally { abort.abort(); await bridge.stop(); }
  });
});

function message(child: ChildProcess, kind: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${kind}`)); }, 30000);
    const onMessage = (value: any) => { if (value.kind === kind) { cleanup(); resolve(value); } };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Owner exited ${code} before ${kind}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); };
    child.on('message', onMessage); child.on('exit', onExit);
  });
}

describe('native recovery after an actual owner crash', () => {
  it('recovers two complete packaged versions after kill, ignores interrupted publication and decodes without original copied media', async () => {
    const source = path.join(root, 'source.mp4');
    const binaries = { ffmpeg: process.env.FREEMIER_TEST_FFMPEG ?? 'ffmpeg', ffprobe: process.env.FREEMIER_TEST_FFPROBE ?? 'ffprobe' }; configureFfmpeg({ ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe });
    const generated = spawnSync(binaries.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { windowsHide: true });
    expect(generated.status, generated.stderr?.toString()).toBe(0);
    const workspace = path.join(root, 'owner'), mediaDir = path.join(workspace, 'media'); await fs.mkdir(mediaDir, { recursive: true }); await fs.copyFile(source, path.join(mediaDir, 'copied.mp4'));
    const asset = await importMedia(source), store = EditorStore.create({ width: 96, height: 64, fps: 10 });
    addMediaAsset(store, { ...asset, copied: true, path: 'copied.mp4' });
    addClip(store, { assetId: asset.id, trackId: 'trk_video_1', start: 0, sourceIn: 0, sourceOut: 2 });
    addClip(store, { assetId: asset.id, trackId: 'trk_audio_1', start: 0, sourceIn: 0, sourceOut: 2 });
    const initial = path.join(root, 'initial.json'); await fs.writeFile(initial, JSON.stringify(store.project));
    const script = path.join(root, 'crash-owner.mjs');
    const ownerSource = path.resolve('packages/service/src/recovery/protection.ts');
    await build({ stdin: { contents: `import {EditorStore,updateProjectSettings} from '@freemier/engine'; import {ProjectProtectionOwner} from ${JSON.stringify(ownerSource)}; import {promises as fs} from 'node:fs';
const store=new EditorStore(JSON.parse(await fs.readFile(process.argv[3],'utf8'))); const owner=new ProjectProtectionOwner(store,process.argv[2]); await owner.ready; await owner.configure({enabled:false});
updateProjectSettings(store,{name:'Crash first'}); const first=await owner.checkpoint(); updateProjectSettings(store,{name:'Crash second'}); const second=await owner.checkpoint(); process.send({kind:'complete',first,second});
process.on('message',async m=>{if(m==='stage'){const rename=fs.rename.bind(fs);fs.rename=async(a,b)=>{if(String(a).includes('.pending-')){process.send({kind:'staging'});await new Promise(()=>{});}return rename(a,b);};updateProjectSettings(store,{name:'Incomplete'});await owner.checkpoint();}}); setInterval(()=>{},1000);`, resolveDir: process.cwd(), sourcefile: 'crash-owner.ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: script, logLevel: 'silent' });
    const child = spawn(process.execPath, [script, workspace, initial], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
    let complete: any;
    try {
      complete = await message(child, 'complete'); const staging = message(child, 'staging'); child.send('stage'); await staging;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
    } catch (error) { child.kill('SIGKILL'); throw new Error(`${String(error)}\n${stderr}`); }
    const fresh = await owned(EditorStore.create({ width: 96, height: 64, fps: 10 }), workspace);
    expect((await fresh.owner.listRecovery()).map(item => item.id).sort()).toEqual([complete.first.id, complete.second.id].sort());
    await fs.rm(mediaDir, { recursive: true }); await fs.unlink(source);
    await fresh.owner.restoreRecovery(complete.first.id, fresh.owner.snapshot().token); expect(fresh.store.project.name).toBe('Crash first');
    await fresh.owner.restoreRecovery(complete.second.id, fresh.owner.snapshot().token, true); expect(fresh.store.project.name).toBe('Crash second');
    const output = path.join(root, 'recovered.mp4'); await exportProject(fresh.store.project, { outputPath: output });
    const decoded = spawnSync(binaries.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true });
    expect(decoded.status, decoded.stderr?.toString()).toBe(0);
    const pixel = spawnSync(binaries.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', output, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    expect(pixel.stdout[0]).toBeGreaterThan(230); expect(pixel.stdout[1]).toBeLessThan(15); expect(pixel.stdout[2]).toBeLessThan(15);
    const audio = spawnSync(binaries.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { windowsHide: true });
    let energy = 0; for (let offset = 0; offset + 4 <= audio.stdout.length; offset += 4) energy += audio.stdout.readFloatLE(offset) ** 2;
    expect(Math.sqrt(energy / (audio.stdout.length / 4))).toBeGreaterThan(.05);
  }, 60000);
});
