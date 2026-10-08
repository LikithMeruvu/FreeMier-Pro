import { describe, it, expect } from 'vitest';
import type { MediaAsset } from '@freemier/shared';
import { EditorStore, createEmptyProject } from '../../src/project/store.js';
import {
  addClip, removeClip, moveClip, splitClip, trimClip, addTrack, removeTrack,
  updateClip, addMediaAsset, inspectTimeline, findClip,
} from '../../src/index.js';
import { assertNoOverlap, timelineDuration, gaps, clipAt } from '../../src/timeline/queries.js';
import { saveProject, loadProject } from '../../src/project/persistence.js';
import { newMediaId } from '@freemier/shared';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Build a synthetic 60s video asset without touching the filesystem. */
function fakeAsset(duration = 60): MediaAsset {
  return {
    id: newMediaId(),
    path: '/fake/clip.mp4',
    copied: false,
    name: 'clip.mp4',
    kind: 'video',
    duration,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    sampleRate: 48000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    probedAt: Date.now(),
  };
}

const videoTrackId = (s: EditorStore) =>
  s.project.timeline.tracks.find((t) => t.kind === 'video')!.id;

describe('store', () => {
  it('creates a project with one audio and one video track', () => {
    const store = EditorStore.create({ name: 'T' });
    expect(store.project.timeline.tracks).toHaveLength(2);
    expect(store.project.timeline.tracks.map((t) => t.kind).sort()).toEqual(['audio', 'video']);
  });

  it('bumps revision and emits on mutation', () => {
    const store = EditorStore.create();
    const seen: number[] = [];
    store.subscribe((e) => seen.push(e.revision));
    const asset = fakeAsset();
    addMediaAsset(store, asset);
    expect(store.revision).toBe(1);
    expect(seen).toEqual([1]);
  });

  it('undo restores the exact prior state', () => {
    const store = EditorStore.create();
    const before = store.project;
    addMediaAsset(store, fakeAsset());
    expect(store.project).not.toEqual(before);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.project).toEqual(before);
  });

  it('redo re-applies the mutation', () => {
    const store = EditorStore.create();
    addMediaAsset(store, fakeAsset());
    const after = store.project;
    store.undo();
    expect(store.canRedo).toBe(true);
    store.redo();
    expect(store.project).toEqual(after);
  });

  it('does not pollute undo when a mutation is a no-op', () => {
    const store = EditorStore.create();
    store.mutate('project', [], (p) => p);
    expect(store.canUndo).toBe(false);
  });

  it('a throwing listener does not break the mutation', () => {
    const store = EditorStore.create();
    store.subscribe(() => { throw new Error('boom'); });
    expect(() => addMediaAsset(store, fakeAsset())).not.toThrow();
    expect(store.revision).toBe(1);
  });
});

describe('addClip', () => {
  it('adds a clip at time zero by default and keeps the track valid', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const clip = addClip(store, { trackId: videoTrackId(store), assetId: asset.id, duration: 5 });
    expect(clip.start).toBe(0);
    expect(clip.duration).toBe(5);
    assertNoOverlap(store.project.timeline.tracks.find((t) => t.kind === 'video')!);
  });

  it('pushes a colliding clip to the next free slot', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    const second = addClip(store, { trackId: tid, assetId: asset.id, start: 2, duration: 5 });
    expect(second.start).toBe(5);
    assertNoOverlap(store.project.timeline.tracks.find((t) => t.kind === 'video')!);
  });

  it('throws when strict and overlapping', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    expect(() =>
      addClip(store, { trackId: tid, assetId: asset.id, start: 2, duration: 5, strict: true }),
    ).toThrowError(/overlaps/i);
  });

  it('rejects a clip longer than the source media', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(3));
    const clip = addClip(store, { trackId: videoTrackId(store), assetId: asset.id, duration: 999 });
    expect(clip.duration).toBe(3);
  });

  it('rejects an unknown asset', () => {
    const store = EditorStore.create();
    expect(() => addClip(store, { trackId: videoTrackId(store), assetId: 'nope' })).toThrowError(/not found/i);
  });
});

describe('removeClip', () => {
  it('removes without ripple, leaving a gap', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    const b = addClip(store, { trackId: tid, assetId: asset.id, start: 5, duration: 5 });
    removeClip(store, a.id, false);
    const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!;
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]!.id).toBe(b.id);
    expect(track.clips[0]!.start).toBe(5);
    expect(gaps(track, 10)).toContainEqual({ start: 0, end: 5 });
  });

  it('removes with ripple, closing the gap', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    addClip(store, { trackId: tid, assetId: asset.id, start: 5, duration: 5 });
    removeClip(store, a.id, true);
    const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!;
    expect(track.clips[0]!.start).toBe(0);
    assertNoOverlap(track);
  });

  it('returns false for an unknown clip', () => {
    const store = EditorStore.create();
    expect(removeClip(store, 'nope')).toBe(false);
  });
});

