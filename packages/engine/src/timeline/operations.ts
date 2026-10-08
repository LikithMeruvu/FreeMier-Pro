import type { Track } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { type EditorStore } from '../project/store.js';

export function updateTrack(store: EditorStore, trackId: string, patch: Partial<Pick<Track, 'name' | 'muted' | 'locked' | 'order'>>): Track {
  const track = store.project.timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120)) throw new EditorError('INVALID_ARGUMENT', 'Track name must contain 1–120 characters');
  if (patch.order !== undefined && (!Number.isInteger(patch.order) || patch.order < 0 || patch.order > 1024)) throw new EditorError('INVALID_ARGUMENT', 'Track order must be an integer between 0 and 1024');
  if (track.locked && patch.order !== undefined && patch.locked !== false) throw new EditorError('CONFLICT', 'Unlock the track before changing its compositing order');
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const updated = { ...track, ...defined } as Track;
  store.mutate('track', [trackId], (p) => ({ ...p, timeline: { ...p.timeline, tracks: p.timeline.tracks.map((t) => t.id === trackId ? updated : t) } })); return updated;
}
