import type { Clip, MediaAsset, Project, Timeline, Track } from '@freemier/shared';
import { defaultTransform, EditorError, evaluateAnimatable, invalidArgument, newClipId, notFound, validateTransformValue } from '@freemier/shared';
import { withClips, withTrack, type EditorStore } from '../project/store.js';
import { assertLinkedDestination, assertPairEditable, linkedPairFor, linkedTransaction } from '../linked-media/operations.js';
import {
  clipAt,
  clipEnd,
  findFreeSlot, quantize,
  sortClips,
  timelineDuration,
} from '../timeline/queries.js';

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

export function assertOriginEditable(clip: Clip): void {
  if (Object.values(clip.transform).some((p) => p.keyframes.length) || clip.effects.some((e) => e.enabled && e.type.endsWith('_fade'))) {
    throw new EditorError('UNSUPPORTED', 'This edit changes the local animation origin; clear keyframes and fades before editing this boundary', { clipId: clip.id });
  }
}

export function addClip(
  store: EditorStore,
  opts: AddClipOptions & { strict?: boolean },
): Clip {
  if (opts.ripple && store.project.timeline.clipLinks?.length) {
    return linkedTransaction(store, [opts.trackId], (stage) => addClip(stage, opts));
  }
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

function trackEnd(track: Track): number {
  return track.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

export function removeClip(store: EditorStore, clipId: string, ripple = false): boolean {
  const pair = linkedPairFor(store.project.timeline, clipId);
  if (pair) {
    assertPairEditable(store, pair);
    return linkedTransaction(store, [pair.videoClipId, pair.audioClipId], (stage, links) => {
      removeClip(stage, pair.videoClipId, ripple); removeClip(stage, pair.audioClipId, ripple);
      links.splice(links.findIndex((link) => link.id === pair.id), 1);
      return true;
    });
  }
  if (ripple && store.project.timeline.clipLinks?.length) {
    if (!findClip(store.project.timeline, clipId)) return false;
    return linkedTransaction(store, [clipId], (stage) => removeClip(stage, clipId, ripple));
  }
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

export function moveClip(
  store: EditorStore,
  clipId: string,
  newStart: number,
  newTrackId?: string,
  ripple = false,
): Clip {
  const pair = linkedPairFor(store.project.timeline, clipId);
  if (pair) {
    assertPairEditable(store, pair);
    assertLinkedDestination(store, pair, clipId, newTrackId);
    return linkedTransaction(store, [pair.videoClipId, pair.audioClipId], (stage) => {
      const own = moveClip(stage, clipId, newStart, newTrackId, ripple);
      moveClip(stage, clipId === pair.videoClipId ? pair.audioClipId : pair.videoClipId, newStart, undefined, ripple);
      return own;
    });
  }
  if (ripple && store.project.timeline.clipLinks?.length) {
    return linkedTransaction(store, [clipId], (stage) => moveClip(stage, clipId, newStart, newTrackId, ripple));
  }
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

export function splitClip(store: EditorStore, clipId: string, at: number): [Clip, Clip] {
  const pair = linkedPairFor(store.project.timeline, clipId);
  if (pair) {
    assertPairEditable(store, pair);
    return linkedTransaction(store, [pair.videoClipId, pair.audioClipId], (stage, links) => {
      const video = splitClip(stage, pair.videoClipId, at), audio = splitClip(stage, pair.audioClipId, at);
      links.push({ id: `lnk_${newClipId()}`, videoClipId: video[1].id, audioClipId: audio[1].id });
      return clipId === pair.videoClipId ? video : audio;
    });
  }
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

export function trimClip(
  store: EditorStore,
  clipId: string,
  edge: 'in' | 'out',
  newTime: number,
): Clip {
  const pair = linkedPairFor(store.project.timeline, clipId);
  if (pair) {
    assertPairEditable(store, pair);
    return linkedTransaction(store, [pair.videoClipId, pair.audioClipId], (stage) => {
      const own = trimClip(stage, clipId, edge, newTime);
      trimClip(stage, clipId === pair.videoClipId ? pair.audioClipId : pair.videoClipId, edge, newTime);
      return own;
    });
  }
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

export { clipAt, clipEnd, sortClips, timelineDuration };
