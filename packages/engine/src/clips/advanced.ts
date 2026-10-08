import type { Clip } from '@freemier/shared';
import { EditorError, newClipId } from '@freemier/shared';
import { type EditorStore } from '../project/store.js';
import { clipEnd, quantize } from '../timeline/queries.js';
import { editable, finite, sourceBound, writeTrack } from './guards.js';
import { assertOriginEditable } from './operations.js';
import { assertLinkedDestination, assertPairEditable, linkedPairFor, linkedTransaction } from '../linked-media/operations.js';

export function slipClip(store: EditorStore, clipId: string, delta: number): Clip {
  const pair = linkedPairFor(store.project.timeline, clipId);
  if (pair) {
    assertPairEditable(store, pair);
    return linkedTransaction(store, [pair.videoClipId, pair.audioClipId], (stage) => {
      const own = slipClip(stage, clipId, delta);
      slipClip(stage, clipId === pair.videoClipId ? pair.audioClipId : pair.videoClipId, delta);
      return own;
    });
  }
  finite(delta, 'delta'); const { track, clip } = editable(store, clipId), fps = store.project.timeline.fps;
  const shift = quantize(delta, fps);
  const updated = { ...clip, sourceIn: quantize(clip.sourceIn + shift, fps), sourceOut: quantize(clip.sourceOut + shift, fps) };
  sourceBound(store, updated);
  writeTrack(store, track, track.clips.map((c) => c.id === clipId ? updated : c), [clipId]); return updated;
}

export function rollClips(store: EditorStore, leftClipId: string, rightClipId: string, at: number): [Clip, Clip] {
  const leftPair = linkedPairFor(store.project.timeline, leftClipId), rightPair = linkedPairFor(store.project.timeline, rightClipId);
  if (leftPair || rightPair) {
    if (!leftPair || !rightPair || leftPair.id === rightPair.id || (leftClipId === leftPair.videoClipId) !== (rightClipId === rightPair.videoClipId)) throw new EditorError('UNSUPPORTED', 'Linked rolling edit requires two corresponding adjacent pairs');
    assertPairEditable(store, leftPair); assertPairEditable(store, rightPair);
    return linkedTransaction(store, [leftPair.videoClipId, leftPair.audioClipId, rightPair.videoClipId, rightPair.audioClipId], (stage) => {
      const own = rollClips(stage, leftClipId, rightClipId, at);
      rollClips(stage, leftClipId === leftPair.videoClipId ? leftPair.audioClipId : leftPair.videoClipId, rightClipId === rightPair.videoClipId ? rightPair.audioClipId : rightPair.videoClipId, at);
      return own;
    });
  }
  finite(at, 'at'); const left = editable(store, leftClipId), right = editable(store, rightClipId), fps = store.project.timeline.fps;
  if (left.track.id !== right.track.id || Math.abs(clipEnd(left.clip) - right.clip.start) > 1e-6) throw new EditorError('CONFLICT', 'Rolling edit requires two adjacent clips on the same track');
  const boundary = quantize(at, fps), delta = boundary - right.clip.start;
  if (Math.abs(delta) > 1e-6) assertOriginEditable(right.clip);
  const a = { ...left.clip, duration: quantize(boundary - left.clip.start, fps), sourceOut: quantize(left.clip.sourceOut + delta, fps) };
  const b = { ...right.clip, start: boundary, duration: quantize(clipEnd(right.clip) - boundary, fps), sourceIn: quantize(right.clip.sourceIn + delta, fps) };
  sourceBound(store, a); sourceBound(store, b);
  writeTrack(store, left.track, left.track.clips.map((c) => c.id === a.id ? a : c.id === b.id ? b : c), [a.id, b.id]); return [a, b];
}

export function duplicateClip(store: EditorStore, clipId: string, start?: number, trackId?: string): Clip {
  const pair = linkedPairFor(store.project.timeline, clipId);
  if (pair) {
    assertPairEditable(store, pair);
    assertLinkedDestination(store, pair, clipId, trackId);
    return linkedTransaction(store, [pair.videoClipId, pair.audioClipId], (stage, links) => {
      const video = duplicateClip(stage, pair.videoClipId, start, clipId === pair.videoClipId ? trackId : undefined);
      const audio = duplicateClip(stage, pair.audioClipId, start, clipId === pair.audioClipId ? trackId : undefined);
      links.push({ id: `lnk_${newClipId()}`, videoClipId: video.id, audioClipId: audio.id });
      return clipId === pair.videoClipId ? video : audio;
    });
  }
  const found = editable(store, clipId), track = store.project.timeline.tracks.find((t) => t.id === (trackId ?? found.track.id));
  if (!track) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  if (track.locked) throw new EditorError('CONFLICT', 'Track is locked', { trackId: track.id });
  finite(start ?? clipEnd(found.clip), 'start');
  const copy = { ...structuredClone(found.clip), id: newClipId(), start: quantize(start ?? clipEnd(found.clip), store.project.timeline.fps) };
  if (copy.start < 0) throw new EditorError('INVALID_ARGUMENT', 'Start must be nonnegative');
  writeTrack(store, track, [...track.clips, copy], [copy.id]); return copy;
}
