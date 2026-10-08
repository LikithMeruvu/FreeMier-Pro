import type { Clip, Track } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { type EditorStore, withClips } from '../project/store.js';
import { assertNoOverlap, sortClips } from '../timeline/queries.js';
import { findClip } from './operations.js';

export function editable(store: EditorStore, id: string) {
  const found = findClip(store.project.timeline, id);
  if (!found) throw new EditorError('NOT_FOUND', 'Clip not found', { clipId: id });
  if (found.track.locked) throw new EditorError('CONFLICT', 'Track is locked', { trackId: found.track.id });
  return found;
}

export function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new EditorError('INVALID_ARGUMENT', `${name} must be finite`);
}

export function sourceBound(store: EditorStore, clip: Clip) {
  const asset = store.project.media.find((m) => m.id === clip.assetId);
  if (!asset) throw new EditorError('NOT_FOUND', 'Media asset not found', { assetId: clip.assetId });
  if (clip.sourceIn < -1e-6 || clip.sourceOut > asset.duration + 1e-6 || clip.duration < 1 / store.project.timeline.fps - 1e-6) {
    throw new EditorError('INVALID_ARGUMENT', 'Edit exceeds source handles or minimum one-frame duration', { clipId: clip.id, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, assetDuration: asset.duration });
  }
}

export function writeTrack(store: EditorStore, track: Track, clips: Clip[], ids: string[]) {
  const next = { ...track, clips: sortClips(clips) }; assertNoOverlap(next);
  store.mutate('clip', [track.id, ...ids], (p) => ({ ...p, timeline: withClips(p.timeline, track.id, next.clips) }));
}
