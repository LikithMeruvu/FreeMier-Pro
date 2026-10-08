import { EditorError, MAX_MARKERS, newId, validateMarkers, type TimelineMarker } from '@freemier/shared';
import type { EditorStore } from '../project/store.js';
import { quantize } from '../timeline/queries.js';

export type MarkerInput = Pick<TimelineMarker, 'time' | 'label'> & Partial<Pick<TimelineMarker, 'color' | 'notes'>>;
export type MarkerPatch = Partial<MarkerInput>;
function normalized(input: MarkerInput, fps: number, id: string): TimelineMarker {
  if (!Number.isFinite(input.time) || input.time < 0 || input.time > 86400) throw new EditorError('INVALID_ARGUMENT', 'Marker time must be finite within 0–86400 seconds');
  const marker = { id, time: quantize(input.time, fps), label: input.label, color: input.color ?? '#f0a35e', notes: input.notes ?? '' };
  validateMarkers([marker], fps); return marker;
}
function write(store: EditorStore, markers: readonly TimelineMarker[], id: string) {
  validateMarkers(markers, store.project.timeline.fps);
  const sorted = [...markers].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  store.mutate('timeline', [store.project.timeline.id, id], (p) => ({ ...p, timeline: { ...p.timeline, markers: sorted } }));
}
export function addMarker(store: EditorStore, input: MarkerInput): TimelineMarker {
  const markers = store.project.timeline.markers ?? [];
  if (markers.length >= MAX_MARKERS) throw new EditorError('INVALID_ARGUMENT', `Maximum ${MAX_MARKERS} markers`);
  const marker = normalized(input, store.project.timeline.fps, newId('mrk'));
  write(store, [...markers, marker], marker.id); return marker;
}
export function updateMarker(store: EditorStore, markerId: string, patch: MarkerPatch): TimelineMarker {
  const markers = store.project.timeline.markers ?? [], previous = markers.find((m) => m.id === markerId);
  if (!previous) throw new EditorError('NOT_FOUND', 'Marker not found', { markerId });
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const marker = normalized({ ...previous, ...defined }, store.project.timeline.fps, markerId);
  if (marker.time !== previous.time || marker.label !== previous.label || marker.color !== previous.color || marker.notes !== previous.notes) write(store, markers.map((m) => m.id === markerId ? marker : m), markerId);
  return marker;
}
export function removeMarker(store: EditorStore, markerId: string): void {
  const markers = store.project.timeline.markers ?? [];
  if (!markers.some((m) => m.id === markerId)) throw new EditorError('NOT_FOUND', 'Marker not found', { markerId });
  write(store, markers.filter((m) => m.id !== markerId), markerId);
}
/** Read points within [start,end); annotations stay fixed during existing clip ripple edits. */
export function listMarkers(store: EditorStore, start = 0, end = Infinity): readonly TimelineMarker[] {
  if (!Number.isFinite(start) || start < 0 || !(Number.isFinite(end) || end === Infinity) || end <= start) throw new EditorError('INVALID_ARGUMENT', 'Marker query requires a nonnegative start and later end');
  return (store.project.timeline.markers ?? []).filter((m) => m.time >= start && m.time < end).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
