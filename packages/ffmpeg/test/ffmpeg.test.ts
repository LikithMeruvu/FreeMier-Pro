import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorStore } from '@freemier/engine';
import { addClip, addMediaAsset, addTrack, updateClip } from '@freemier/engine';
import { probeMedia, importMedia, extractThumbnail, extractWaveform } from '../src/media.js';
import { exportProject, buildExportArgs } from '../src/export.js';
import { runFfprobe, checkFfmpeg } from '../src/run.js';

/**
 * Integration tests against the REAL ffmpeg binary and REAL media files.
 * No mocks: the whole point is to prove the pipeline works end to end.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../../../fixtures/media');
const CLIP_A = path.join(FIXTURES, 'clipA.mp4');
const CLIP_B = path.join(FIXTURES, 'clipB.mp4');
const STILL = path.join(FIXTURES, 'still.png');

let tmpDir: string;
const exec = promisify(execFile);

beforeAll(async () => {
  const version = await checkFfmpeg();
  expect(version.ffmpeg).toMatch(/ffmpeg/i);
  const tempRoot = path.resolve(here, '../../../.tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  tmpDir = await fs.mkdtemp(path.join(tempRoot, 'ffmpeg-'));
});
afterAll(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

const videoTrackId = (s: EditorStore) =>
  s.project.timeline.tracks.find((t) => t.kind === 'video')!.id;

/** Read the true duration of a file back out of ffprobe. */
async function probeDuration(file: string): Promise<number> {
  const json = (await runFfprobe([
    '-v', 'error', '-print_format', 'json', '-show_format', file,
  ])) as { format?: { duration?: string } };
  return Number(json.format?.duration ?? 0);
}

describe('probeMedia', () => {
  it('probes a video with audio', async () => {
    const asset = await probeMedia(CLIP_A);
    expect(asset.kind).toBe('video');
    expect(asset.width).toBe(640);
    expect(asset.height).toBe(360);
    expect(asset.fps).toBeCloseTo(30, 1);
    expect(asset.duration).toBeGreaterThan(9);
    expect(asset.hasAudio).toBe(true);
    expect(asset.videoCodec).toBe('h264');
    expect(asset.audioCodec).toBe('aac');
  });

  it('probes a still image and assigns a nominal duration', async () => {
    const asset = await probeMedia(STILL);
    expect(asset.kind).toBe('image');
    expect(asset.width).toBe(640);
    expect(asset.duration).toBeGreaterThan(0);
  });
  it('probes a video without audio', async () => {
    const asset = await probeMedia(CLIP_B);
    expect(asset.kind).toBe('video');
    expect(asset.hasAudio).toBe(false);
    expect(asset.audioCodec).toBe(null);
  });

  it('fails clearly for a missing file', async () => {
    await expect(probeMedia(path.join(FIXTURES, 'nope.mp4'))).rejects.toThrowError(/not found/i);
  });

  it('reports a clear error when ffprobe cannot read the media', async () => {
    const junk = path.join(tmpDir, 'junk.mp4');
    await fs.writeFile(junk, 'this is not a video');
    await expect(probeMedia(junk)).rejects.toThrowError(/Could not determine|ffprobe failed/i);
  });
});

describe('extractThumbnail', () => {
  it('writes a real image file', async () => {
    const out = path.join(tmpDir, 'thumb.jpg');
    await extractThumbnail(CLIP_A, out, 2, 160);
    const stat = await fs.stat(out);
    expect(stat.size).toBeGreaterThan(500);
  });

  it('clamps a timestamp past the end instead of failing', async () => {
    const out = path.join(tmpDir, 'thumb-late.jpg');
    await extractThumbnail(CLIP_A, out, 9999, 160);
    expect((await fs.stat(out)).size).toBeGreaterThan(500);
  });
});

describe('extractWaveform', () => {
  it('returns normalized peaks of the requested length', async () => {
    const peaks = await extractWaveform(CLIP_A, 200);
    expect(peaks).toHaveLength(200);
    expect(Math.max(...peaks)).toBeGreaterThan(0.1);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });
});

