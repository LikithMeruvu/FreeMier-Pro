import type { Clip } from '@freemier/shared';
import { updateClip } from '../clips/operations.js';
import type { EditorStore } from '../project/store.js';

/** Gain/label changes retain the existing atomic clip validation and history. */
export function setClipAudio(store: EditorStore, clipId: string, values: { volume?: number; label?: string }): Clip {
  const patch: { volume?: number; label?: string } = {};
  if (typeof values.volume === 'number') patch.volume = values.volume;
  if (typeof values.label === 'string') patch.label = values.label;
  return updateClip(store, clipId, patch);
}
