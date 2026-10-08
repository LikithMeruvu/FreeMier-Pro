import type { Clip, Keyframe } from '@freemier/shared';
import { EASINGS, EditorError, type TransformProperty, validateTransformValue } from '@freemier/shared';
import { editable, finite } from '../clips/guards.js';
import { updateClip } from '../clips/operations.js';
import { type EditorStore } from '../project/store.js';
import { quantize } from '../timeline/queries.js';

export function setKeyframe(store: EditorStore, clipId: string, property: TransformProperty, time: number, value: number, easing: Keyframe['easing'] = 'linear'): Clip {
  const { clip } = editable(store, clipId); finite(time, 'time'); validateTransformValue(property, value);
  const localTime = quantize(time, store.project.timeline.fps);
  if (time < 0 || localTime > clip.duration + 1e-6 || !EASINGS.includes(easing)) throw new EditorError('INVALID_ARGUMENT', 'Keyframe must be inside clip-local duration with a supported easing', { time, duration: clip.duration });
  const curve = clip.transform[property];
  const keys = [...curve.keyframes.filter((k) => Math.abs(k.time - localTime) > 1e-6), { time: localTime, value, easing }].sort((a, b) => a.time - b.time);
  if (keys.length > 256) throw new EditorError('INVALID_ARGUMENT', 'Maximum 256 keyframes per property');
  return updateClip(store, clipId, { transform: { ...clip.transform, [property]: { ...curve, keyframes: keys } } });
}

export function removeKeyframe(store: EditorStore, clipId: string, property: TransformProperty, time: number): Clip {
  const { clip } = editable(store, clipId); finite(time, 'time'); validateTransformValue(property, clip.transform[property]?.value);
  const localTime = quantize(time, store.project.timeline.fps), curve = clip.transform[property];
  if (!curve.keyframes.some((k) => Math.abs(k.time - localTime) < 1e-6)) throw new EditorError('NOT_FOUND', 'Keyframe not found', { property, time: localTime });
  return updateClip(store, clipId, { transform: { ...clip.transform, [property]: { ...curve, keyframes: curve.keyframes.filter((k) => Math.abs(k.time - localTime) >= 1e-6) } } });
}