describe('buildExportArgs', () => {
  it('produces a filter graph containing every clip window', async () => {
    const store = EditorStore.create({ fps: 30, width: 640, height: 360 });
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    addClip(store, { trackId: videoTrackId(store), assetId: a.id, start: 0, duration: 4 });

    const { args, duration, clipCount } = buildExportArgs(store.project, {
      outputPath: path.join(tmpDir, 'x.mp4'),
    });
    expect(clipCount).toBe(1);
    expect(duration).toBeCloseTo(4, 3);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('color=c=black');
    expect(graph).toContain('overlay=');
    expect(graph).toContain('anullsrc'); // no audio track used -> silent bed
  });

  it('refuses an empty timeline', () => {
    const store = EditorStore.create();
    expect(() => buildExportArgs(store.project, { outputPath: 'x.mp4' })).toThrowError(/empty timeline/i);
  });

  it('refuses a clip pointing at a missing asset', async () => {
    const store = EditorStore.create();
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    const clip = addClip(store, { trackId: videoTrackId(store), assetId: a.id, duration: 2 });
    // Remove the asset from the library but leave the clip in place.
    store.mutate('media', [a.id], (p) => ({ ...p, media: p.media.filter((m) => m.id !== a.id) }));
    expect(() => buildExportArgs(store.project, { outputPath: 'x.mp4' })).toThrowError(/missing asset/i);
    expect(clip.id).toBeTruthy();
  });
});

