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
  if (project.timeline.tracks.length <= 1) {
    throw new EditorError('CONFLICT', 'Cannot remove the last track', { trackId });
  }
  store.mutate('track', [trackId], (p) => ({
    ...p,
    timeline: { ...p.timeline, tracks: p.timeline.tracks.filter((t) => t.id !== trackId) },
  }));
  return true;
}
