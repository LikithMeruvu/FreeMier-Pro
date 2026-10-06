import type { Project, Timeline, Track, Clip, MediaAsset } from '@freemier/shared';
import { newClipId, notFound, invalidArgument, defaultTransform, EditorError, validateTransformValue, evaluateAnimatable } from '@freemier/shared';
import {
  sortClips, clipEnd, timelineDuration, findFreeSlot, quantize, clipAt,
} from './timeline.js';
import { withClips, withTrack, type EditorStore } from './store.js';

/**
 * Timeline editing operations.
 *
 * Every function here is a pure-ish mutation on an EditorStore: it reads the
 * current project, computes the next one, and hands it to `store.mutate`.
 * Invariants (no overlap, sorted clips) are preserved by construction.
 */

/** Options accepted when adding a clip. */
export interface AddClipOptions {
  trackId: string;
  assetId: string;
  /** Where to place it. Defaults to the end of the track. */
  start?: number;
  /** Length on the timeline. Defaults to the full remaining source. */
  duration?: number;
  sourceIn?: number;
  label?: string | null;
  /** Insert at a boundary/gap, shifting later clips right. */
  ripple?: boolean;
}

function requireTrack(project: Project, trackId: string): Track {
  const track = project.timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw notFound('Track', trackId);
  return track;
}

function requireAsset(project: Project, assetId: string): MediaAsset {
  const asset = project.media.find((m) => m.id === assetId);
  if (!asset) throw notFound('Media asset', assetId);
  return asset;
}

/** Explicitly reject edits that would otherwise restart clip-local animation. */
export function assertOriginEditable(clip: Clip): void {
  if (Object.values(clip.transform).some((p) => p.keyframes.length) || clip.effects.some((e) => e.enabled && e.type.endsWith('_fade'))) {
    throw new EditorError('UNSUPPORTED', 'This edit changes the local animation origin; clear keyframes and fades before editing this boundary', { clipId: clip.id });
  }
}

/**
 * Add a clip to a track.
 * When the requested window would overlap, the clip is pushed to the next free
 * slot rather than failing — the caller can pass `strict: true` to instead error.
 */
export function addClip(
  store: EditorStore,
  opts: AddClipOptions & { strict?: boolean },
): Clip {
  const project = store.project;
  const track = requireTrack(project, opts.trackId);
  if (track.locked) throw new EditorError('CONFLICT', `Track is locked: ${track.name}`, { trackId: track.id });
  const asset = requireAsset(project, opts.assetId);

  const fps = project.timeline.fps;
  const sourceIn = quantize(opts.sourceIn ?? 0, fps);
  const available = asset.duration - sourceIn;
  if (available <= 1e-6) {
    throw invalidArgument('No source media remains after sourceIn', {
      assetId: asset.id, assetDuration: asset.duration, sourceIn,
    });
  }
  const duration = quantize(Math.min(opts.duration ?? available, available), fps);
  if (duration <= 1e-6) throw invalidArgument('Clip duration must be positive', { duration });

  const desired = quantize(opts.start ?? trackEnd(track), fps);
  let start = desired;
  let existingClips = track.clips;

  if (opts.ripple) {
    if (track.clips.some((c) => desired > c.start + 1e-6 && desired < clipEnd(c) - 1e-6)) {
      throw invalidArgument('Ripple insert must be at a clip boundary or gap; split the clip first');
    }
    existingClips = track.clips.map((c) => c.start >= desired - 1e-6 ? { ...c, start: quantize(c.start + duration, fps) } : c);
  } else if (opts.strict) {
    const collide = track.clips.find(
      (c) => start < clipEnd(c) - 1e-6 && start + duration > c.start + 1e-6,
    );
    if (collide) {
      throw new EditorError('OVERLAP', 'Requested position overlaps an existing clip', {
        trackId: track.id, requestedStart: start, blockingClipId: collide.id,
      });
    }
  } else {
    start = findFreeSlot(track, desired, duration);
  }

  const clip: Clip = {
    id: newClipId(),
    assetId: asset.id,
    start,
    duration,
    sourceIn,
    sourceOut: quantize(sourceIn + duration, fps),
    transform: defaultTransform(),
    effects: [],
    label: opts.label ?? null,
    volume: 1,
  };

  store.mutate('clip', [clip.id, track.id], (p) => ({
    ...p,
    timeline: withClips(
      withTrack(p.timeline, { ...track, clips: sortClips([...existingClips, clip]) }),
      track.id,
      sortClips([...existingClips, clip]),
    ),
  }));

  return clip;
}