describe('moveClip', () => {
  it('moves a clip to a free position', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    const moved = moveClip(store, a.id, 20);
    expect(moved.start).toBe(20);
  });

  it('refuses to move onto an occupied range', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    addClip(store, { trackId: tid, assetId: asset.id, start: 10, duration: 5 });
    expect(() => moveClip(store, a.id, 11)).toThrowError(/occupied/i);
  });

  it('moves a clip across tracks', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const v1 = videoTrackId(store);
    const v2 = addTrack(store, 'video', 'V2');
    const a = addClip(store, { trackId: v1, assetId: asset.id, start: 0, duration: 5 });
    moveClip(store, a.id, 0, v2.id);
    const t1 = store.project.timeline.tracks.find((t) => t.id === v1)!;
    const t2 = store.project.timeline.tracks.find((t) => t.id === v2.id)!;
    expect(t1.clips).toHaveLength(0);
    expect(t2.clips).toHaveLength(1);
  });
});

describe('splitClip', () => {
  it('splits into two abutting clips with correct source windows', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 10 });
    const [first, second] = splitClip(store, a.id, 4);
    expect(first.start).toBe(0);
    expect(first.duration).toBe(4);
    expect(second.start).toBe(4);
    expect(second.duration).toBe(6);
    expect(first.sourceOut).toBeCloseTo(second.sourceIn, 6);
    expect(timelineDuration(store.project.timeline)).toBeCloseTo(10, 6);
  });

  it('rejects a split outside the clip', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 10 });
    expect(() => splitClip(store, a.id, 0)).toThrowError(/strictly inside/i);
    expect(() => splitClip(store, a.id, 99)).toThrowError(/strictly inside/i);
  });
});

describe('trimClip', () => {
  it('trims the out point and shrinks duration', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 10 });
    const t = trimClip(store, a.id, 'out', 6);
    expect(t.duration).toBe(6);
    expect(t.sourceOut).toBe(6);
  });

  it('trims the in point and moves start', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 10 });
    const t = trimClip(store, a.id, 'in', 3);
    expect(t.start).toBe(3);
    expect(t.duration).toBe(7);
    expect(t.sourceIn).toBe(3);
  });

  it('never trims beyond the source media', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(8));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 8 });
    const t = trimClip(store, a.id, 'out', 100);
    expect(t.duration).toBe(8);
  });

  it('refuses a trim that would collide with a neighbour', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    addClip(store, { trackId: tid, assetId: asset.id, start: 5, duration: 5 });
    expect(() => trimClip(store, a.id, 'out', 8)).toThrowError(/overlap/i);
  });
});

describe('tracks', () => {
  it('adds and removes a track', () => {
    const store = EditorStore.create();
    const t = addTrack(store, 'video', 'V9');
    expect(store.project.timeline.tracks).toHaveLength(3);
    expect(t.name).toBe('V9');
    removeTrack(store, t.id);
    expect(store.project.timeline.tracks).toHaveLength(2);
  });

  it('refuses to remove the last track', () => {
    const store = EditorStore.create();
    const tracks = store.project.timeline.tracks;
    removeTrack(store, tracks[0]!.id);
    expect(() => removeTrack(store, tracks[1]!.id)).toThrowError(/last track/i);
  });

  it('refuses to edit a locked track', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    store.mutate('track', [tid], (p) => ({
      ...p,
      timeline: {
        ...p.timeline,
        tracks: p.timeline.tracks.map((t) => (t.id === tid ? { ...t, locked: true } : t)),
      },
    }));
    expect(() => addClip(store, { trackId: tid, assetId: asset.id })).toThrowError(/locked/i);
  });
});

describe('queries', () => {
  it('reports the clip at a time and the timeline duration', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    addClip(store, { trackId: tid, assetId: asset.id, start: 5, duration: 5 });
    const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!;
    expect(clipAt(track, 7)?.start).toBe(5);
    expect(timelineDuration(store.project.timeline)).toBeCloseTo(10, 6);
  });

  it('inspectTimeline returns a serializable summary', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    addClip(store, { trackId: videoTrackId(store), assetId: asset.id, duration: 4 });
    const summary = inspectTimeline(store);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(summary.duration).toBeCloseTo(4, 6);
  });
});

