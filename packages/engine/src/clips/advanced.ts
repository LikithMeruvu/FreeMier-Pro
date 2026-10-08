import type { Clip } from '@freemier/shared';
import { EditorError, newClipId } from '@freemier/shared';
import { type EditorStore } from '../project/store.js';
import { clipEnd, quantize } from '../timeline/queries.js';
import { editable, finite, sourceBound, writeTrack } from './guards.js';
import { assertOriginEditable } from './operations.js';

export function slipClip(store: EditorStore, clipId: string, delta: number): Clip {
  finite(delta, 'delta'); const { track, clip } = editable(store, clipId), fps = store.project.timeline.fps;
  const shift = quantize(delta, fps);
  const updated = { ...clip, sourceIn: quantize(clip.sourceIn + shift, fps), sourceOut: quantize(clip.sourceOut + shift, fps) };
  sourceBound(store, updated);
  writeTrack(store, track, track.clips.map((c) => c.id === clipId ? updated : c), [clipId]); return updated;
}

export function rollClips(store: EditorStore, leftClipId: string, rightClipId: string, at: number): [Clip, Clip] {
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
  const found = editable(store, clipId), track = store.project.timeline.tracks.find((t) => t.id === (trackId ?? found.track.id));
  if (!track) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  if (track.locked) throw new EditorError('CONFLICT', 'Track is locked', { trackId: track.id });
  finite(start ?? clipEnd(found.clip), 'start');
  const copy = { ...structuredClone(found.clip), id: newClipId(), start: quantize(start ?? clipEnd(found.clip), store.project.timeline.fps) };
  if (copy.start < 0) throw new EditorError('INVALID_ARGUMENT', 'Start must be nonnegative');
  writeTrack(store, track, [...track.clips, copy], [copy.id]); return copy;
}
