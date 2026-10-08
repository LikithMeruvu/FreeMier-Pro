import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '@freemier/shared';
import {
  EditorStore, addClip, addEffect, addLinkedClip, addMediaAsset, addTrack, duplicateClip,
  findClip, linkClips, linkedPairFor, loadProject, moveClip, removeClip, removeTrack,
  rollClips, saveProject, setKeyframe, slipClip, splitClip, trimClip, unlinkClip,
  updateEffect, updateTrack, validateProject,
} from '../../src/index.js';

function fixture() {
  const store = EditorStore.create({ fps: 30 });
  addMediaAsset(store, { id: 'media_av', path: '/fake.mp4', copied: false, name: 'AV', kind: 'video', duration: 20, width: 640, height: 360, fps: 30, hasAudio: true, sampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', probedAt: 0 });
  const videoTrackId = 'trk_video_1', audioTrackId = 'trk_audio_1';
  const opts = { videoTrackId, audioTrackId, assetId: 'media_av', start: 2, duration: 3, sourceIn: 2, strict: true };
  const pair = addLinkedClip(store, opts);
  return { store, pair, opts, videoTrackId, audioTrackId };
}

function aligned(store: EditorStore) {
  validateProject(store.project);
  for (const link of store.project.timeline.clipLinks ?? []) {
    const video = findClip(store.project.timeline, link.videoClipId)!.clip, audio = findClip(store.project.timeline, link.audioClipId)!.clip;
    for (const field of ['start', 'duration', 'sourceIn', 'sourceOut'] as const) expect(audio[field]).toBe(video[field]);
  }
}

describe('linked AV atomic editing', () => {
  it('places one pair with one event/undo and leaves legacy add unlinked', () => {
    const { store, opts } = fixture(), before = store.project, events: unknown[] = [];
    store.subscribe((e) => events.push(e));
    const pair = addLinkedClip(store, { ...opts, start: 6 });
    expect(events).toHaveLength(1); expect(pair.videoClip.start).toBe(6); expect(pair.audioClip.start).toBe(6);
    expect(linkedPairFor(store.project.timeline, pair.audioClip.id)).toEqual(pair.link);
    store.undo(); expect(store.project).toEqual(before);
    const clip = addClip(store, { trackId: opts.videoTrackId, assetId: opts.assetId, start: 10, duration: 2 });
    expect(linkedPairFor(store.project.timeline, clip.id)).toBeNull();
  });

  for (const member of ['videoClip', 'audioClip'] as const) {
    it.each(['move', 'split', 'trim-in', 'trim-out', 'slip', 'duplicate', 'remove', 'roll'])('%s initiated from ' + member + ' changes both members in one event and undo', (operation) => {
      const { store, pair, opts } = fixture();
      const following = addLinkedClip(store, { ...opts, start: 5, sourceIn: 6 });
      const before = store.project, rev = store.revision, events: unknown[] = [];
      store.subscribe((e) => events.push(e));
      const id = pair[member].id;
      if (operation === 'move') expect(moveClip(store, id, 10).id).toBe(id);
      if (operation === 'split') {
        const [left, right] = splitClip(store, id, 3);
        expect(left.id).toBe(id); expect(right.start).toBe(3);
        expect(store.project.timeline.clipLinks).toHaveLength(3);
        expect(new Set(store.project.timeline.clipLinks!.map((l) => l.id)).size).toBe(3);
        expect(linkedPairFor(store.project.timeline, right.id)!.id).not.toBe(pair.link.id);
      }
      if (operation === 'trim-in') expect(trimClip(store, id, 'in', 3).sourceIn).toBe(3);
      if (operation === 'trim-out') expect(trimClip(store, id, 'out', 4).duration).toBe(2);
      if (operation === 'slip') expect(slipClip(store, id, 1).sourceIn).toBe(3);
      if (operation === 'duplicate') {
        const copy = duplicateClip(store, id, 10);
        expect(copy.id).not.toBe(id); expect(store.project.timeline.clipLinks).toHaveLength(3);
      }
      if (operation === 'remove') {
        expect(removeClip(store, id)).toBe(true);
        expect(findClip(store.project.timeline, pair.videoClip.id)).toBeNull();
        expect(findClip(store.project.timeline, pair.audioClip.id)).toBeNull();
        expect(store.project.timeline.clipLinks).toEqual([following.link]);
      }
      if (operation === 'roll') {
        const [left, right] = rollClips(store, id, following[member].id, 6);
        expect(left.duration).toBe(4); expect(right.start).toBe(6); expect(right.sourceIn).toBe(7);
      }
      aligned(store); expect(events).toHaveLength(1); expect(store.revision).toBe(rev + 1);
      expect(store.undo()).toBe(true); expect(store.project).toEqual(before);
      expect(store.redo()).toBe(true); aligned(store);
    });
  }

  it('refuses every grouped operation when the other member is locked', () => {
    const { store, pair, opts, audioTrackId } = fixture();
    const next = addLinkedClip(store, { ...opts, start: 5, sourceIn: 6 });
    updateTrack(store, audioTrackId, { locked: true });
    const before = store.project, rev = store.revision, events: unknown[] = [];
    store.subscribe((e) => events.push(e));
    const edits = [() => moveClip(store, pair.videoClip.id, 10), () => splitClip(store, pair.videoClip.id, 3), () => trimClip(store, pair.videoClip.id, 'out', 4), () => slipClip(store, pair.videoClip.id, 1), () => duplicateClip(store, pair.videoClip.id, 10), () => removeClip(store, pair.videoClip.id), () => rollClips(store, pair.videoClip.id, next.videoClip.id, 6), () => unlinkClip(store, pair.videoClip.id), () => addLinkedClip(store, { ...opts, start: 10 })];
    for (const edit of edits) expect(edit).toThrow(/locked/i);
    expect(store.project).toBe(before); expect(store.revision).toBe(rev); expect(events).toHaveLength(0);
  });

  it('rolls back video staging when its audio member overlaps or exceeds source handles', () => {
    const { store, pair, opts } = fixture();
    addClip(store, { trackId: opts.audioTrackId, assetId: opts.assetId, start: 10, duration: 2, strict: true });
    const before = store.project, rev = store.revision;
    for (const edit of [() => moveClip(store, pair.videoClip.id, 10), () => duplicateClip(store, pair.videoClip.id, 10), () => trimClip(store, pair.videoClip.id, 'out', 12), () => slipClip(store, pair.audioClip.id, -3), () => slipClip(store, pair.videoClip.id, 16)]) expect(edit).toThrow();
    expect(store.project).toBe(before); expect(store.revision).toBe(rev);
  });

  it('keeps the animation-origin refusal when only the paired audio member is animated', () => {
    const { store, pair, opts } = fixture();
    const next = addLinkedClip(store, { ...opts, start: 5, sourceIn: 6 });
    setKeyframe(store, pair.audioClip.id, 'x', 1, .2); setKeyframe(store, next.audioClip.id, 'x', 1, .2);
    const before = store.project;
    for (const edit of [() => splitClip(store, pair.videoClip.id, 3), () => trimClip(store, pair.videoClip.id, 'in', 3), () => rollClips(store, pair.videoClip.id, next.videoClip.id, 6)]) expect(edit).toThrow(/animation origin/i);
    expect(store.project).toBe(before);
  });

  it('duplicates independent effects and animation for each member', () => {
    const { store, pair } = fixture();
    const videoEffect = addEffect(store, pair.videoClip.id, 'sepia', { amount: .3 });
    const audioEffect = addEffect(store, pair.audioClip.id, 'audio_fade', { duration: 1 });
    setKeyframe(store, pair.videoClip.id, 'x', 1, .2);
    const copy = duplicateClip(store, pair.audioClip.id, 10);
    const link = linkedPairFor(store.project.timeline, copy.id)!;
    updateEffect(store, link.videoClipId, videoEffect.id, { amount: .8 });
    updateEffect(store, link.audioClipId, audioEffect.id, { duration: .5 });
    setKeyframe(store, link.videoClipId, 'x', 1, -.3);
    expect(findClip(store.project.timeline, pair.videoClip.id)!.clip.effects[0]!.params.amount).toBe(.3);
    expect(findClip(store.project.timeline, pair.audioClip.id)!.clip.effects[0]!.params.duration).toBe(1);
    expect(findClip(store.project.timeline, pair.videoClip.id)!.clip.transform.x.keyframes[0]!.value).toBe(.2);
    aligned(store);
  });

  it('finds a common free slot across both tracks and strict placement refuses either collision', () => {
    const { store, opts } = fixture();
    addClip(store, { trackId: opts.audioTrackId, assetId: opts.assetId, start: 5, duration: 3, strict: true });
    addClip(store, { trackId: opts.videoTrackId, assetId: opts.assetId, start: 8, duration: 3, strict: true });
    const before = store.project;
    expect(() => addLinkedClip(store, { ...opts, start: 5 })).toThrow(/overlap/i); expect(store.project).toBe(before);
    const pair = addLinkedClip(store, { ...opts, start: 2, strict: false });
    expect(pair.videoClip.start).toBe(11); expect(pair.audioClip.start).toBe(11); aligned(store);
  });

  it('supports mirrored ripple insertion, delete and move without downstream link drift', () => {
    const { store, opts, pair } = fixture();
    const next = addLinkedClip(store, { ...opts, start: 5, sourceIn: 6 });
    const inserted = addLinkedClip(store, { ...opts, start: 2, ripple: true, duration: 1 });
    expect(findClip(store.project.timeline, pair.videoClip.id)!.clip.start).toBe(3);
    expect(findClip(store.project.timeline, next.audioClip.id)!.clip.start).toBe(6); aligned(store);
    removeClip(store, inserted.audioClip.id, true);
    expect(findClip(store.project.timeline, pair.audioClip.id)!.clip.start).toBe(2); aligned(store);
    moveClip(store, pair.audioClip.id, 8, undefined, true);
    expect(findClip(store.project.timeline, next.videoClip.id)!.clip.start).toBe(2); aligned(store);
  });

  it('refuses unsupported ripple propagation into other paired tracks and partial linked rolls', () => {
    const { store, pair, opts } = fixture();
    const otherAudio = addTrack(store, 'audio');
    const downstream = addLinkedClip(store, { ...opts, audioTrackId: otherAudio.id, start: 5 });
    const before = store.project, rev = store.revision;
    for (const edit of [() => removeClip(store, pair.audioClip.id, true), () => moveClip(store, pair.videoClip.id, 10, undefined, true), () => addLinkedClip(store, { ...opts, start: 2, duration: 1, ripple: true }), () => addClip(store, { trackId: opts.videoTrackId, assetId: opts.assetId, start: 2, duration: 1, ripple: true })]) expect(edit).toThrow(/mirrored/i);
    expect(store.project).toBe(before); expect(store.revision).toBe(rev);
    unlinkClip(store, downstream.videoClip.id);
    const unlinkedBefore = store.project;
    expect(() => rollClips(store, pair.videoClip.id, downstream.videoClip.id, 6)).toThrow(/corresponding/i);
    expect(store.project).toBe(unlinkedBefore);
  });

  it('refuses ripple toward a downstream linked member whose partner track is locked', () => {
    const { store, pair, opts } = fixture();
    const otherAudio = addTrack(store, 'audio');
    addLinkedClip(store, { ...opts, audioTrackId: otherAudio.id, start: 5 });
    updateTrack(store, otherAudio.id, { locked: true });
    const before = store.project, rev = store.revision, events: unknown[] = [];
    store.subscribe((e) => events.push(e));
    expect(() => removeClip(store, pair.audioClip.id, true)).toThrow();
    expect(() => moveClip(store, pair.videoClip.id, 10, undefined, true)).toThrow();
    expect(() => addLinkedClip(store, { ...opts, start: 2, duration: 1, ripple: true })).toThrow();
    expect(store.project).toBe(before); expect(store.revision).toBe(rev); expect(events).toHaveLength(0);
  });

  it('refuses legacy unlinked ripple deletion/move that would shift only one downstream member', () => {
    const { store, pair, opts } = fixture();
    const videoOnly = addClip(store, { trackId: opts.videoTrackId, assetId: opts.assetId, start: 0, duration: 1, strict: true });
    const before = store.project, rev = store.revision;
    expect(() => removeClip(store, videoOnly.id, true)).toThrow(/mirrored/i);
    expect(() => moveClip(store, videoOnly.id, 10, undefined, true)).toThrow(/mirrored/i);
    expect(store.project).toBe(before); expect(store.revision).toBe(rev);
    expect(findClip(store.project.timeline, pair.audioClip.id)!.clip.start).toBe(2);
  });

  it('refuses a paired ripple insertion inside either existing member without partial placement', () => {
    const { store, opts } = fixture(), before = store.project, rev = store.revision;
    expect(() => addLinkedClip(store, { ...opts, start: 3, duration: 1, ripple: true })).toThrow(/boundary/i);
    expect(store.project).toBe(before); expect(store.revision).toBe(rev);
  });

  it('keeps one event and one undo step for paired ripple insertion and audio-initiated deletion', () => {
    const { store, pair, opts } = fixture();
    addLinkedClip(store, { ...opts, start: 5 });
    let before = store.project;
    const events: unknown[] = []; store.subscribe((e) => events.push(e));
    addLinkedClip(store, { ...opts, start: 2, duration: 1, ripple: true });
    expect(events).toHaveLength(1); aligned(store); store.undo(); expect(store.project).toEqual(before);
    events.length = 0; before = store.project;
    removeClip(store, pair.audioClip.id, true);
    expect(events).toHaveLength(1); aligned(store); store.undo(); expect(store.project).toEqual(before);
  });

  it('refuses cross-kind paired move/duplicate and track removal, supports same-kind relocation', () => {
    const { store, pair, audioTrackId, videoTrackId } = fixture();
    const before = store.project;
    expect(() => moveClip(store, pair.videoClip.id, 10, audioTrackId)).toThrow(/pair requires/i);
    expect(() => duplicateClip(store, pair.audioClip.id, 10, videoTrackId)).toThrow(/pair requires/i);
    expect(() => removeTrack(store, audioTrackId)).toThrow(/linked/i); expect(store.project).toBe(before);
    const track = addTrack(store, 'audio'); moveClip(store, pair.audioClip.id, 10, track.id);
    expect(findClip(store.project.timeline, pair.audioClip.id)!.track.id).toBe(track.id); aligned(store);
  });

  it('links/unlinks existing aligned clips with one undo, rejects invalid/repeated membership', () => {
    const { store, pair } = fixture();
    const before = store.project; expect(unlinkClip(store, pair.audioClip.id)).toBe(true);
    expect(store.project.timeline.clipLinks).toEqual([]); store.undo(); expect(store.project).toEqual(before); store.redo();
    const unlinked = store.project; const linked = linkClips(store, pair.videoClip.id, pair.audioClip.id);
    expect(linked.audioClip.id).toBe(pair.audioClip.id);
    expect(() => linkClips(store, pair.videoClip.id, pair.audioClip.id)).toThrow(/already/i);
    store.undo(); expect(store.project).toEqual(unlinked);
    moveClip(store, pair.audioClip.id, 10); const shifted = store.project;
    expect(() => linkClips(store, pair.videoClip.id, pair.audioClip.id)).toThrow(/timing/i); expect(store.project).toBe(shifted);
    expect(unlinkClip(store, 'absent')).toBe(false);
  });

  it('loads legacy unchanged and rejects malformed links before history or state changes', () => {
    const { store, pair } = fixture();
    const { clipLinks: _links, ...timeline } = store.project.timeline;
    const legacy = { ...store.project, timeline }; expect(new EditorStore(legacy).project).toBe(legacy);
    const bad: unknown[] = [null, [{ ...pair.link, id: '' }], [{ ...pair.link, audioClipId: 'missing' }], [pair.link, { ...pair.link, id: 'duplicate-members' }], [{ ...pair.link, videoClipId: pair.audioClip.id, audioClipId: pair.videoClip.id }]];
    const before = store.project, rev = store.revision, canUndo = store.canUndo;
    for (const clipLinks of bad) {
      const malformed = { ...before, timeline: { ...before.timeline, clipLinks } } as Project;
      expect(() => store.load(malformed)).toThrow(/timeline.clipLinks/);
      expect(store.project).toBe(before); expect(store.revision).toBe(rev); expect(store.canUndo).toBe(canUndo);
    }
    const wrongAsset = { ...before, media: before.media.map((asset) => ({ ...asset, hasAudio: false })) };
    expect(() => store.load(wrongAsset)).toThrow(/audio-bearing/i);
  });

  it('roundtrips split/slipped/trimmed pairs and link undo/redo through schema-1 persistence', async () => {
    const { store, pair } = fixture();
    trimClip(store, pair.audioClip.id, 'in', 3); slipClip(store, pair.videoClip.id, 1);
    const [, right] = splitClip(store, pair.audioClip.id, 4); unlinkClip(store, right.id); store.undo(); aligned(store);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-linked-'));
    try {
      const file = await saveProject(store.project, path.join(folder, 'linked'));
      const reopened = new EditorStore(await loadProject(path.dirname(file)));
      expect(reopened.project).toEqual(store.project); expect(reopened.project.version).toBe(1); aligned(reopened);
      expect(removeClip(reopened, right.id)).toBe(true); aligned(reopened);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
});