describe('project persistence', () => {
  it('round-trips a project through disk without loss', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-test-'));
    const store = EditorStore.create({ name: 'RoundTrip' });
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    addClip(store, { trackId: tid, assetId: asset.id, start: 0, duration: 5 });
    addClip(store, { trackId: tid, assetId: asset.id, start: 5, duration: 5 });
    await addTrack(store, 'audio', 'A2');
    const clip = store.project.timeline.tracks.find((t) => t.id === tid)!.clips[0]!;
    updateClip(store, clip.id, {
      transform: { ...clip.transform, x: { value: .1, keyframes: [{ time: 0, value: 0, easing: 'linear' }, { time: 2, value: .3, easing: 'hold' }] } },
      effects: [{ id: 'fx_roundtrip', type: 'test', params: { amount: .5, enabled: true }, enabled: true }],
    });

    const original = store.project;
    const target = path.join(dir, 'proj');
    await saveProject(original, target);
    const loaded = await loadProject(target);

    expect(loaded).toEqual(original);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports a clear error for a missing project', async () => {
    await expect(loadProject(path.join(os.tmpdir(), 'definitely-missing-xyz'))).rejects.toThrowError(/Cannot read project/i);
  });

  it('rejects a project written by a newer schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-test-'));
    const store = EditorStore.create();
    const bad = { ...store.project, version: 999 };
    // A future document is external input; the current writer must refuse it too.
    const futureDir = path.join(dir, 'bad.freemier');
    await fs.mkdir(futureDir);
    await fs.writeFile(path.join(futureDir, 'project.json'), JSON.stringify(bad));
    await expect(saveProject(bad as never, path.join(dir, 'bad'))).rejects.toThrowError(/newer schema/i);
    await expect(loadProject(path.join(dir, 'bad'))).rejects.toThrowError(/newer schema/i);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('invariants under churn', () => {
  it('keeps tracks non-overlapping through many random-ish edits', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const ids: string[] = [];

    for (let i = 0; i < 12; i++) {
      const c = addClip(store, { trackId: tid, assetId: asset.id, duration: 2 });
      ids.push(c.id);
    }
    for (let i = 0; i < ids.length; i += 3) removeClip(store, ids[i]!, false);
    for (const id of ids.filter((_, i) => i % 3 !== 0)) {
      if (!findClip(store.project.timeline, id)) continue;
      // A collision is a legitimate refusal, not a bug: the engine must never
      // produce an overlapping track, so a rejected move is a passing outcome.
      try {
        moveClip(store, id, (id.charCodeAt(id.length - 1) % 20));
      } catch (err) {
        expect(String(err)).toMatch(/occupied|overlap/i);
      }
      // Invariant must hold after every attempt, accepted or rejected.
      assertNoOverlap(store.project.timeline.tracks.find((t) => t.kind === 'video')!);
    }

    const track = store.project.timeline.tracks.find((t) => t.kind === 'video')!;
    assertNoOverlap(track);
    expect(track.clips.length).toBeGreaterThan(0);
  });
});

describe('updateClip', () => {
  it('ripple insertion and movement are atomic, non-overlapping and undoable', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const tid = videoTrackId(store);
    const a = addClip(store, { trackId: tid, assetId: asset.id, duration: 2 });
    const b = addClip(store, { trackId: tid, assetId: asset.id, duration: 2 });
    const before = store.project;
    const inserted = addClip(store, { trackId: tid, assetId: asset.id, start: 2, duration: 1, ripple: true });
    expect(findClip(store.project.timeline, b.id)!.clip.start).toBe(3);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
    store.redo();
    const beforeMove = store.project;
    moveClip(store, b.id, 0, undefined, true);
    expect(findClip(store.project.timeline, b.id)!.clip.start).toBe(0);
    expect(findClip(store.project.timeline, a.id)!.clip.start).toBe(2);
    expect(findClip(store.project.timeline, inserted.id)!.clip.start).toBe(4);
    assertNoOverlap(store.project.timeline.tracks.find((t) => t.id === tid)!);
    store.undo();
    expect(store.project).toEqual(beforeMove);
    expect(() => addClip(store, { trackId: tid, assetId: asset.id, start: 1, duration: 1, ripple: true })).toThrow(/boundary/);
  });
  it('updates label and volume', () => {
    const store = EditorStore.create();
    const asset = addMediaAsset(store, fakeAsset(60));
    const a = addClip(store, { trackId: videoTrackId(store), assetId: asset.id, duration: 5 });
    const updated = updateClip(store, a.id, { label: 'Intro', volume: 0.5 });
    expect(updated.label).toBe('Intro');
    expect(updated.volume).toBe(0.5);
    const found = findClip(store.project.timeline, a.id)!;
    expect(found.clip.label).toBe('Intro');
  });
});
