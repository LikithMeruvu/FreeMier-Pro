import type { Track } from '@freemier/shared';
import { EditorError, newClipId } from '@freemier/shared';
import { type EditorStore } from '../project/store.js';

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

export function removeTrack(store: EditorStore, trackId: string): boolean {
  const project = store.project;
  if (!project.timeline.tracks.some((t) => t.id === trackId)) return false;
  if (project.timeline.tracks.find((track) => track.id === trackId)!.locked) throw new EditorError('CONFLICT', 'Cannot remove a locked track', { trackId });
  const clipIds = new Set(project.timeline.tracks.find((track) => track.id === trackId)!.clips.map((clip) => clip.id));
  if (project.timeline.clipLinks?.some((link) => clipIds.has(link.videoClipId) || clipIds.has(link.audioClipId))) throw new EditorError('CONFLICT', 'Unlink or remove linked clips before removing their track', { trackId });
  if (project.timeline.tracks.length <= 1) {
    throw new EditorError('CONFLICT', 'Cannot remove the last track', { trackId });
  }
  store.mutate('track', [trackId], (p) => ({
    ...p,
    timeline: { ...p.timeline, tracks: p.timeline.tracks.filter((t) => t.id !== trackId) },
  }));
  return true;
}

/** Move a track by one visible position with a single history entry. */
export function reorderTrack(store: EditorStore, trackId: string, direction: 'up' | 'down'): boolean {
  const tracks = store.project.timeline.tracks.map((track, index) => ({ track, index }))
    .sort((a, b) => b.track.order - a.track.order || b.index - a.index).map(({ track }) => track);
  const index = tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  const otherIndex = index + (direction === 'up' ? -1 : 1);
  if (otherIndex < 0 || otherIndex >= tracks.length) return false;
  const track = tracks[index]!;
  const other = tracks[otherIndex]!;
  if (track.locked || other.locked) throw new EditorError('CONFLICT', 'Unlock both tracks before reordering them', { trackId, otherTrackId: other.id });
  tracks.splice(index, 1);
  tracks.splice(otherIndex, 0, track);
  store.mutate('track', [track.id, other.id], (p) => ({ ...p, timeline: { ...p.timeline, tracks: p.timeline.tracks.map((item) => ({ ...item, order: tracks.length - 1 - tracks.findIndex((ordered) => ordered.id === item.id) })) } }));
  return true;
}
