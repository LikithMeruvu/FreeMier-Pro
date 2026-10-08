import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EditorStore, addClip, addMediaAsset, addEffect, setKeyframe, updateClip, importEffectPreset, applyEffectPreset } from '@freemier/engine';
import { applyColorEffect, EASINGS, evaluateAnimatable, type TransformProperty } from '@freemier/shared';
import { exportProject, buildExportArgs } from '../../src/export/export.js';
import { probeMedia } from '../../src/import/media.js';

const exec = promisify(execFile), W = 96, H = 64;
let dir: string, solid: string, box: string, detail: string, tone: string;
const ff = async (args: string[]) => exec('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
beforeAll(async () => {
  await fs.mkdir('.tmp', { recursive: true }); dir = await fs.mkdtemp(path.resolve('.tmp/render-fx-'));
  solid = path.join(dir, 'solid.mp4'); box = path.join(dir, 'box.mp4'); detail = path.join(dir, 'detail.mp4'); tone = path.join(dir, 'tone.wav');
  await ff(['-f', 'lavfi', '-i', 'color=c=0x4080c0:s=96x64:r=10:d=4', '-c:v', 'libx264', '-crf', '0', solid]);
  await ff(['-f', 'lavfi', '-i', 'color=c=black:s=96x64:r=10:d=4', '-vf', 'drawbox=x=24:y=24:w=48:h=16:color=red:t=fill', '-c:v', 'libx264', '-crf', '0', box]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=4', '-c:v', 'libx264', '-crf', '0', detail]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=4', tone]);
});
afterAll(async () => { expect(path.resolve(dir).startsWith(path.resolve('.tmp') + path.sep)).toBe(true); await fs.rm(dir, { recursive: true, force: true }); });
async function setup(source = solid, start = 0) {
  const store = EditorStore.create({ width: W, height: H, fps: 10 }), asset = addMediaAsset(store, await probeMedia(source));
  const track = store.project.timeline.tracks.find((t) => t.kind === (source === tone ? 'audio' : 'video'))!;
  const clip = addClip(store, { trackId: track.id, assetId: asset.id, start, sourceIn: 1, duration: 2 }); return { store, clip };
}
let serial = 0;
async function render(store: EditorStore) { const file = path.join(dir, `export-${serial++}.mp4`); await exportProject(store.project, { outputPath: file, crf: 0, preset: 'ultrafast' }); return file; }
async function frame(file: string, time = .5): Promise<Buffer> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  expect(stdout.length).toBe(W * H * 3); return stdout;
}
const rgb = (pixels: Buffer, x = 48, y = 32) => [...pixels.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
function redBounds(pixels: Buffer) {
  const points: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = rgb(pixels, x, y); if (r! > 30 && r! > g! * 3 && r! > b! * 3) points.push([x, y]); }
  expect(points.length).toBeGreaterThan(10);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { x: xs.reduce((a, b) => a + b) / xs.length, y: ys.reduce((a, b) => a + b) / ys.length, width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 };
}
function edgeEnergy(pixels: Buffer) { let energy = 0; for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) for (let c = 0; c < 3; c++) energy += Math.abs(pixels[(y * W + x) * 3 + c]! - pixels[(y * W + x - 1) * 3 + c]!); return energy; }

