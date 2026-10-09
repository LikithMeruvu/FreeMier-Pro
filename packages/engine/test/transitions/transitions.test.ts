import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaAsset, Project } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { EditorStore, addClip, addEffect, addLinkedClip, addMediaAsset, addTrack, addTransition,
  loadProject, moveClip, queryTransitions, removeClip, removeTransition, saveProject, setKeyframe,
  slipClip, splitClip, trimClip, updateTrack, updateTransition, validateProject } from '../../src/index.js';

function setup(linked = false) {
  const store = EditorStore.create({ fps: 25 });
  const asset: MediaAsset = { id: 'asset', path: '/asset.mp4', copied: false, name: 'Asset', kind: 'video', duration: 4,
    width: 640, height: 360, fps: 25, hasAudio: true, sampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', probedAt: 0 };
  addMediaAsset(store, asset);
  const video = store.project.timeline.tracks.find((track) => track.kind === 'video')!, audio = store.project.timeline.tracks.find((track) => track.kind === 'audio')!;
  const place = (start: number) => linked ? addLinkedClip(store, { assetId: asset.id, videoTrackId: video.id, audioTrackId: audio.id, start, duration: 1, sourceIn: 1 }).videoClip
    : addClip(store, { assetId: asset.id, trackId: video.id, start, duration: 1, sourceIn: 1 });
  const left = place(0), right = place(1);
  return { store: new EditorStore(store.project), left, right, video, audio };
}
function add(store: EditorStore, leftClipId: string, rightClipId: string) {
  return addTransition(store, { leftClipId, rightClipId, type: 'dissolve', durationFrames: 5 });
}
function refuse(store: EditorStore, action: () => unknown, code?: string) {
  const state = store.state, undo = store.canUndo, redo = store.canRedo, events: unknown[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  try {
    expect(action).toThrow(EditorError);
    if (code) { try { action(); } catch (error) { expect(error).toMatchObject({ code }); } }
    expect(store.state).toBe(state); expect(store.canUndo).toBe(undo); expect(store.canRedo).toBe(redo); expect(events).toEqual([]);
  } finally { unsubscribe(); }
}

describe('engine transition ownership and compatibility', () => {
  it('creates, updates, queries, removes and undoes one event per edit without clip or timeline timing changes', () => {
    const { store, left, right, video } = setup(), before = store.project, events: any[] = []; store.subscribe((event) => events.push(event));
    const transition = add(store, left.id, right.id);
    expect(transition).toMatchObject({ type: 'dissolve', durationFrames: 5, alignment: 'center' });
    expect(store.project.timeline.tracks).toBe(before.timeline.tracks); expect(store.revision).toBe(1); expect(events).toHaveLength(1); expect(events[0].kind).toBe('timeline');
    expect(queryTransitions(store, { trackId: video.id, clipId: left.id })[0]).toMatchObject({ transition, startFrame: 23, endFrame: 28 });
    const added = store.project;
    updateTransition(store, transition.id, { durationFrames: 6, alignment: 'start' }); expect(store.revision).toBe(2); expect(events).toHaveLength(2);
    store.undo(); expect(store.project).toBe(added); store.redo();
    const state = store.state; updateTransition(store, transition.id, { durationFrames: 6, alignment: 'start' }); expect(store.state).toBe(state);
    expect(removeTransition(store, transition.id)).toBe(true); expect(queryTransitions(store)).toEqual([]);
    expect(store.project.timeline.tracks).toBe(before.timeline.tracks); store.undo(); expect(queryTransitions(store)).toHaveLength(1);
    refuse(store, () => removeTransition(store, 'absent'), 'NOT_FOUND');
  });
  it('checks both own and linked partner locks for CRUD while allowing locked transition snapshots and reads', () => {
    const { store, left, right, video, audio } = setup(true);
    updateTrack(store, audio.id, { locked: true });
    refuse(store, () => add(store, left.id, right.id), 'CONFLICT');
    updateTrack(store, audio.id, { locked: false }); const transition = add(store, left.id, right.id);
    for (const trackId of [audio.id, video.id]) {
      updateTrack(store, trackId, { locked: true }); expect(validateProject(store.project)).toBe(store.project); expect(queryTransitions(store)).toHaveLength(1);
      refuse(store, () => updateTransition(store, transition.id, { durationFrames: 8 }), 'CONFLICT');
      refuse(store, () => removeTransition(store, transition.id), 'CONFLICT');
      updateTrack(store, trackId, { locked: false });
    }
    expect(removeTransition(store, transition.id)).toBe(true);
  });
  it('supports independent audio crossfades, static transforms and effects and rejects mismatched kinds', () => {
    const { store, left, right, audio } = setup(true);
    addEffect(store, left.id, 'blur', { radius: 2 }); add(store, left.id, right.id);
    const members = store.project.timeline.tracks.find((track) => track.id === audio.id)!.clips;
    const audioTransition = addTransition(store, { leftClipId: members[0]!.id, rightClipId: members[1]!.id, type: 'audio_crossfade', durationFrames: 5, alignment: 'end' });
    expect(queryTransitions(store)).toHaveLength(2); expect(audioTransition.type).toBe('audio_crossfade');
    refuse(store, () => addTransition(store, { leftClipId: left.id, rightClipId: right.id, type: 'audio_crossfade', durationFrames: 5 }), 'UNSUPPORTED');
    refuse(store, () => addTransition(store, { leftClipId: members[0]!.id, rightClipId: members[1]!.id, type: 'dissolve', durationFrames: 5 }), 'UNSUPPORTED');
  });
  it('refuses later endpoint removal, move, split, cut trim, or handle loss atomically and retains redo', () => {
    const { store, left, right } = setup(); const transition = add(store, left.id, right.id);
    updateTransition(store, transition.id, { durationFrames: 6 }); store.undo();
    for (const action of [() => removeClip(store, left.id), () => removeClip(store, right.id), () => moveClip(store, right.id, 2),
      () => splitClip(store, left.id, .4), () => trimClip(store, left.id, 'out', .8), () => trimClip(store, right.id, 'in', 1.2),
      () => slipClip(store, left.id, 2), () => slipClip(store, right.id, -1),
    ]) refuse(store, action, 'CONFLICT');
    expect(store.redo()).toBe(true); expect(queryTransitions(store)[0]!.transition.durationFrames).toBe(6);
    removeTransition(store, transition.id); expect(removeClip(store, left.id)).toBe(true);
  });
  it('refuses existing and later participating animations or enabled fades without changing state', () => {
    const { store, left, right } = setup(); setKeyframe(store, left.id, 'x', .2, .3);
    refuse(store, () => add(store, left.id, right.id), 'UNSUPPORTED'); store.undo(); const transition = add(store, left.id, right.id);
    refuse(store, () => setKeyframe(store, right.id, 'opacity', .2, .5), 'UNSUPPORTED');
    refuse(store, () => addEffect(store, left.id, 'video_fade', { direction: 'in', start: 0, duration: .5 }), 'UNSUPPORTED');
    expect(queryTransitions(store)[0]!.transition).toBe(transition);
  });
  it('refuses mixed video frame rates before history and permits image dissolves and independent audio exemptions', () => {
    const { store: seed, left, right } = setup();
    const project: Project = { ...seed.project, timeline: { ...seed.project.timeline, fps: 30 } };
    const mixed = new EditorStore(project);
    refuse(mixed, () => add(mixed, left.id, right.id), 'UNSUPPORTED');
    expect(mixed.project.timeline.transitions).toBeUndefined();
    const images = new EditorStore({ ...project, media: project.media.map((asset) => ({ ...asset, kind: 'image', fps: 0, hasAudio: false, sampleRate: null, audioCodec: null })) });
    expect(add(images, left.id, right.id).durationFrames).toBe(5);
    const audio = new EditorStore({ ...project, timeline: { ...project.timeline, tracks: project.timeline.tracks.map((track) => ({ ...track, kind: 'audio' })) } });
    expect(addTransition(audio, { leftClipId: left.id, rightClipId: right.id, type: 'audio_crossfade', durationFrames: 5 }).type).toBe('audio_crossfade');
  });
  it('strictly validates CRUD/filter inputs and does not synthesize legacy transition arrays', () => {
    const { store, left, right } = setup(), state = store.state;
    expect(queryTransitions(store)).toEqual([]); expect(store.state).toBe(state); expect(store.project.timeline.transitions).toBeUndefined();
    for (const opts of [{ durationFrames: 1 }, { durationFrames: 2.5 }, { durationFrames: NaN }, { durationFrames: 26 }, { alignment: 'wipe' }, { type: 'wipe' }, { leftClipId: 'absent' }, { rightClipId: left.id }, { extra: true }])
      refuse(store, () => addTransition(store, { leftClipId: left.id, rightClipId: right.id, type: 'dissolve', durationFrames: 5, ...opts } as any));
    const transition = add(store, left.id, right.id);
    refuse(store, () => add(store, left.id, right.id), 'INVALID_ARGUMENT');
    for (const opts of [null, [], { durationFrames: null }, { alignment: null }, { type: 'audio_crossfade' }]) refuse(store, () => updateTransition(store, transition.id, opts as any));
    for (const opts of [null, [], { trackId: null }, { clipId: 'absent' }, { trackId: 'absent' }, { extra: true }]) refuse(store, () => queryTransitions(store, opts as any));
    const other = addTrack(store, 'video'); expect(queryTransitions(store, { trackId: other.id })).toEqual([]);
  });
  it('refuses malformed optional extension at constructor/load/mutate/save and round-trips legacy and authored frames', async () => {
    const { store, left, right } = setup(), legacy = store.project; const transition = add(store, left.id, right.id), valid = store.project;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-transitions-'));
    try {
      const target = path.join(directory, 'project.freemier'), file = await saveProject(legacy, target);
      expect((await loadProject(target)).timeline.transitions).toBeUndefined();
      await saveProject(valid, target); expect(await loadProject(target)).toEqual(valid); const bytes = await fs.readFile(file);
      const corruptions: ((p: any) => void)[] = [(p) => p.timeline.transitions = null, (p) => p.timeline.transitions = {},
        (p) => p.timeline.transitions[0] = null, (p) => p.timeline.transitions[0].durationFrames = '5',
        (p) => p.timeline.transitions[0].durationFrames = 1.5, (p) => p.timeline.transitions[0].alignment = undefined,
        (p) => p.timeline.transitions[0].id = '', (p) => p.timeline.transitions[0].rightClipId = 'absent',
        (p) => p.timeline.transitions.push({ ...transition }),
        (p) => p.timeline.transitions = Array.from({ length: 257 }, (_, i) => ({ ...transition, id: `tr_${i}` })),
      ];
      for (const corrupt of corruptions) {
        const invalid = structuredClone(valid); corrupt(invalid);
        expect(() => new EditorStore(invalid)).toThrow(EditorError); refuse(store, () => store.load(invalid)); refuse(store, () => store.mutate('timeline', [], () => invalid));
        await expect(saveProject(invalid, target)).rejects.toBeInstanceOf(EditorError); expect(await fs.readFile(file)).toEqual(bytes);
      }
      const invalid = structuredClone(valid) as Project; (invalid.timeline.transitions![0] as any).durationFrames = 0;
      await fs.writeFile(file, JSON.stringify(invalid)); await expect(loadProject(target)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
