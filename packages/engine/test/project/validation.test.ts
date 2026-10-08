import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { EditorStore, createEmptyProject, addMediaAsset, addClip, updateClip, validateProject, saveProject, loadProject } from '../../src/index.js';

async function removeTemporaryDirectory(directory: string): Promise<void> {
  expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(directory, { recursive: true, force: true });
}

function project() {
  const store = EditorStore.create({ fps: 30000 / 1001, width: 320, height: 180 });
  const asset = addMediaAsset(store, { id: 'media_sample', path: 'nested/media file.mp4', copied: true, name: 'Sample', kind: 'video', duration: 10.017, width: 640, height: 360, fps: 30, hasAudio: true, sampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', probedAt: 0 });
  const trackId = store.project.timeline.tracks[1]!.id;
  addClip(store, { trackId, assetId: asset.id, duration: 1 });
  addClip(store, { trackId, assetId: asset.id, start: 2, sourceIn: 1, duration: 2 });
  return store.project;
}
// Corrupt independent file fields and submit the snapshots to real state boundaries.
const corruptions: [string, unknown, string][] = [
  ['version', 0, 'version'], ['version', 1.5, 'version'], ['version', NaN, 'version'],
  ['createdAt', -1, 'createdAt'], ['updatedAt', null, 'updatedAt'],
  ['timeline', [], 'timeline'], ['timeline.fps', 0, 'timeline.fps'], ['timeline.fps', Infinity, 'timeline.fps'],
  ['timeline.width', 12.5, 'timeline.width'], ['timeline.height', -10, 'timeline.height'],
  ['media', {}, 'media'], ['media.0', null, 'media[0]'],
  ['media.0.id', '../outside', 'media[0].id'], ['media.0.path', '../outside.mp4', 'media[0].path'],
  ['media.0.path', 'C:outside.mp4', 'media[0].path'], ['media.0.copied', 'true', 'media[0].copied'],
  ['media.0.kind', 'stream', 'media[0].kind'], ['media.0.duration', NaN, 'media[0].duration'],
  ['media.0.width', 0, 'media[0].width'], ['media.0.sampleRate', -1, 'media[0].sampleRate'],
  ['media.0.hasAudio', 1, 'media[0].hasAudio'], ['media.0.videoCodec', {}, 'media[0].videoCodec'],
  ['timeline.tracks.0', null, 'timeline.tracks[0]'], ['timeline.tracks.1.kind', 'image', 'timeline.tracks[1].kind'],
  ['timeline.tracks.1.locked', 'false', 'timeline.tracks[1].locked'], ['timeline.tracks.1.order', 1.5, 'timeline.tracks[1].order'],
  ['timeline.tracks.1.clips', {}, 'timeline.tracks[1].clips'], ['timeline.tracks.1.clips.0', null, 'timeline.tracks[1].clips[0]'],
  ['timeline.tracks.1.clips.0.assetId', 'missing', 'timeline.tracks[1].clips[0].assetId'],
  ['timeline.tracks.1.clips.0.start', -1, 'timeline.tracks[1].clips[0].start'],
  ['timeline.tracks.1.clips.0.duration', 0, 'timeline.tracks[1].clips[0].duration'],
  ['timeline.tracks.1.clips.0.sourceIn', 5, 'timeline.tracks[1].clips[0].sourceOut'],
  ['timeline.tracks.1.clips.0.sourceOut', 50, 'timeline.tracks[1].clips[0].sourceOut'],
  ['timeline.tracks.1.clips.0.volume', 5, 'timeline.tracks[1].clips[0].volume'],
  ['timeline.tracks.1.clips.0.transform', null, 'timeline.tracks[1].clips[0].transform'],
  ['timeline.tracks.1.clips.0.transform.scale.value', 0, 'timeline.tracks[1].clips[0].transform.scale.value'],
  ['timeline.tracks.1.clips.0.transform.x.keyframes', [null], 'timeline.tracks[1].clips[0].transform.x.keyframes[0]'],
  ['timeline.tracks.1.clips.0.effects', [null], 'timeline.tracks[1].clips[0].effects[0]'],
];
function replace(p: Project, field: string, value: unknown): Project {
  const copy: any = structuredClone(p), fields = field.split('.'); let target = copy;
  for (const key of fields.slice(0, -1)) target = target[key];
  target[fields.at(-1)!] = value;
  return copy;
}
describe('project input validation', () => {
  it.each(corruptions)('refuses malformed %s before loading or changing history', (field, value, expected) => {
    const original = project(), store = new EditorStore(original), events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    updateClip(store, original.timeline.tracks[1]!.clips[0]!.id, { label: 'Earlier edit' });
    store.undo();
    const before = store.state, undo = store.canUndo, redo = store.canRedo, count = events.length;
    const corrupt = replace(original, field, value);
    for (const reject of [() => store.load(corrupt), () => store.mutate('project', [], () => corrupt), () => new EditorStore(corrupt)]) {
      try { reject(); expect.fail('Expected invalid project refusal'); }
      catch (error) {
        expect(error).toBeInstanceOf(EditorError);
        expect((error as EditorError).toJSON()).toMatchObject({ code: 'INVALID_ARGUMENT', details: { source: '<memory>', field: expected } });
      }
    }
    expect(store.state).toBe(before); expect(store.canUndo).toBe(undo); expect(store.canRedo).toBe(redo); expect(events).toHaveLength(count);
    expect(store.redo()).toBe(true); expect(store.project.timeline.tracks[1]!.clips[0]!.label).toBe('Earlier edit');
  });
  it('refuses duplicate identities, overlapping clips, malformed keys and effects', () => {
    const cases: [ (p: any) => void, string][] = [
      [(p) => p.media.push(p.media[0]), 'media[1].id'],
      [(p) => p.timeline.tracks.push(p.timeline.tracks[1]), 'timeline.tracks[2].id'],
      [(p) => p.timeline.tracks[1].clips[1].id = p.timeline.tracks[1].clips[0].id, '.clips[1].id'],
      [(p) => p.timeline.tracks[1].clips[1].start = .5, '.clips'],
      [(p) => p.timeline.tracks[1].clips[0].transform.x.keyframes = [{ time: 0, value: 0, easing: 'linear' }, { time: 0, value: 1, easing: 'hold' }], '.keyframes[1].time'],
      [(p) => p.timeline.tracks[1].clips[0].transform.x.keyframes = [{ time: 0, value: 20, easing: 'linear' }], '.keyframes[0].value'],
      [(p) => p.timeline.tracks[1].clips[0].transform.x.keyframes = [{ time: 0, value: 0, easing: 'mystery' }], '.keyframes[0].easing'],
      [(p) => p.timeline.tracks[1].clips[0].effects = [{ id: 'fx', type: 'color_adjust', enabled: true, params: { gamma: -1 } }], '.effects[0].params'],
      [(p) => p.timeline.tracks[1].clips[0].effects = [{ id: 'fx', type: 'future', enabled: false, params: { data: {} } }], '.effects[0].params.data'],
      [(p) => p.timeline.tracks[1].clips[0].effects = [{ id: 'fx', type: 'blur', enabled: false, params: { radius: NaN } }], '.effects[0].params.radius'],
    ];
    for (const [mutate, field] of cases) {
      const corrupt = structuredClone(project()); mutate(corrupt);
      try { validateProject(corrupt); expect.fail('Expected refusal'); }
      catch (error) { expect(error).toBeInstanceOf(EditorError); expect(String((error as EditorError).details.field)).toContain(field); }
    }
  });
  it('retains unsorted arrays, fractional source rounding, unknown effects and additive JSON fields', async () => {
    const p: any = structuredClone(project()); p.timeline.tracks[1].clips.reverse();
    const clip = p.timeline.tracks[1].clips[0];
    clip.transform.x.keyframes = [{ time: 8, value: .5, easing: 'hold' }, { time: 0, value: 0, easing: 'linear' }];
    clip.effects = [{ id: 'legacy', type: 'future_plugin', params: { amount: .5, label: 'kept', flag: true }, enabled: true }];
    p.extra = { futureField: [1, 'keep'] }; p.media[0].extra = true;
    expect(validateProject(p)).toBe(p);
    const store = EditorStore.create({ fps: 30000 / 1001 }); addMediaAsset(store, { ...p.media[0], duration: 10.006 });
    const rounded = addClip(store, { trackId: store.project.timeline.tracks[1]!.id, assetId: p.media[0].id });
    expect(rounded.sourceOut).toBeGreaterThan(10.006); expect(validateProject(store.project)).toBe(store.project);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-validation-'));
    try { const target = path.join(directory, 'legacy.palmier'); await saveProject(p, target); expect(await loadProject(target)).toEqual(p); }
    finally { await removeTemporaryDirectory(directory); }
  });
  it('rejects corrupt disk input and invalid saves without altering valid saved bytes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-validation-'));
    try {
      const valid = project(), target = path.join(directory, 'safe.freemier'), file = await saveProject(valid, target), before = await fs.readFile(file);
      const corrupt = replace(valid, 'timeline.tracks.1.clips.0.transform.opacity.value', null);
      await expect(saveProject(corrupt, target)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(await fs.readFile(file)).toEqual(before); expect(await fs.readdir(target)).toEqual(['cache', 'project.json']);
      const missing = path.join(directory, 'no-output'); await expect(saveProject(corrupt, missing)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(fs.stat(missing + '.freemier')).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.writeFile(file, JSON.stringify(corrupt)); await expect(loadProject(target)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { source: file, field: 'timeline.tracks[1].clips[0].transform.opacity.value' } });
    } finally { await removeTemporaryDirectory(directory); }
  });
  it('refuses invalid profile options and future versions before replacing a store', () => {
    for (const opts of [{ fps: NaN }, { fps: .5 }, { fps: 241 }, { width: 0 }, { height: 10.5 }]) expect(() => createEmptyProject(opts)).toThrow(EditorError);
    expect(() => validateProject({ ...project(), version: 999 })).toThrow(/newer schema/);
  });
});
