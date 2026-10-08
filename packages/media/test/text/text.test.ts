import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAPTION_STYLE, DEFAULT_TEXT_STYLE } from '@freemier/shared';
import { EditorStore, addCaption, addTitle, removeTitle, updateCaptionTrack } from '@freemier/engine';
import { rasterText, fontList, FONT_HASH } from '../../src/rendering/text.js';
import { buildExportArgs, exportProject } from '../../src/export/export.js';
import { getFfmpegConfig, configureFfmpeg } from '../../src/providers/ffmpeg/run.js';
const exec = promisify(execFile);
async function removeTemporaryDirectory(directory: string): Promise<void> {
  expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(directory, { recursive: true, force: true });
}
async function pixels(file: string, time?: number) {
  const { stdout } = await exec(getFfmpegConfig().ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...(time === undefined ? [] : ['-ss', String(time)]), '-i', file, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }); return stdout as Buffer;
}
function bounds(data: Buffer, width: number) { let count = 0, left = width, right = 0, top = 8192, bottom = 0, maxAlpha = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && (data[i]! + data[i + 1]! + data[i + 2]!) > 20) { const p = i / 4, x = p % width, y = Math.floor(p / width); count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); maxAlpha = Math.max(maxAlpha, data[i + 3]!); } return { count, left, right, top, bottom, maxAlpha }; }
describe('canonical FFmpeg title glyphs', () => {
  it('rejects malformed project input before glyph/native work and leaves output untouched', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-invalid-export-'));
    const config = getFfmpegConfig();
    try {
      const store = EditorStore.create({ width: 320, height: 180, fps: 10 }); addTitle(store, { text: 'Never rasterize this', start: 0, end: 1 });
      const corrupt = { ...store.project, timeline: { ...store.project.timeline, tracks: [null] } } as never;
      const output = path.join(directory, 'existing.mp4'), cache = path.join(directory, 'no-cache');
      await fs.writeFile(output, 'existing destination must survive');
      configureFfmpeg({ ffmpegPath: path.join(directory, 'missing-ffmpeg') });
      expect(() => buildExportArgs(corrupt, { outputPath: output })).toThrow(/timeline.tracks\[0\]/);
      await expect(exportProject(corrupt, { outputPath: output, textCacheDirectory: cache })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'timeline.tracks[0]' } });
      expect(await fs.readFile(output, 'utf8')).toBe('existing destination must survive');
      await expect(fs.stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { configureFfmpeg(config); await removeTemporaryDirectory(directory); }
  });
  it('refuses incomplete prepared caption glyphs instead of producing an empty burn-in graph', () => {
    const store = EditorStore.create({ width: 320, height: 180, fps: 10 }); addCaption(store, { text: 'Required', startMs: 501, endMs: 1101 });
    expect(() => buildExportArgs(store.project, { outputPath: 'out.mp4' })).toThrow(/rasterized/);
    expect(() => buildExportArgs(store.project, { outputPath: 'out.mp4', preparedTextLayers: [] })).toThrow(/rasterized/);
    expect(buildExportArgs(store.project, { outputPath: 'out.mp4', captionPolicy: 'none' }).duration).toBe(1.2);
  });
  it('uses the verified licensed font and transparent Unicode/multiline pixels in paths containing quotes/spaces', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "freemier's text spaces-"));
    try {
      expect((await fontList())[0]!.sha256).toBe(FONT_HASH);
      const style = { ...DEFAULT_TEXT_STYLE, fontSize: 24, outlineWidth: 0, opacity: .5 };
      const text = "100% %{pts} : 'quotes' & \\ path\nRésumé Δ Ж";
      const file = await rasterText(text, style, 640, 360, directory), rgba = await pixels(file), b = bounds(rgba, 640);
      expect(b.count).toBeGreaterThan(1500); expect(Math.abs((b.left + b.right) / 2 - 320)).toBeLessThan(3); expect(Math.abs((b.top + b.bottom) / 2 - 180)).toBeLessThan(5); expect(b.maxAlpha).toBeGreaterThanOrEqual(125); expect(b.maxAlpha).toBeLessThanOrEqual(129); expect(rgba[3]).toBe(0);
      expect(await rasterText(text, style, 640, 360, directory)).toBe(file); expect((await fs.readdir(directory)).filter((f) => f.startsWith('render-'))).toEqual([]);
      const moved = bounds(await pixels(await rasterText('Anchor', { ...style, x: .2, y: .8 }, 360, 640, directory)), 360); expect(Math.abs((moved.left + moved.right) / 2 - 72)).toBeLessThan(3); expect(Math.abs((moved.top + moved.bottom) / 2 - 512)).toBeLessThan(5);
    } finally { expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }); }
  }, 30000);
  it('exports a title-only sequence with exact exclusive timing and real shared glyph placement', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-title-export-'));
    try {
      const store = EditorStore.create({ width: 320, height: 180, fps: 10 });
      addTitle(store, { text: 'Exact title', start: .5, end: 2, style: { fontSize: 30, outlineWidth: 0, color: '#00ff00' } });
      addTitle(store, { text: 'Duration', start: 2, end: 3, style: { opacity: 0 } });
      const output = path.join(directory, 'text only.mp4'), result = await exportProject(store.project, { outputPath: output, preset: 'ultrafast', crf: 12 });
      expect(result.durationSeconds).toBe(3); expect(result.clipCount).toBe(0);
      for (const time of [.4, 2, 2.5]) { const b = bounds(await pixels(output, time), 320); expect(b.count).toBe(0); }
      const b = bounds(await pixels(output, .5), 320); expect(b.count).toBeGreaterThan(600); expect(Math.abs((b.left + b.right) / 2 - 160)).toBeLessThan(5); expect(Math.abs((b.top + b.bottom) / 2 - 90)).toBeLessThan(5);
    } finally { expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }); }
  }, 30000);
  it('burns real caption glyphs at millisecond intervals and creates an explicit SRT sidecar', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-caption-export-'));
    try {
      const store = EditorStore.create({ width: 320, height: 180, fps: 10 });
      const hidden = addTitle(store, { text: 'duration handle', start: 0, end: 2, style: { opacity: 0 } });
      addCaption(store, { text: 'CAPTION GREEN', startMs: 503, endMs: 1101 });
      updateCaptionTrack(store, { style: { ...DEFAULT_CAPTION_STYLE, fontSize: 30, color: '#00ff00', backgroundOpacity: 0, outlineWidth: 0, y: .5, verticalAlign: 'middle' } });
      const output = path.join(directory, 'captions.mp4'), result = await exportProject(store.project, { outputPath: output, preset: 'ultrafast', crf: 12 });
      expect(result.durationSeconds).toBe(2);
      expect(bounds(await pixels(output, .5), 320).count).toBe(0);
      const inside = bounds(await pixels(output, .6), 320); expect(inside.count).toBeGreaterThan(400); expect(inside.right).toBeGreaterThan(inside.left);
      expect(bounds(await pixels(output, 1.1), 320).count).toBeGreaterThan(400);
      const after = bounds(await pixels(output, 1.2), 320); expect(after.count).toBe(0);

      removeTitle(store, hidden.id);
      const sidecar = await exportProject(store.project, { outputPath: path.join(directory, 'sidecar.mp4'), preset: 'ultrafast', crf: 12, captionPolicy: 'sidecar' });
      expect(sidecar.durationSeconds).toBe(1.2); expect(sidecar.sidecarPath).toBe(path.join(directory, 'sidecar.mp4.srt'));
      expect(await fs.readFile(sidecar.sidecarPath!, 'utf8')).toContain('00:00:00,503 --> 00:00:01,101\nCAPTION GREEN');
      expect(bounds(await pixels(sidecar.outputPath, .6), 320).count).toBe(0);
      const none = await exportProject(store.project, { outputPath: path.join(directory, 'none.mp4'), preset: 'ultrafast', captionPolicy: 'none' });
      expect(none.durationSeconds).toBe(1.2); expect(none.sidecarPath).toBeUndefined(); expect(bounds(await pixels(none.outputPath, .6), 320).count).toBe(0);
      updateCaptionTrack(store, { enabled: false });
      const disabled = await exportProject(store.project, { outputPath: path.join(directory, 'disabled.mp4'), preset: 'ultrafast' });
      expect(disabled.durationSeconds).toBe(1.2); expect(bounds(await pixels(disabled.outputPath, .6), 320).count).toBe(0);
      for (const file of [sidecar.outputPath, none.outputPath, disabled.outputPath]) {
        const { stdout } = await exec(getFfmpegConfig().ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file], { windowsHide: true });
        expect(JSON.parse(stdout).streams[0].nb_read_frames).toBe('12');
      }
    } finally { expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }); }
  }, 60000);
});