describe('exportProject', () => {
  it('exports independently copied media after original files are removed, including equal filenames', async () => {
    const sourceA = path.join(tmpDir, 'source-a');
    const sourceB = path.join(tmpDir, 'source-b');
    const mediaDirectory = path.join(tmpDir, 'copied-media');
    await fs.mkdir(sourceA);
    await fs.mkdir(sourceB);
    const originalA = path.join(sourceA, 'same.mp4');
    const originalB = path.join(sourceB, 'same.mp4');
    await fs.copyFile(CLIP_A, originalA);
    await fs.copyFile(CLIP_B, originalB);
    const a = await importMedia(originalA, { copyTo: mediaDirectory });
    const b = await importMedia(originalB, { copyTo: mediaDirectory });
    expect(a.path).not.toBe(b.path);
    expect(a.name).toBe('same.mp4');
    expect(a.hasAudio).toBe(true);
    expect(b.hasAudio).toBe(false);
    await fs.unlink(originalA);
    await fs.unlink(originalB);
    const store = EditorStore.create({ fps: 30, width: 320, height: 180 });
    addMediaAsset(store, a);
    addMediaAsset(store, b);
    addClip(store, { trackId: videoTrackId(store), assetId: a.id, duration: 1 });
    addClip(store, { trackId: videoTrackId(store), assetId: b.id, start: 1, duration: 1 });
    const outputPath = path.join(tmpDir, 'copied-export.mp4');
    expect(() => buildExportArgs(store.project, { outputPath })).toThrow(/mediaDirectory/);
    await exportProject(store.project, { outputPath, mediaDirectory, preset: 'ultrafast' });
    expect(Math.abs(await probeDuration(outputPath) - 2)).toBeLessThanOrEqual(1 / 30);
    await exec('ffmpeg', ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { windowsHide: true });
  }, 120000);

  it('exports actual H.265 within one project frame and decodes it', async () => {
    const store = EditorStore.create({ fps: 30, width: 320, height: 180 });
    const asset = addMediaAsset(store, await probeMedia(CLIP_A));
    addClip(store, { trackId: videoTrackId(store), assetId: asset.id, duration: 1.5 });
    const out = path.join(tmpDir, 'hevc.mp4');
    await exportProject(store.project, { outputPath: out, codec: 'h265', preset: 'ultrafast' });
    expect((await probeMedia(out)).videoCodec).toBe('hevc');
    expect(Math.abs(await probeDuration(out) - 1.5)).toBeLessThanOrEqual(1 / 30);
    await exec('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { windowsHide: true });
  }, 120000);

  it('scale, position and opacity are visible in decoded export pixels', async () => {
    const source = path.join(tmpDir, 'red.mp4');
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
    const store = EditorStore.create({ fps: 30, width: 320, height: 180 });
    const asset = addMediaAsset(store, await probeMedia(source));
    const clip = addClip(store, { trackId: videoTrackId(store), assetId: asset.id, duration: 1 });
    const transform = { ...clip.transform, scale: { value: .5, keyframes: [] }, x: { value: .25, keyframes: [] }, y: { value: .1, keyframes: [] }, opacity: { value: .5, keyframes: [] } };
    updateClip(store, clip.id, { transform });
    const out = path.join(tmpDir, 'transformed.mp4');
    await exportProject(store.project, { outputPath: out, crf: 10 });
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true });
    const pixels = stdout as Buffer;
    expect(pixels.length).toBe(320 * 180 * 3);
    const rgb = (x: number, y: number) => [...pixels.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    expect(Math.max(...rgb(20, 90))).toBeLessThan(8);
    expect(Math.max(...rgb(240, 30))).toBeLessThan(8);
    expect(rgb(240, 90)[0]).toBeGreaterThan(105);
    expect(rgb(240, 90)[0]).toBeLessThan(150);
    expect(rgb(240, 90)[1]).toBeLessThan(8);
  }, 120000);
  it('exports a single clip and the output duration matches', async () => {
    const store = EditorStore.create({ fps: 30, width: 640, height: 360 });
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    addClip(store, { trackId: videoTrackId(store), assetId: a.id, start: 0, duration: 4 });

    const out = path.join(tmpDir, 'single.mp4');
    const result = await exportProject(store.project, { outputPath: out });
    expect(result.clipCount).toBe(1);

    const stat = await fs.stat(out);
    expect(stat.size).toBeGreaterThan(1000);
    expect(Math.abs(await probeDuration(out) - 4)).toBeLessThanOrEqual(1 / store.project.timeline.fps);
  }, 120000);

  it('exports a multi-clip timeline with a gap and a trimmed clip', async () => {
    const store = EditorStore.create({ fps: 30, width: 640, height: 360 });
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    const b = addMediaAsset(store, await probeMedia(CLIP_B));
    const tid = videoTrackId(store);

    addClip(store, { trackId: tid, assetId: a.id, start: 0, duration: 3 });
    // Deliberate 2s gap at 3..5
    addClip(store, { trackId: tid, assetId: b.id, start: 5, duration: 2.5 });

    const out = path.join(tmpDir, 'multi.mp4');
    const result = await exportProject(store.project, { outputPath: out });
    expect(result.clipCount).toBe(2);
    expect(result.durationSeconds).toBeCloseTo(7.5, 3);
    expect(Math.abs(await probeDuration(out) - 7.5)).toBeLessThanOrEqual(1 / store.project.timeline.fps);
  }, 180000);

  it('reports progress that reaches 100%', async () => {
    const store = EditorStore.create({ fps: 30, width: 320, height: 180 });
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    addClip(store, { trackId: videoTrackId(store), assetId: a.id, start: 0, duration: 3 });

    const seen: number[] = [];
    await exportProject(store.project, {
      outputPath: path.join(tmpDir, 'progress.mp4'),
      width: 320,
      height: 180,
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  }, 120000);

  it('honours an image clip and a muted video track', async () => {
    const store = EditorStore.create({ fps: 30, width: 640, height: 360 });
    const img = addMediaAsset(store, await probeMedia(STILL));
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    const tid = videoTrackId(store);

    addClip(store, { trackId: tid, assetId: a.id, start: 0, duration: 2 });
    const audioTrack = addTrack(store, 'audio', 'A2');
    addClip(store, { trackId: audioTrack.id, assetId: img.id, start: 0, duration: 2 });

    const out = path.join(tmpDir, 'mixed.mp4');
    await exportProject(store.project, { outputPath: out });
    expect(await probeDuration(out)).toBeCloseTo(2, 1);
  }, 180000);

  it('surfaces ffmpeg stderr when the export genuinely fails', async () => {
    const store = EditorStore.create({ fps: 30, width: 640, height: 360 });
    const a = addMediaAsset(store, await probeMedia(CLIP_A));
    addClip(store, { trackId: videoTrackId(store), assetId: a.id, start: 0, duration: 2 });

    // Force a failure by pointing output at a directory that cannot be written.
    await expect(
      exportProject(store.project, { outputPath: path.join(tmpDir, 'no-such-dir', 'deep', 'x.mp4') }),
    ).rejects.toThrowError(/ffmpeg|export/i);
  }, 120000);
});