/** End of a track's last clip. */
function trackEnd(track: Track): number {
  return track.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/** Remove a clip by ID. Returns true when something was removed. */
export function removeClip(store: EditorStore, clipId: string, ripple = false): boolean {
  const project = store.project;
  for (const track of project.timeline.tracks) {
    const target = track.clips.find((c) => c.id === clipId);
    if (!target) continue;
    if (track.locked) throw new EditorError('CONFLICT', `Track is locked: ${track.name}`, { trackId: track.id });

    const remaining = track.clips.filter((c) => c.id !== clipId);
    const shifted = ripple
      ? remaining.map((c) => (c.start > target.start ? { ...c, start: quantize(c.start - target.duration, project.timeline.fps) } : c))
      : remaining;
    const clips = sortClips(shifted);

    store.mutate('clip', [clipId, track.id], (p) => ({
      ...p,
      timeline: withClips(p.timeline, track.id, clips),
    }));
    return true;
  }
  return false;
}

/** Move a clip to a new start time on its current or a different track. */
export function moveClip(
  store: EditorStore,
  clipId: string,
  newStart: number,
  newTrackId?: string,
  ripple = false,
): Clip {
  const project = store.project;
  const fps = project.timeline.fps;
  const found = findClip(project.timeline, clipId);
  if (!found) throw notFound('Clip', clipId);
  const { track: fromTrack, clip } = found;
  if (fromTrack.locked) throw new EditorError('CONFLICT', `Track is locked: ${fromTrack.name}`, { trackId: fromTrack.id });

  const toTrackId = newTrackId ?? fromTrack.id;
  const toTrack = requireTrack(project, toTrackId);
  if (toTrack.locked) throw new EditorError('CONFLICT', `Track is locked: ${toTrack.name}`, { trackId: toTrack.id });

  const start = quantize(Math.max(0, newStart), fps);
  let others = toTrack.id === fromTrack.id
    ? toTrack.clips.filter((c) => c.id !== clipId)
    : toTrack.clips;
  const sourceRemaining = fromTrack.clips.filter((c) => c.id !== clipId).map((c) =>
    ripple && c.start > clip.start ? { ...c, start: quantize(c.start - clip.duration, fps) } : c);
  if (ripple) {
    others = toTrack.id === fromTrack.id ? sourceRemaining : others;
    if (others.some((c) => start > c.start + 1e-6 && start < clipEnd(c) - 1e-6)) {
      throw invalidArgument('Ripple move must target a clip boundary or gap; split the clip first');
    }
    others = others.map((c) => c.start >= start - 1e-6 ? { ...c, start: quantize(c.start + clip.duration, fps) } : c);
  }

  const collide = others.find(
    (c) => start < clipEnd(c) - 1e-6 && start + clip.duration > c.start + 1e-6,
  );
  if (collide) {
    throw new EditorError('OVERLAP', 'Cannot move clip onto an occupied range', {
      clipId, requestedStart: start, blockingClipId: collide.id,
    });
  }

  const moved: Clip = { ...clip, start };
  store.mutate('clip', [clipId, toTrack.id, fromTrack.id], (p) => {
    let timeline = p.timeline;
    if (fromTrack.id !== toTrack.id) {
      timeline = withClips(timeline, fromTrack.id, sortClips(sourceRemaining));
      timeline = withClips(timeline, toTrack.id, sortClips([...others, moved]));
    } else {
      timeline = withClips(timeline, toTrack.id, sortClips([...others, moved]));
    }
    return { ...p, timeline };
  });

  return moved;
}

/** Split a clip at an absolute timeline time. Returns the two resulting clips. */
export function splitClip(store: EditorStore, clipId: string, at: number): [Clip, Clip] {
  const project = store.project;
  const fps = project.timeline.fps;
  const found = findClip(project.timeline, clipId);
  if (!found) throw notFound('Clip', clipId);
  const { track, clip } = found;
  if (track.locked) throw new EditorError('CONFLICT', `Track is locked: ${track.name}`, { trackId: track.id });

  const cut = quantize(at, fps);
  if (cut <= clip.start + 1e-6 || cut >= clipEnd(clip) - 1e-6) {
    throw invalidArgument('Split point must be strictly inside the clip', {
      clipId, at: cut, clipStart: clip.start, clipEnd: clipEnd(clip),
    });
  }

  const firstDuration = quantize(cut - clip.start, fps);
  assertOriginEditable(clip);
  const secondDuration = quantize(clip.duration - firstDuration, fps);
  const sourceCut = quantize(clip.sourceIn + firstDuration, fps);

  const first: Clip = { ...clip, duration: firstDuration, sourceOut: sourceCut };
  const second: Clip = {
    ...clip,
    id: newClipId(),
    start: cut,
    duration: secondDuration,
    sourceIn: sourceCut,
    sourceOut: quantize(sourceCut + secondDuration, fps),
  };

  const clips = sortClips([...track.clips.filter((c) => c.id !== clipId), first, second]);
  store.mutate('clip', [clipId, first.id, second.id, track.id], (p) => ({
    ...p,
    timeline: withClips(p.timeline, track.id, clips),
  }));

  return [first, second];
}

/** Trim a clip's in or out point, keeping the other edge fixed. */
export function trimClip(
  store: EditorStore,
  clipId: string,
  edge: 'in' | 'out',
  newTime: number,
): Clip {
  const project = store.project;
  const fps = project.timeline.fps;
  const found = findClip(project.timeline, clipId);
  if (!found) throw notFound('Clip', clipId);
  const { track, clip } = found;
  if (track.locked) throw new EditorError('CONFLICT', `Track is locked: ${track.name}`, { trackId: track.id });
  const asset = requireAsset(project, clip.assetId);

  let updated: Clip;
  if (edge === 'in') {
    // Move the left edge; keep the right edge pinned.
    const end = clipEnd(clip);
    const start = quantize(Math.max(0, Math.min(newTime, end - 1 / fps)), fps);
    const delta = quantize(start - clip.start, fps);
    if (Math.abs(delta) > 1e-6) assertOriginEditable(clip);
    const sourceIn = quantize(clip.sourceIn + delta, fps);
    if (sourceIn < 0) throw invalidArgument('Trim would run before the source start', { clipId, sourceIn });
    updated = {
      ...clip,
      start,
      duration: quantize(end - start, fps),
      sourceIn,
      sourceOut: quantize(sourceIn + (end - start), fps),
    };
  } else {
    // Move the right edge; keep the left edge pinned.
    const maxDuration = asset.duration - clip.sourceIn;
    const requested = quantize(newTime - clip.start, fps);
    const duration = quantize(Math.max(1 / fps, Math.min(requested, maxDuration)), fps);
    updated = {
      ...clip,
      duration,
      sourceOut: quantize(clip.sourceIn + duration, fps),
    };
  }

  // Never allow a trim to collide with the neighbour.
  const others = track.clips.filter((c) => c.id !== clipId);
  const collide = others.find(
    (c) => updated.start < clipEnd(c) - 1e-6 && clipEnd(updated) > c.start + 1e-6,
  );
  if (collide) {
    throw new EditorError('OVERLAP', 'Trim would overlap an adjacent clip', {
      clipId, blockingClipId: collide.id,
    });
  }

  const clips = sortClips([...others, updated]);
  store.mutate('clip', [clipId, track.id], (p) => ({
    ...p,
    timeline: withClips(p.timeline, track.id, clips),
  }));

  return updated;
}

/** Locate a clip and its owning track anywhere in the timeline. */
export function findClip(
  timeline: Timeline,
  clipId: string,
): { track: Track; clip: Clip } | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Add a track. */
export function addTrack(
  store: EditorStore,
  kind: 'video' | 'audio',
  name?: string,
): Track {
  const project = store.project;
  const sameKind = project.timeline.tracks.filter((t) => t.kind === kind).length;
  const prefix = kind === 'video' ? 'V' : 'A';
  const track: Track = {
    id: `trk_${kind}_${newClipId()}`,
    kind,
    name: name ?? `${prefix}${sameKind + 1}`,
    clips: [],
    muted: false,
    locked: false,
    order: kind === 'video' ? project.timeline.tracks.length + 1 : 0,
  };
  store.mutate('track', [track.id], (p) => ({
    ...p,
    timeline: { ...p.timeline, tracks: [...p.timeline.tracks, track] },
  }));
  return track;
}

/** Remove a track and its clips. */
export function removeTrack(store: EditorStore, trackId: string): boolean {
  const project = store.project;
  if (!project.timeline.tracks.some((t) => t.id === trackId)) return false;
  if (requireTrack(project, trackId).locked) throw new EditorError('CONFLICT', 'Cannot remove a locked track', { trackId });
  if (project.timeline.tracks.length <= 1) {
    throw new EditorError('CONFLICT', 'Cannot remove the last track', { trackId });
  }
  store.mutate('track', [trackId], (p) => ({
    ...p,
    timeline: { ...p.timeline, tracks: p.timeline.tracks.filter((t) => t.id !== trackId) },
  }));
  return true;
}

/** Update arbitrary clip fields. */
export function updateClip(
  store: EditorStore,
  clipId: string,
  patch: Partial<Pick<Clip, 'label' | 'volume' | 'transform' | 'effects'>>,
): Clip {
  const found = findClip(store.project.timeline, clipId);
  if (!found) throw notFound('Clip', clipId);
  if (found.track.locked) throw new EditorError('CONFLICT', `Track is locked: ${found.track.name}`, { trackId: found.track.id });
  if (patch.volume !== undefined && (!Number.isFinite(patch.volume) || patch.volume < 0 || patch.volume > 4)) throw invalidArgument('Volume must be between 0 and 4');
  if (patch.transform) for (const [property, curve] of Object.entries(patch.transform)) {
    evaluateAnimatable(curve, 0);
    validateTransformValue(property as keyof Clip['transform'], curve.value);
    for (const key of curve.keyframes) validateTransformValue(property as keyof Clip['transform'], key.value);
  }
  const updated: Clip = { ...found.clip, ...patch };
  store.mutate('clip', [clipId, found.track.id], (p) => ({
    ...p,
    timeline: withClips(
      p.timeline,
      found.track.id,
      sortClips(found.track.clips.map((c) => (c.id === clipId ? updated : c))),
    ),
  }));
  return updated;
}

/** Import a probed media asset into the project library. */
export function addMediaAsset(store: EditorStore, asset: MediaAsset): MediaAsset {
  store.mutate('media', [asset.id], (p) => ({ ...p, media: [...p.media, asset] }));
  return asset;
}

/** Read-only timeline summary — the shape agents ask for most. */
export function inspectTimeline(store: EditorStore): Record<string, unknown> {
  const { timeline } = store.project;
  return {
    id: timeline.id,
    name: timeline.name,
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    duration: timelineDuration(timeline),
    trackCount: timeline.tracks.length,
    tracks: timeline.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      clipCount: t.clips.length,
      duration: t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0),
      clips: sortClips(t.clips).map((c) => ({
        id: c.id,
        assetId: c.assetId,
        start: c.start,
        duration: c.duration,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        label: c.label,
      })),
    })),
  };
}

export { clipAt, timelineDuration, clipEnd, sortClips };