describe('decoded animation', () => {
  it('renders imported ordered preset settings into decoded pixels and restores output after undo', async () => {
    const { store, clip } = await setup();
    const baseline = rgb(await frame(await render(store)));
    const preset = importEffectPreset(store, JSON.stringify({ format: 'freemier-effect-preset', version: 1, name: 'Measured sepia', description: 'Sepia followed by contrast/brightness', author: 'Independent fixture', tags: [], media: 'video', effects: [{ type: 'sepia', enabled: true, params: { amount: .7 } }, { type: 'color_adjust', enabled: true, params: { contrast: 1.1, brightness: .02 } }] }));
    applyEffectPreset(store, preset.id, clip.id, 'replace'); const changed = rgb(await frame(await render(store)));
    const expected = applyColorEffect(applyColorEffect(baseline, 'sepia', { amount: .7 }), 'color_adjust', { contrast: 1.1, brightness: .02 });
    for (let c = 0; c < 3; c++) expect(Math.abs(changed[c]! - expected[c]!)).toBeLessThanOrEqual(4);
    expect(changed).not.toEqual(baseline); store.undo(); expect(rgb(await frame(await render(store)))).toEqual(baseline);
  }, 120000);
  it.each(EASINGS)('renders %s at clip-local time despite nonzero source/timeline offsets', async (easing) => {
    const { store, clip } = await setup(box, 2);
    setKeyframe(store, clip.id, 'x', 0, -.2, easing); setKeyframe(store, clip.id, 'x', 1, .2);
    const file = await render(store), before = await frame(file, 1), mid = redBounds(await frame(file, 2.2)), end = redBounds(await frame(file, 3.2));
    expect(Math.max(...before)).toBeLessThan(8);
    const x = evaluateAnimatable({ value: 0, keyframes: [{ time: 0, value: -.2, easing }, { time: 1, value: .2, easing: 'linear' }] }, .2);
    expect(Math.abs(mid.x - (47.5 + x * W))).toBeLessThan(2);
    expect(Math.abs(end.x - (47.5 + .2 * W))).toBeLessThan(2);
  }, 120000);
  it.each(['y', 'scale', 'rotation', 'opacity'] as TransformProperty[])('changes decoded %s over time', async (property) => {
    const { store, clip } = await setup(box, 2), initial = { y: -.2, scale: .5, rotation: 0, opacity: .25 }[property as 'y'], final = { y: .2, scale: 1, rotation: 90, opacity: 1 }[property as 'y'];
    setKeyframe(store, clip.id, property, 0, initial); setKeyframe(store, clip.id, property, 1, final);
    const file = await render(store), first = await frame(file, 2), last = await frame(file, 3.2), a = redBounds(first), b = redBounds(last);
    if (property === 'y') expect(b.y - a.y).toBeGreaterThan(22);
    else if (property === 'scale') expect(b.width / a.width).toBeGreaterThan(1.8);
    else if (property === 'rotation') { expect(a.width / a.height).toBeGreaterThan(2.5); expect(b.height / b.width).toBeGreaterThan(2.5); }
    else { expect(rgb(first)[0]).toBeLessThan(80); expect(rgb(last)[0]).toBeGreaterThan(230); }
  }, 120000);
});
describe('decoded ordered effects', () => {
  it.each(['color_adjust', 'grayscale', 'sepia'])('renders %s with the shared preview pixel formula', async (type) => {
    const baseline = await setup(), raw = rgb(await frame(await render(baseline.store))), { store, clip } = await setup();
    const params = type === 'color_adjust' ? { brightness: .1, contrast: 1.2, saturation: .5, gamma: 2 } : type === 'sepia' ? { amount: .6 } : {};
    addEffect(store, clip.id, type, params); const rendered = rgb(await frame(await render(store))), expected = applyColorEffect(raw, type, params);
    rendered.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThan(7));
    if (type === 'grayscale') expect(Math.max(...rendered) - Math.min(...rendered)).toBeLessThan(3);
  }, 120000);
  it('changes real spatial pixels with blur and sharpen', async () => {
    const base = await setup(detail), blur = await setup(detail), sharp = await setup(detail);
    addEffect(blur.store, blur.clip.id, 'blur', { radius: 3 }); addEffect(sharp.store, sharp.clip.id, 'sharpen', { amount: 1.5 });
    const raw = await frame(await render(base.store)), blurred = await frame(await render(blur.store)), sharpened = await frame(await render(sharp.store));
    expect(edgeEnergy(blurred)).toBeLessThan(edgeEnergy(raw) * .55); expect(edgeEnergy(sharpened)).toBeGreaterThan(edgeEnergy(raw) * 1.05);
  }, 120000);
  it('preserves stack order and ignores disabled effects', async () => {
    const a = await setup(), b = await setup(), c = await setup();
    addEffect(a.store, a.clip.id, 'sepia'); addEffect(a.store, a.clip.id, 'grayscale');
    addEffect(b.store, b.clip.id, 'grayscale'); addEffect(b.store, b.clip.id, 'sepia');
    const fx = addEffect(c.store, c.clip.id, 'grayscale'); updateClip(c.store, c.clip.id, { effects: [{ ...fx, enabled: false }] });
    const gray = rgb(await frame(await render(a.store))), warm = rgb(await frame(await render(b.store))), original = rgb(await frame(await render(c.store)));
    expect(Math.max(...gray) - Math.min(...gray)).toBeLessThan(3); expect(warm[0]! - warm[2]!).toBeGreaterThan(20); expect(original[2]! - original[0]!).toBeGreaterThan(100);
  }, 120000);
  it.each(['in', 'out'])('renders video fade %s in clip-local alpha', async (direction) => {
    const { store, clip } = await setup(box, 2); addEffect(store, clip.id, 'video_fade', { direction, duration: 1 }); const file = await render(store);
    const first = rgb(await frame(file, 2))[0]!, mid = rgb(await frame(file, 2.5))[0]!, end = rgb(await frame(file, 3.2))[0]!;
    expect(mid).toBeGreaterThan(110); expect(mid).toBeLessThan(145);
    if (direction === 'in') { expect(first).toBeLessThan(8); expect(end).toBeGreaterThan(230); } else { expect(first).toBeGreaterThan(230); expect(end).toBeLessThan(8); }
  }, 120000);
  it.each(['in', 'out'])('renders audio fade %s as measured PCM amplitude', async (direction) => {
    const { store, clip } = await setup(tone, 1); addEffect(store, clip.id, 'audio_fade', { direction, duration: 1 }); const file = await render(store);
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    expect(stdout.length / 4 / 48000).toBeGreaterThanOrEqual(3);
    expect(stdout.length / 4 / 48000).toBeLessThan(3.05);
    const rms = (start: number) => { let squares = 0; for (let i = Math.floor(start * 48000); i < Math.floor((start + .05) * 48000); i++) squares += stdout.readFloatLE(i * 4) ** 2; return Math.sqrt(squares / 2400); };
    expect(rms(.5)).toBeLessThan(.002);
    if (direction === 'in') { expect(rms(1.1)).toBeLessThan(rms(1.8) * .25); expect(rms(2.2)).toBeGreaterThan(.07); }
    else { expect(rms(1.8)).toBeLessThan(rms(1.1) * .3); expect(rms(2.2)).toBeLessThan(.002); }
  }, 120000);
  it('refuses enabled unknown persisted effects instead of silently exporting them', async () => {
    const { store, clip } = await setup(); updateClip(store, clip.id, { effects: [{ id: 'legacy', type: 'tracking', params: {}, enabled: true }] });
    expect(() => buildExportArgs(store.project, { outputPath: 'unused.mp4' })).toThrow(/Unsupported effect/i);
    updateClip(store, clip.id, { effects: [{ id: 'legacy', type: 'tracking', params: {}, enabled: false }] });
    expect(() => buildExportArgs(store.project, { outputPath: 'unused.mp4' })).not.toThrow();
  });
});
