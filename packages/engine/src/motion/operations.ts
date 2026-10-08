import type { AnimatableProperty, Transform } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { findClip, updateClip } from '../clips/operations.js';
import type { EditorStore } from '../project/store.js';

/** Explicit static values replace their curves; omitted properties retain them. */
export function setClipTransformValues(store: EditorStore, clipId: string, values: Partial<Record<keyof Transform, number>>): Transform {
  const found = findClip(store.project.timeline, clipId);
  if (!found) throw new EditorError('NOT_FOUND', `Clip not found: ${clipId}`, { clipId });
  const base = found.clip.transform;
  const property = (current: AnimatableProperty, next: number | undefined): AnimatableProperty =>
    typeof next === 'number' ? { value: next, keyframes: [] } : current;
  const transform: Transform = {
    x: property(base.x, values.x), y: property(base.y, values.y),
    scale: property(base.scale, values.scale), rotation: property(base.rotation, values.rotation),
    opacity: property(base.opacity, values.opacity),
  };
  updateClip(store, clipId, { transform });
  return transform;
}
