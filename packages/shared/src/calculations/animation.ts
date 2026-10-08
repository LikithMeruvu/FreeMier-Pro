import { EditorError } from '../errors/index.js';
import type { AnimatableProperty, Keyframe, Transform } from '../project/types.js';

export const TRANSFORM_LIMITS = {
  x: { min: -10, max: 10, default: 0 }, y: { min: -10, max: 10, default: 0 },
  scale: { min: .01, max: 10, default: 1 }, rotation: { min: -36000, max: 36000, default: 0 },
  opacity: { min: 0, max: 1, default: 1 },
} as const;
export type TransformProperty = keyof typeof TRANSFORM_LIMITS;
export const EASINGS = ['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out'] as const;

export function validateTransformValue(property: TransformProperty, value: number): void {
  const bounds = TRANSFORM_LIMITS[property];
  if (!bounds || !Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new EditorError('INVALID_ARGUMENT', 'Transform value outside supported bounds', { property, value, bounds });
  }
}
function sortedKeys(property: AnimatableProperty): Keyframe[] {
  if (!Number.isFinite(property.value) || property.keyframes.length > 256) throw new EditorError('INVALID_ARGUMENT', 'Invalid animation property or more than 256 keyframes');
  const keys = [...property.keyframes].sort((a, b) => a.time - b.time);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (!Number.isFinite(k.time) || k.time < 0 || !Number.isFinite(k.value) || !EASINGS.includes(k.easing) || (i && keys[i - 1]!.time === k.time)) {
      throw new EditorError('INVALID_ARGUMENT', 'Invalid or duplicate animation keyframe', { keyframe: k });
    }
  }
  return keys;
}
/** Easing belongs to the preceding key; clip-local seconds, clamped outside the curve. */
export function evaluateAnimatable(property: AnimatableProperty, localTime: number): number {
  const keys = sortedKeys(property);
  if (!keys.length) return property.value;
  if (localTime <= keys[0]!.time) return keys[0]!.value;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    if (localTime < b.time) {
      let u = (localTime - a.time) / (b.time - a.time);
      if (a.easing === 'hold') u = 0;
      else if (a.easing === 'ease-in') u *= u;
      else if (a.easing === 'ease-out') u = 1 - (1 - u) ** 2;
      else if (a.easing === 'ease-in-out') u = u * u * (3 - 2 * u);
      return a.value + (b.value - a.value) * u;
    }
  }
  return keys.at(-1)!.value;
}
export function evaluateTransform(transform: Transform, localTime: number): Record<TransformProperty, number> {
  return Object.fromEntries(Object.entries(transform).map(([name, prop]) => [name, evaluateAnimatable(prop, localTime)])) as Record<TransformProperty, number>;
}
const number = (value: number) => Number(value.toFixed(8)).toString();
/** The same curve as evaluateAnimatable, expressed in FFmpeg's scalar expression language. */
export function animationExpression(property: AnimatableProperty, time = 'T'): string {
  const keys = sortedKeys(property);
  if (!keys.length) return number(property.value);
  let expression = number(keys.at(-1)!.value);
  for (let i = keys.length - 1; i > 0; i--) {
    const a = keys[i - 1]!, b = keys[i]!;
    const u = `((${time}-${number(a.time)})/${number(b.time - a.time)})`;
    const eased = a.easing === 'hold' ? '0' : a.easing === 'ease-in' ? `(${u}*${u})`
      : a.easing === 'ease-out' ? `(1-(1-${u})*(1-${u}))`
        : a.easing === 'ease-in-out' ? `(${u}*${u}*(3-2*${u}))` : u;
    expression = `if(lt(${time},${number(b.time)}),${number(a.value)}+${number(b.value - a.value)}*${eased},${expression})`;
  }
  return `if(lte(${time},${number(keys[0]!.time)}),${number(keys[0]!.value)},${expression})`;
}
