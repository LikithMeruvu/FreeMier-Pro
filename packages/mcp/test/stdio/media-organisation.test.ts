import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let workspace: string, source: string, client: Client;
async function native(args: string[]) {
  return (await execute(process.env.FREEMIER_FFMPEG ?? 'ffmpeg', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const value = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
  if (response.isError) throw Object.assign(new Error(value.error.message), value.error);
  return value;
}
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-library-'));
  source = path.join(workspace, 'source.mp4');
  await native(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  client = new Client({ name: 'library-acceptance', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/mcp/dist/cli.js')], env: { ...env, FREEMIER_WORKSPACE: workspace, FREEMIER_NO_BRIDGE: '1' } }));
}, 60000);
afterAll(async () => {
  await client?.close();
  if (workspace) {
    expect(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

describe('media organisation through a standard MCP client', () => {
  it('discovers descriptive schemas and shares bins, metadata, queries and history', async () => {
    const tools = (await client.listTools()).tools;
    const names = ['media_bins', 'media_bin_create', 'media_bin_update', 'media_bin_delete', 'media_assign_bin', 'media_metadata_update', 'media_query', 'media_availability', 'find_relink_candidates', 'media_relink'];
    for (const name of names) {
      const tool = tools.find((item) => item.name === name)!;
      expect(tool.description!.length).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(tools).toHaveLength(94);
    await call('project_create', { width: 96, height: 64, fps: 10 });
    const parent = (await call('media_bin_create', { name: 'Footage' })).bin;
    const child = (await call('media_bin_create', { name: 'Interview', parentId: parent.id })).bin;
    const first = (await call('media_import', { path: source, binId: child.id })).asset;
    const second = (await call('media_import', { path: source })).asset;
    expect(first.sourceIdentity).toMatchObject({ size: (await fs.stat(source)).size, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await call('media_metadata_update', { assetId: first.id, name: 'Interview A', description: 'Outdoor conversation', tags: ['dialogue'], rating: 5 });
    await call('media_metadata_update', { assetId: second.id, name: 'B roll', rating: 1 });
    expect((await call('media_query', { text: 'DIALOGUE', kind: 'video', binId: parent.id, includeChildren: true })).assets.map((row: any) => row.assetId)).toEqual([first.id]);
    expect((await call('media_query', { binId: parent.id })).total).toBe(0);
    const rating = await call('media_query', { sortBy: 'rating', sortDirection: 'desc', limit: 1 });
    expect(rating.total).toBe(2); expect(rating.assets[0].assetId).toBe(first.id);
    expect((await call('media_query', { sortBy: 'rating', sortDirection: 'desc', limit: 1, offset: 1 })).assets[0].assetId).toBe(second.id);
    const before = await call('project_info');
    await expect(call('media_bin_delete', { binId: child.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call('media_bin_update', { binId: parent.id, parentId: child.id })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(call('media_metadata_update', { assetId: first.id, rating: 9 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(call('media_assign_bin', { assetIds: [first.id], binId: null, expectedRevision: before.revision - 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await call('project_info')).toEqual(before);
    await call('media_assign_bin', { assetIds: [first.id, second.id], binId: parent.id });
    expect((await call('media_query', { binId: parent.id })).total).toBe(2);
    await call('undo'); expect((await call('media_query', { binId: child.id })).total).toBe(1);
    await call('redo'); expect((await call('media_query', { binId: parent.id })).total).toBe(2);
    const saved = path.join(workspace, 'library');
    await call('project_save', { path: saved });
    await call('project_create'); await call('project_load', { path: saved });
    expect((await call('media_bins')).bins).toHaveLength(2);
    expect((await call('media_query', { text: 'outdoor' })).assets[0]).toMatchObject({ assetId: first.id, description: 'Outdoor conversation', tags: ['dialogue'], rating: 5 });
  });

  it('checks missing/replaced bytes and multiple candidates without changing history or choosing automatically', async () => {
    await call('project_create', { width: 96, height: 64, fps: 10 });
    const imported = path.join(workspace, 'disappearing.mp4');
    await fs.copyFile(source, imported);
    const asset = (await call('media_import', { path: imported })).asset;
    const before = await call('project_info');
    expect((await call('media_availability', { assetIds: [asset.id], verify: true })).observations[0].status).toBe('available');
    await fs.unlink(imported);
    expect((await call('media_availability', { assetIds: [asset.id], verify: true })).observations[0].status).toBe('missing');
    const originals = await fs.readFile(source), corrupt = Buffer.from(originals); corrupt[corrupt.length - 1] ^= 1;
    await fs.writeFile(imported, corrupt);
    expect((await call('media_availability', { assetIds: [asset.id], verify: true })).observations[0].status).toBe('changed');
    await expect(call('media_relink', { assetId: asset.id, path: imported, acceptUnverified: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    const directory = path.join(workspace, 'candidates'); await fs.mkdir(directory);
    await fs.copyFile(source, path.join(directory, 'one.mp4')); await fs.copyFile(source, path.join(directory, 'two.mp4'));
    await fs.copyFile(imported, path.join(directory, 'wrong.mp4'));
    const candidates = await call('find_relink_candidates', { assetId: asset.id, roots: [directory] });
    expect(candidates.candidates.map((item: any) => path.basename(item.path)).sort()).toEqual(['one.mp4', 'two.mp4']);
    expect(candidates.candidates.every((item: any) => item.match === 'exact')).toBe(true);
    expect((await call('find_relink_candidates', { assetId: asset.id, roots: [directory], maxEntries: 1 })).truncated).toBe(true);
    expect((await call('find_relink_candidates', { assetId: asset.id, roots: [directory], maxHashBytes: 1 })).truncated).toBe(true);
    expect((await call('media_inspect', { assetId: asset.id })).asset.path).toBe(imported);
    expect(await call('project_info')).toEqual(before);
    await call('media_relink', { assetId: asset.id, path: path.join(directory, 'two.mp4'), expectedRevision: before.revision });
    expect((await call('media_availability', { assetIds: [asset.id], verify: true })).observations[0].status).toBe('available');
    await call('undo'); expect((await call('media_inspect', { assetId: asset.id })).asset.path).toBe(imported);
    await call('redo');
  });

  it('preserves a linked edited timeline, copied media, metadata and decoded picture/sound after relink and portable reopen', async () => {
    await call('project_create', { width: 96, height: 64, fps: 10 });
    const bin = (await call('media_bin_create', { name: 'Scene' })).bin;
    const asset = (await call('media_import', { path: source, copyIntoProject: true, binId: bin.id })).asset;
    await call('media_metadata_update', { assetId: asset.id, tags: ['keep'], rating: 4 });
    const timeline = await call('timeline_inspect');
    const pair = await call('clip_add_linked', { assetId: asset.id, videoTrackId: timeline.tracks.find((t: any) => t.kind === 'video').id, audioTrackId: timeline.tracks.find((t: any) => t.kind === 'audio').id, sourceIn: .5, duration: 1.5 });
    const effect = await call('effect_add', { clipId: pair.videoClip.id, type: 'grayscale', params: {} });
    await call('effect_update', { clipId: pair.videoClip.id, effectId: effect.effect.id, enabled: false });
    await call('keyframe_set', { clipId: pair.videoClip.id, property: 'x', time: 0, value: 0 });
    const before = await call('timeline_inspect');
    const originalCopy = path.join(workspace, 'media', asset.path), originalBytes = await fs.readFile(originalCopy);
    await call('media_relink', { assetId: asset.id, path: source });
    const replacement = (await call('media_inspect', { assetId: asset.id })).asset;
    expect(replacement.path).not.toBe(asset.path);
    expect(await fs.readFile(originalCopy)).toEqual(originalBytes);
    expect(await call('timeline_inspect')).toEqual(before);
    await call('undo'); expect((await call('media_inspect', { assetId: asset.id })).asset.path).toBe(asset.path);
    await call('redo');
    const saved = path.join(workspace, 'portable'); await call('project_save', { path: saved });
    await call('project_create'); await call('project_load', { path: saved });
    expect(await call('timeline_inspect')).toEqual(before);
    expect((await call('media_query', { binId: bin.id })).assets[0]).toMatchObject({ tags: ['keep'], rating: 4 });
    await fs.unlink(originalCopy); await fs.unlink(path.join(workspace, 'media', replacement.path));
    expect((await call('media_availability', { verify: true })).observations[0].status).toBe('available');
    expect((await call('media_waveform', { assetId: asset.id })).peaks.length).toBeGreaterThan(0);
    const output = path.join(workspace, 'relocated.mp4'); await call('export_video', { outputPath: output, preset: 'ultrafast', crf: 18 });
    const frames = await native(['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(frames.length).toBe(96 * 64 * 3 * 15);
    const firstExpected = await native(['-v', 'error', '-i', source, '-ss', '0.5', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const actual = frames.subarray(0, firstExpected.length);
    expect(actual.reduce((sum, value, i) => sum + Math.abs(value - firstExpected[i]!), 0) / actual.length).toBeLessThan(12);
    const pcm = await native(['-v', 'error', '-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    expect(samples.length).toBeGreaterThan(48000);
    expect(Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)).toBeGreaterThan(.06);
  }, 60000);
});
