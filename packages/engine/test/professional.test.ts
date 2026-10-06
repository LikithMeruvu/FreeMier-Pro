import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EditorStore, addClip, addMediaAsset, splitClip, trimClip, updateClip, moveClip, removeClip, removeTrack, saveProject, loadProject, projectDir } from '../src/index.js';
import { slipClip, rollClips, duplicateClip, updateTrack, setKeyframe, removeKeyframe, addEffect, updateEffect, removeEffect } from '../src/professional.js';
import { newMediaId, evaluateAnimatable, EASINGS } from '@freemier/shared';

function setup() {
  const store = EditorStore.create({ fps: 30 });
  const asset = addMediaAsset(store, { id: newMediaId(), path: '/fake.mp4', copied: false, name: 'fake', kind: 'video', duration: 20, width: 640, height: 360, fps: 30, hasAudio: true, sampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', probedAt: 0 });
  const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!;
  const a = addClip(store, { trackId: track.id, assetId: asset.id, start: 0, sourceIn: 2, duration: 3 });
  const b = addClip(store, { trackId: track.id, assetId: asset.id, start: 3, sourceIn: 6, duration: 3 });
  return { store, track, a, b, asset };
}
describe('professional atomic edits', () => {
  it('resolves new and legacy project directories without appending a second extension', () => {
    expect(projectDir('test')).toBe('test.freemier'); expect(projectDir('test.freemier')).toBe('test.freemier'); expect(projectDir('test.palmier')).toBe('test.palmier');
  });
  it('slips frame-aligned source bounds without moving or resizing the clip', () => {
    const { store, a } = setup(), before = store.project, rev = store.revision;
    const changed = slipClip(store, a.id, .51);
    expect(changed.start).toBe(a.start); expect(changed.duration).toBe(a.duration); expect(changed.sourceIn).toBeCloseTo(2 + 15 / 30);
    expect(store.revision).toBe(rev + 1); store.undo(); expect(store.project).toEqual(before); store.redo(); expect(store.project).not.toEqual(before);
  });
  it('rolls two source handles with one event and undo step', () => {
    const { store, a, b } = setup(), before = store.project, events: number[] = [];
    store.subscribe((event) => events.push(event.revision));
    const [left, right] = rollClips(store, a.id, b.id, 4);
    expect(left.duration).toBe(4); expect(left.sourceOut).toBe(6); expect(right.start).toBe(4); expect(right.duration).toBe(2); expect(right.sourceIn).toBe(7); expect(right.sourceOut).toBe(9);
    expect(events).toHaveLength(1); store.undo(); expect(store.project).toEqual(before);
  });
  it('rejects invalid handles/nonadjacency/overlap with no mutation', () => {
    const { store, a, b } = setup(), before = store.project, rev = store.revision;
    for (const edit of [() => slipClip(store, a.id, -3), () => rollClips(store, a.id, b.id, 6), () => duplicateClip(store, a.id, 1)]) expect(edit).toThrow();
    expect(store.project).toEqual(before); expect(store.revision).toBe(rev);
  });
  it('duplicates independent curves/effects and persists their exact values', async () => {
    const { store, a } = setup(); setKeyframe(store, a.id, 'x', 1, .25, 'ease-in'); const effect = addEffect(store, a.id, 'sepia', { amount: .4 });
    const copy = duplicateClip(store, a.id, 6); setKeyframe(store, copy.id, 'x', 1, -.2); updateEffect(store, copy.id, effect.id, { amount: .8 });
    const original = store.project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === a.id)!;
    expect(original.transform.x.keyframes[0]!.value).toBe(.25); expect(original.effects[0]!.params.amount).toBe(.4);
    const folder = await fs.mkdtemp(path.resolve('.tmp/pro-curves-'));
    try { const saved = await saveProject(store.project, path.join(folder, 'roundtrip')); expect(await loadProject(path.dirname(saved))).toEqual(store.project); } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
  it('enforces locks on existing and new edits while permitting header unlock', () => {
    const { store, track, a, b, asset } = setup(); updateTrack(store, track.id, { locked: true }); const before = store.project, rev = store.revision;
    for (const edit of [() => addClip(store, { trackId: track.id, assetId: asset.id, start: 8 }), () => removeClip(store, a.id), () => moveClip(store, a.id, 7), () => splitClip(store, a.id, 1), () => trimClip(store, a.id, 'out', 2), () => updateClip(store, a.id, { volume: .5 }), () => removeTrack(store, track.id), () => slipClip(store, a.id, 1), () => rollClips(store, a.id, b.id, 4), () => duplicateClip(store, a.id, 8), () => setKeyframe(store, a.id, 'x', 0, 0), () => addEffect(store, a.id, 'grayscale')]) expect(edit).toThrow(/locked/i);
    expect(store.project).toEqual(before); expect(store.revision).toBe(rev);
    const renamed = updateTrack(store, track.id, { name: undefined, muted: true }); expect(renamed.name).toBe(track.name); expect(renamed.locked).toBe(true);
    updateTrack(store, track.id, { locked: false }); expect(slipClip(store, a.id, 1).sourceIn).toBe(3);
  });
});
describe('validated animation/effects', () => {
  it.each(EASINGS)('evaluates outgoing %s segments and clamps endpoints', (easing) => {
    const curve = { value: 99, keyframes: [{ time: 0, value: 0, easing }, { time: 1, value: 1, easing: 'hold' as const }] };
    const expected = { linear: .25, hold: 0, 'ease-in': .0625, 'ease-out': .4375, 'ease-in-out': .15625 }[easing];
    expect(evaluateAnimatable(curve, .25)).toBe(expected); expect(evaluateAnimatable(curve, -1)).toBe(0); expect(evaluateAnimatable(curve, 2)).toBe(1);
  });
  it('upserts/removes quantized keys and rejects bad bounds/timing atomically', () => {
    const { store, a } = setup(); setKeyframe(store, a.id, 'opacity', .51, .5); setKeyframe(store, a.id, 'opacity', .5, .8);
    expect(store.project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === a.id)!.transform.opacity.keyframes).toHaveLength(1);
    const before = store.project; expect(() => setKeyframe(store, a.id, 'opacity', 1, 2)).toThrow(); expect(() => setKeyframe(store, a.id, 'x', 5, 0)).toThrow(); expect(store.project).toEqual(before);
    expect(removeKeyframe(store, a.id, 'opacity', .5).transform.opacity.keyframes).toHaveLength(0);
  });
  it('strictly validates ordered effect CRUD and media applicability', () => {
    const { store, a, asset } = setup(), audio = store.project.timeline.tracks.find((t) => t.kind === 'audio')!;
    const ac = addClip(store, { trackId: audio.id, assetId: asset.id, duration: 3 });
    const effect = addEffect(store, a.id, 'color_adjust', { gamma: 2 }); const before = store.project;
    for (const edit of [() => addEffect(store, a.id, 'unknown'), () => addEffect(store, a.id, 'blur', { radius: 30 }), () => addEffect(store, a.id, 'sepia', { fake: 1 }), () => addEffect(store, a.id, 'audio_fade'), () => addEffect(store, ac.id, 'grayscale'), () => addEffect(store, a.id, 'video_fade', { start: 2.5, duration: 1 })]) expect(edit).toThrow();
    expect(store.project).toEqual(before); expect(updateEffect(store, a.id, effect.id, { brightness: .1 }, false).enabled).toBe(false); expect(removeEffect(store, a.id, effect.id).effects).toHaveLength(0);
  });
  it.each(['animation', 'fade'])('rejects origin-changing edits of %s rather than restarting it', (mode) => {
    const { store, a, b } = setup();
    for (const clip of [a, b]) mode === 'animation' ? setKeyframe(store, clip.id, 'x', 1, .25) : addEffect(store, clip.id, 'video_fade', { duration: 2 });
    const before = store.project, rev = store.revision;
    for (const edit of [() => splitClip(store, a.id, 1), () => trimClip(store, a.id, 'in', .5), () => rollClips(store, a.id, b.id, 4)]) expect(edit).toThrow(/local animation origin/i);
    expect(store.project).toEqual(before); expect(store.revision).toBe(rev);
  });
});
