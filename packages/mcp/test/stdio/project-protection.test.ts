import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let temporary: string, workspace: string, client: Client, transport: StdioClientTransport;
async function connect() {
  client = new Client({ name: 'project-protection-acceptance', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/mcp/dist/cli.js')], env: { ...env, FREEMIER_WORKSPACE: workspace, FREEMIER_NO_BRIDGE: '1' } });
  await client.connect(transport);
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  if (result.isError) throw Object.assign(new Error(value.error.message), value.error);
  return value;
}
const protection = async () => (await call('project_protection_get')).projectProtection;
async function native(args: string[]) {
  return (await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout;
}
function confined(file: string) {
  expect(path.resolve(file).startsWith(path.resolve(temporary) + path.sep)).toBe(true);
}
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-protection-mcp-'));
  workspace = path.join(temporary, 'workspace'); await fs.mkdir(workspace); await connect();
});
afterEach(async () => {
  await client?.close();
  expect(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('project protection through a standard MCP client', () => {
  it('discovers described controls and persists validated preferences without changing project history', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(102);
    const capabilities = (await call('editor_capabilities')).projectProtection;
    expect(capabilities.commands).toHaveLength(8);
    for (const name of capabilities.commands) {
      expect(tools.find(tool => tool.name === name)!.description!.length).toBeGreaterThan(80);
    }
    const initial = await protection(), info = await call('project_info');
    expect(initial).toMatchObject({ dirty: false, enabled: true, intervalSeconds: 60, retention: 10 });
    expect(await fs.readdir(workspace)).toEqual([]);
    for (const patch of [{ enabled: 'yes' }, { intervalSeconds: 9 }, { retention: 51 }, { arbitraryPath: '/unused' }])
      await expect(call('project_protection_configure', { patch })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await protection()).toEqual(initial);
    const configured = (await call('project_protection_configure', { patch: { enabled: false, intervalSeconds: 10, retention: 2 } })).projectProtection;
    expect(configured).toMatchObject({ token: initial.token, dirty: false, enabled: false, intervalSeconds: 10, retention: 2 });
    expect(await call('project_info')).toEqual(info);
    const bytes = await fs.readFile(path.join(workspace, 'settings', 'project-protection.json'));
    await client.close(); await connect();
    expect(await protection()).toMatchObject({ dirty: false, enabled: false, intervalSeconds: 10, retention: 2 });
    expect((await protection()).epoch).not.toBe(initial.epoch);
    expect(await fs.readFile(path.join(workspace, 'settings', 'project-protection.json'))).toEqual(bytes);
  });

  it('uses saved-content equality and guards replacement against unsaved work and stale tokens', async () => {
    const initial = await protection();
    const marker = (await call('marker_add', { time: 1, label: 'Keep this edit' })).marker;
    const dirty = await protection(), info = await call('project_info');
    expect(dirty.dirty).toBe(true);
    await expect(call('project_replace', { action: 'create', expectedProtectionToken: dirty.token })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call('project_replace', { action: 'create', expectedProtectionToken: initial.token, discardUnsaved: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await call('project_info')).toEqual(info);
    const target = path.join(temporary, 'Saved.freemier');
    const saved = await call('project_save', { path: target });
    expect(saved).toMatchObject({ savedToken: dirty.token, projectProtection: { dirty: false, savedTo: path.join(target, 'project.json') } });
    expect(await call('project_info')).toEqual(info);
    await call('marker_update', { markerId: marker.id, label: 'Later edit' });
    const newer = await protection(); expect(newer.dirty).toBe(true);
    await call('undo'); const undone = await protection();
    expect(undone.dirty).toBe(false); expect(undone.generation).toBeGreaterThan(newer.generation);
    await call('redo'); expect((await protection()).dirty).toBe(true);
    await expect(call('project_replace', { action: 'load', path: target, expectedProtectionToken: undone.token, discardUnsaved: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    const latest = await protection();
    const loaded = await call('project_replace', { action: 'load', path: target, expectedProtectionToken: latest.token, discardUnsaved: true });
    expect(loaded.projectProtection.dirty).toBe(false);
    expect((await call('marker_list')).markers[0].label).toBe('Keep this edit');
    await expect(call('project_replace', { action: 'load', name: 'Wrong fields', path: target, expectedProtectionToken: loaded.projectProtection.token })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const created = await call('project_replace', { action: 'create', name: 'Fresh', expectedProtectionToken: loaded.projectProtection.token });
    expect(created).toMatchObject({ name: 'Fresh', projectProtection: { dirty: false } });
    expect((await call('marker_list')).markers).toEqual([]);
  });

  it('preserves malformed and future configuration until explicit backed-up reset applies the requested patch', async () => {
    await client.close();
    const directory = path.join(workspace, 'settings'), file = path.join(directory, 'project-protection.json');
    await fs.mkdir(directory);
    const invalid = '{ invalid protection settings\n'; await fs.writeFile(file, invalid);
    await connect();
    expect(await protection()).toMatchObject({ configurationReadOnly: true });
    await expect(call('project_protection_configure', { patch: { enabled: false } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(file, 'utf8')).toBe(invalid);
    const reset = (await call('project_protection_configure', { patch: { enabled: false, intervalSeconds: 15, retention: 3 }, resetInvalid: true })).projectProtection;
    expect(reset).toMatchObject({ enabled: false, intervalSeconds: 15, retention: 3 });
    expect(reset.configurationReadOnly).toBeUndefined();
    const backups = (await fs.readdir(directory)).filter(name => name.startsWith('project-protection-recovery-'));
    expect(backups).toHaveLength(1); expect(await fs.readFile(path.join(directory, backups[0]!), 'utf8')).toBe(invalid);
    await client.close();
    const future = JSON.stringify({ version: 9, enabled: false, intervalSeconds: 15, retention: 3 }); await fs.writeFile(file, future);
    await connect();
    expect((await protection()).configurationReadOnly).toBe(true);
    await expect(call('project_protection_configure', { patch: {} })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(file, 'utf8')).toBe(future);
  });

  it('retains completed versions, refuses corrupt packages and keeps recovery controls separate from editing history', async () => {
    await call('project_protection_configure', { patch: { enabled: false, retention: 2 } });
    await call('marker_add', { time: 1, label: 'One' });
    const before = await call('project_info');
    const one = (await call('project_recovery_create')).recovery;
    expect(await call('project_info')).toEqual(before);
    expect((await protection()).dirty).toBe(true);
    const inspection = await call('project_recovery_inspect', { recoveryId: one.id });
    expect(inspection).toMatchObject({ valid: true, recovery: one, media: [] });
    await call('project_update', { name: 'Second version' });
    const two = (await call('project_recovery_create')).recovery;
    await call('project_update', { name: 'Third version' });
    const three = (await call('project_recovery_create')).recovery;
    expect((await call('project_recovery_list')).recoveries.map((item: { id: string }) => item.id).sort()).toEqual([two.id, three.id].sort());
    await expect(call('project_recovery_inspect', { recoveryId: one.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call('project_recovery_inspect', { recoveryId: '../outside' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const thirdFile = path.join(workspace, 'recovery', three.id, 'project.json'); confined(thirdFile);
    await fs.writeFile(thirdFile, '{ damaged generation\n');
    expect((await call('project_recovery_list')).recoveries.map((item: { id: string }) => item.id)).toEqual([two.id]);
    const dirty = await protection(), current = await call('project_info');
    await expect(call('project_recovery_restore', { recoveryId: two.id, expectedProtectionToken: dirty.token })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await call('project_info')).toEqual(current);
    const restored = await call('project_recovery_restore', { recoveryId: two.id, expectedProtectionToken: dirty.token, discardUnsaved: true });
    expect(restored.projectProtection.dirty).toBe(true); expect((await call('project_info')).name).toBe('Second version');
    const recoveredInfo = await call('project_info');
    await call('project_recovery_delete', { recoveryId: two.id });
    expect(await call('project_info')).toEqual(recoveredInfo);
    expect((await call('project_recovery_list')).recoveries).toEqual([]);
  });

  it('keeps dirty work and its saved baseline when a real filesystem save fails', async () => {
    await call('marker_add', { time: 1, label: 'Original saved edit' });
    const target = path.join(temporary, 'Normal.freemier'); await call('project_save', { path: target });
    await call('project_update', { name: 'Unsaved change' });
    const before = await protection(), info = await call('project_info');
    const blocked = path.join(temporary, 'Blocked.freemier'); await fs.writeFile(blocked, 'keep user bytes');
    await expect(call('project_save', { path: blocked })).rejects.toThrow();
    expect(await fs.readFile(blocked, 'utf8')).toBe('keep user bytes');
    expect(await protection()).toEqual(before); expect(await call('project_info')).toEqual(info);
    expect(JSON.parse(await fs.readFile(path.join(target, 'project.json'), 'utf8')).name).not.toBe('Unsaved change');
  });

  it('survives an actual MCP owner kill and decodes both recovery edits after original copied media is removed', async () => {
    await call('project_protection_configure', { patch: { enabled: false, retention: 2 } });
    const source = path.join(temporary, 'red-picture-and-tone.mp4');
    await native(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=10:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    await call('project_create', { name: 'First recovered edit', width: 96, height: 64, fps: 10 });
    const asset = (await call('media_import', { path: source, copyIntoProject: true })).asset;
    const tracks = (await call('timeline_inspect')).tracks;
    const pair = await call('clip_add_linked', { assetId: asset.id, videoTrackId: tracks.find((item: { kind: string }) => item.kind === 'video').id, audioTrackId: tracks.find((item: { kind: string }) => item.kind === 'audio').id, sourceIn: 1, duration: 2 });
    const first = (await call('project_recovery_create')).recovery;
    await call('clip_move', { clipId: pair.videoClip.id, start: 1 }); await call('project_update', { name: 'Second recovered edit' });
    const second = (await call('project_recovery_create')).recovery;
    const oldEpoch = (await protection()).epoch;
    // This PID belongs to the live child just spawned by this SDK transport, never disk metadata.
    const ownedPid = transport.pid; expect(ownedPid).toBeTruthy();
    const closed = new Promise<void>(resolve => { client.onclose = resolve; });
    process.kill(ownedPid!, 'SIGKILL'); await closed;
    const originalCopies = path.join(workspace, 'media'); confined(originalCopies); confined(source);
    await fs.rm(originalCopies, { recursive: true, force: true }); await fs.unlink(source);
    await connect();
    expect((await protection()).epoch).not.toBe(oldEpoch);
    expect((await call('project_recovery_list')).recoveries.map((item: { id: string }) => item.id).sort()).toEqual([first.id, second.id].sort());
    for (const [index, version] of [first, second].entries()) {
      const current = await protection();
      const restored = await call('project_recovery_restore', { recoveryId: version.id, expectedProtectionToken: current.token, discardUnsaved: current.dirty });
      expect(restored.projectProtection.dirty).toBe(true);
      expect((await call('project_info')).name).toBe(version.projectName);
      const inspected = await call('project_recovery_inspect', { recoveryId: version.id });
      expect(inspected.media[0].status).toBe('available'); expect(inspected.media[0].path).toContain(path.join('recovery', version.id, 'media'));
      const output = path.join(temporary, `recovered-${index}.mp4`); await call('export_video', { outputPath: output, preset: 'ultrafast', crf: 12 });
      const frames = await native(['-v', 'error', '-i', output, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
      const size = 96 * 64 * 3; expect(frames.length / size).toBe(index === 0 ? 20 : 30);
      const redFrame = frames.subarray((index === 0 ? 5 : 15) * size, (index === 0 ? 6 : 16) * size);
      expect(redFrame[(32 * 96 + 48) * 3]).toBeGreaterThan(230);
      if (index === 1) expect(frames[0]).toBeLessThan(5);
      const pcm = await native(['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
      const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      const rms = (start: number, end: number) => {
        const values = samples.subarray(Math.round(start * 48000), Math.round(end * 48000));
        return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
      };
      expect(rms(index + .2, index + .8)).toBeGreaterThan(.07);
      if (index === 1) expect(rms(.2, .8)).toBeLessThan(.001);
    }
    const saved = await call('project_save', { path: path.join(temporary, 'Recovered.freemier') });
    expect(saved.projectProtection.dirty).toBe(false);
    expect((await call('project_recovery_list')).recoveries).toHaveLength(2);
  }, 60000);
});
