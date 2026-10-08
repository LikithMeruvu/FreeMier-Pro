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
const ffmpeg = process.env.FREEMIER_FFMPEG ?? 'ffmpeg';
let workspace: string, source: string, client: Client;
async function native(args: string[]) {
  const { stdout } = await execute(ffmpeg, args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const value = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
  if (response.isError) throw Object.assign(new Error(value.error.message), value.error);
  return value;
}

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-linked-'));
  source = path.join(workspace, 'changing-video-and-tone.mp4');
  await native(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=6', '-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*(300*t+50*t*t)):s=48000:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  client = new Client({ name: 'linked-acceptance', version: '1' });
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

describe('linked AV over standard MCP with decoded native media', () => {
  it('keeps paired edits atomic, persists copied media and exports the correct picture/sound windows', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['clip_add_linked', 'clip_link', 'clip_unlink', 'project_update', 'track_reorder']));
    expect((await call('editor_capabilities')).linkedMedia.unsupported).toContain('offset groups');
    await call('project_create', { name: 'Linked edit', width: 96, height: 64, fps: 10 });
    const asset = (await call('media_import', { path: source, copyIntoProject: true })).asset;
    const timeline = await call('timeline_inspect');
    const video = timeline.tracks.find((track: { kind: string }) => track.kind === 'video');
    const audio = timeline.tracks.find((track: { kind: string }) => track.kind === 'audio');
    const pair = await call('clip_add_linked', { assetId: asset.id, videoTrackId: video.id, audioTrackId: audio.id, sourceIn: 2, duration: 2, strict: true });
    await call('clip_move', { clipId: pair.audioClip.id, start: 1 });
    expect((await call('clip_inspect', { clipId: pair.videoClip.id })).clip.start).toBe(1);
    await call('clip_slip', { clipId: pair.videoClip.id, delta: .5 });
    expect((await call('clip_inspect', { clipId: pair.audioClip.id })).clip.sourceIn).toBe(2.5);
    await call('track_update', { trackId: audio.id, locked: true });
    const before = await call('project_info');
    await expect(call('clip_trim', { clipId: pair.videoClip.id, edge: 'out', time: 2.8 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await call('project_info')).toEqual(before);
    await call('track_update', { trackId: audio.id, locked: false });
    const split = await call('clip_split', { clipId: pair.audioClip.id, at: 2.5 });
    expect((await call('timeline_inspect')).clipLinks).toHaveLength(2);
    await call('clip_trim', { clipId: split.second.id, edge: 'out', time: 2.8 });
    await call('undo'); expect((await call('clip_inspect', { clipId: split.second.id })).linkedClip.duration).toBe(.5);
    await call('redo'); expect((await call('clip_inspect', { clipId: split.second.id })).linkedClip.duration).toBeCloseTo(.3);
    await call('clip_unlink', { clipId: split.second.id });
    expect((await call('clip_inspect', { clipId: split.second.id })).link).toBeNull();
    await call('undo');
    const saved = path.join(workspace, 'Saved linked edit');
    await call('project_save', { path: saved });
    await call('project_create', { name: 'Other' });
    await call('project_load', { path: saved });
    expect((await call('timeline_inspect')).clipLinks).toHaveLength(2);
    expect((await call('media_waveform', { assetId: asset.id })).peaks.length).toBeGreaterThan(0);
    const output = path.join(workspace, 'linked-edit.mp4');
    await call('export_video', { outputPath: output, preset: 'ultrafast', crf: 18 });
    // Decode every frame/sample, not just container metadata or output size.
    const allFrames = await native(['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(allFrames.length / (96 * 64 * 3)).toBe(28);
    const gap = allFrames.subarray(0, 96 * 64 * 3);
    expect([...gap].reduce((sum, value) => sum + value, 0) / gap.length).toBeLessThan(3);
    const frame = async (file: string, time: number) => native(['-v', 'error', '-i', file, '-ss', String(time), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    for (const [time, sourceTime] of [[1.2, 2.7], [2.6, 4.1]]) {
      const [actual, expected] = await Promise.all([frame(output, time!), frame(source, sourceTime!)]);
      expect(actual.length).toBe(expected.length);
      const error = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]!), 0) / actual.length;
      expect(error).toBeLessThan(12);
    }
    const pcm = await native(['-v', 'error', '-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    const segment = (start: number, end: number) => samples.slice(Math.round(start * 48000), Math.round(end * 48000));
    const rms = (values: Float32Array) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    expect(rms(segment(.2, .7))).toBeLessThan(.001);
    for (const [start, end, expectedFrequency] of [[1.2, 1.4, 580], [2.55, 2.75, 715]]) {
      const values = segment(start!, end!);
      let crossings = 0;
      for (let i = 1; i < values.length; i++) if (values[i - 1]! <= 0 && values[i]! > 0) crossings++;
      expect(crossings / (end! - start!)).toBeCloseTo(expectedFrequency!, -1);
      expect(rms(values)).toBeGreaterThan(.07);
      expect(rms(values)).toBeLessThan(.13); // a second copy of the audio would exceed this bound
    }
  }, 120000);

  it('updates supported project settings and reorders tracks through standard tools with undo and refusals', async () => {
    await call('project_create', { name: 'Controls', width: 96, height: 64, fps: 10 });
    await call('project_update', { name: 'Changed', width: 128, height: 72, fps: 20 });
    expect(await call('project_info')).toMatchObject({ name: 'Changed', width: 128, height: 72, fps: 20 });
    await call('title_add', { text: 'Preserve', start: 0, end: 1 });
    await expect(call('project_update', { fps: 30 })).rejects.toMatchObject({ code: 'CONFLICT' });
    const tracks = (await call('timeline_inspect')).tracks;
    const ordered = () => [...tracks].sort((a, b) => b.order - a.order).map((track) => track.id);
    const previous = ordered();
    await call('track_reorder', { trackId: previous[0], direction: 'down' });
    expect((await call('timeline_inspect')).tracks.sort((a: { order: number }, b: { order: number }) => b.order - a.order).map((track: { id: string }) => track.id)).toEqual(previous.reverse());
    await call('undo');
    expect((await call('title_list')).titles[0].text).toBe('Preserve');
    const output = path.join(workspace, 'changed-dimensions.mp4');
    await call('export_video', { outputPath: output, preset: 'ultrafast' });
    const frames = await native(['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(frames.length).toBe(128 * 72 * 3 * 20);
  });
});
