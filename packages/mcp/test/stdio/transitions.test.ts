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
let workspace: string, client: Client, red: string, blue: string;
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-transition-mcp-'));
  red = path.join(workspace, 'red.mp4'); blue = path.join(workspace, 'blue.mp4');
  for (const [color, frequency, file] of [['red', 400, red], ['blue', 800, blue]] as const)
    await native(['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=10:d=6`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=6`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  client = new Client({ name: 'transition-acceptance', version: '1' });
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
async function setup() {
  await call('project_create', { name: 'Transitions', width: 96, height: 64, fps: 10 });
  const tracks = (await call('timeline_inspect')).tracks;
  const videoId = tracks.find((t: any) => t.kind === 'video').id, audioId = tracks.find((t: any) => t.kind === 'audio').id;
  const leftAsset = (await call('media_import', { path: red, copyIntoProject: true })).asset;
  const rightAsset = (await call('media_import', { path: blue, copyIntoProject: true })).asset;
  const left = await call('clip_add_linked', { assetId: leftAsset.id, videoTrackId: videoId, audioTrackId: audioId, start: 0, sourceIn: 2, duration: 2 });
  const right = await call('clip_add_linked', { assetId: rightAsset.id, videoTrackId: videoId, audioTrackId: audioId, start: 2, sourceIn: 2, duration: 2 });
  return { left, right, videoId, audioId };
}
describe('transitions through a standard MCP client', () => {
  it('discovers descriptive commands and refuses stale revisions and locked linked partners atomically', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(87);
    for (const name of ['transition_add', 'transition_update', 'transition_remove', 'transition_list', 'transition_catalog']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.description!.length).toBeGreaterThan(80); expect(tool.inputSchema.type).toBe('object');
    }
    const catalog = (await call('transition_catalog')).catalog;
    expect(catalog.types.map((t: any) => t.type)).toEqual(['dissolve', 'audio_crossfade']);
    expect((await call('editor_capabilities')).transitions).toEqual(catalog);
    const { left, right, audioId } = await setup();
    const args = { leftClipId: left.videoClip.id, rightClipId: right.videoClip.id, type: 'dissolve', durationFrames: 10 };
    await call('track_update', { trackId: audioId, locked: true });
    const locked = await call('project_info');
    await expect(call('transition_add', args)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await call('project_info')).toEqual(locked);
    await call('track_update', { trackId: audioId, locked: false });
    const before = await call('project_info');
    await expect(call('transition_add', { ...args, expectedRevision: before.revision - 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call('transition_add', { ...args, durationFrames: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await call('project_info')).toEqual(before);
    const transition = (await call('transition_add', { ...args, expectedRevision: before.revision })).transition;
    const after = await call('project_info'); expect(after.revision).toBe(before.revision + 1); expect(after.duration).toBe(4);
    const item = (await call('transition_list', { clipId: right.videoClip.id })).transitions[0];
    expect(item).toMatchObject({ transition, start: 1.5, end: 2.5, cut: 2, leftWindow: { sourceOut: 4.5 }, rightWindow: { sourceIn: 1.5 } });
    await call('transition_update', { transitionId: transition.id, durationFrames: 5, alignment: 'start' });
    expect((await call('transition_list')).transitions[0]).toMatchObject({ start: 2, end: 2.5 });
    await call('undo'); expect((await call('transition_list')).transitions[0].transition.durationFrames).toBe(10);
    await call('redo'); expect((await call('transition_list')).transitions[0].transition.durationFrames).toBe(5);
    await call('transition_remove', { transitionId: transition.id }); expect((await call('transition_list')).transitions).toEqual([]);
    await call('undo'); expect((await call('transition_list')).transitions).toHaveLength(1);
  });

  it('preserves source windows and transition metadata across portable save/reopen and refuses breaking edits', async () => {
    const { left, right, videoId } = await setup();
    const added = (await call('transition_add', { leftClipId: left.videoClip.id, rightClipId: right.videoClip.id, type: 'dissolve', durationFrames: 7, alignment: 'end' })).transition;
    const before = await call('project_info');
    await expect(call('clip_move', { clipId: right.videoClip.id, start: 3 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call('clip_remove', { clipId: left.videoClip.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call('keyframe_set', { clipId: left.videoClip.id, property: 'opacity', time: 0, value: 1 })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await call('project_info')).toEqual(before);
    await call('track_update', { trackId: videoId, locked: true });
    const locked = await call('project_info');
    await expect(call('transition_remove', { transitionId: added.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await call('project_info')).toEqual(locked);
    await call('track_update', { trackId: videoId, locked: false });
    const transitions = (await call('transition_list')).transitions;
    const saved = path.join(workspace, 'portable'); await call('project_save', { path: saved });
    await call('project_create'); await call('project_load', { path: saved });
    expect((await call('transition_list')).transitions).toEqual(transitions);
    expect((await call('clip_inspect', { clipId: left.videoClip.id })).clip).toMatchObject({ start: 0, sourceIn: 2, sourceOut: 4 });
    const output = path.join(workspace, 'portable-transition.mp4'); await call('export_video', { outputPath: output, preset: 'ultrafast' });
    const frames = await native(['-v', 'error', '-i', output, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(frames.length).toBe(96 * 64 * 3 * 40);
  }, 60000);

  it('exports decoded midpoint pictures and complementary two-tone sound without changing duration', async () => {
    const { left, right } = await setup();
    await call('transition_add', { leftClipId: left.videoClip.id, rightClipId: right.videoClip.id, type: 'dissolve', durationFrames: 10 });
    await call('transition_add', { leftClipId: left.audioClip.id, rightClipId: right.audioClip.id, type: 'audio_crossfade', durationFrames: 10 });
    const output = path.join(workspace, 'picture-and-sound.mp4'); await call('export_video', { outputPath: output, preset: 'ultrafast', crf: 12 });
    const frames = await native(['-v', 'error', '-i', output, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const frameSize = 96 * 64 * 3;
    expect(frames.length / frameSize).toBe(40);
    const pixel = (index: number) => [...frames.subarray(index * frameSize + (32 * 96 + 48) * 3, index * frameSize + (32 * 96 + 48) * 3 + 3)];
    expect(pixel(10)[0]).toBeGreaterThan(235); expect(pixel(10)[2]).toBeLessThan(10);
    expect(pixel(20)[0]).toBeGreaterThan(110); expect(pixel(20)[0]).toBeLessThan(145);
    expect(pixel(20)[2]).toBeGreaterThan(110); expect(pixel(20)[2]).toBeLessThan(145);
    expect(pixel(30)[2]).toBeGreaterThan(235); expect(pixel(30)[0]).toBeLessThan(10);
    const pcm = await native(['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    expect(samples.length).toBeGreaterThanOrEqual(4 * 48000);
    const amplitude = (frequency: number, time: number) => {
      const first = Math.round((time - .05) * 48000), count = 4800;
      let sin = 0, cos = 0;
      for (let i = 0; i < count; i++) { const phase = 2 * Math.PI * frequency * (first + i) / 48000; sin += samples[first + i]! * Math.sin(phase); cos += samples[first + i]! * Math.cos(phase); }
      return 2 * Math.hypot(sin, cos) / count;
    };
    const fullLeft = amplitude(400, 1), fullRight = amplitude(800, 3);
    expect(fullLeft).toBeGreaterThan(.10); expect(fullRight).toBeGreaterThan(.10);
    const measurements = [1.75, 2, 2.25].map(time => ({ time, left: amplitude(400, time) / fullLeft, right: amplitude(800, time) / fullRight }));
    const expected = [[.75, .25], [.5, .5], [.25, .75]];
    const mismatch = measurements.some((item, index) => Math.abs(item.left - expected[index]![0]!) >= .05 || Math.abs(item.right - expected[index]![1]!) >= .05);
    const diagnostic = JSON.stringify({ fullLeft, fullRight, measurements, ...(mismatch ? {
      transitions: (await call('transition_list')).transitions,
      exportPlan: (await call('export_preview', { outputPath: output })).summary,
    } : {}) });
    for (const [index, [leftWeight, rightWeight]] of [[.75, .25], [.5, .5], [.25, .75]].entries()) {
      expect(measurements[index]!.left, diagnostic).toBeCloseTo(leftWeight!, 1);
      expect(measurements[index]!.right, diagnostic).toBeCloseTo(rightWeight!, 1);
    }
    expect((await call('timeline_duration')).duration).toBe(4);
  }, 60000);
});
