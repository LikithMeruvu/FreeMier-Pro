import type { TimelineMarker } from './types.js';
import { EditorError } from './errors.js';

export const MAX_MARKERS = 4096;
/** Validate persisted markers without accepting malformed or off-grid data. */
export function validateMarkers(value: unknown, fps: number): asserts value is readonly TimelineMarker[] {
  if (!Number.isFinite(fps) || fps <= 0 || !Array.isArray(value) || value.length > MAX_MARKERS) {
    throw new EditorError('INVALID_ARGUMENT', 'Invalid marker collection or frame rate');
  }
  const ids = new Set<string>();
  for (const item of value) {
    const m = item as Partial<TimelineMarker> | null;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || m.id.length > 128 || ids.has(m.id)) {
      throw new EditorError('INVALID_ARGUMENT', 'Marker IDs must be nonempty and unique');
    }
    if (typeof m.time !== 'number' || !Number.isFinite(m.time) || m.time < 0 || m.time > 86400 || Math.abs(m.time * fps - Math.round(m.time * fps)) > 1e-5) {
      throw new EditorError('INVALID_ARGUMENT', 'Marker time must be on the sequence frame grid within 24 hours');
    }
    if (typeof m.label !== 'string' || !m.label.trim() || m.label.length > 120 || typeof m.notes !== 'string' || m.notes.length > 4096 || typeof m.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(m.color)) {
      throw new EditorError('INVALID_ARGUMENT', 'Marker requires a 1–120 character label, hex RGB color and at most 4096 note characters');
    }
    ids.add(m.id);
  }
}
