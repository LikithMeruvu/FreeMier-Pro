import { EditorError } from '../errors/index.js';
import type { Effect } from '../project/types.js';

export interface EffectParameter {
  type: 'number' | 'string'; default: number | string; min?: number; max?: number; choices?: readonly string[];
}
export interface EffectDescriptor {
  type: string; name: string; description: string; media: 'video' | 'audio'; params: Record<string, EffectParameter>;
  export: 'cpu'; preview: 'css-approximate' | 'envelope' | 'pixel-processing-required';
}
const numeric = (value: number, min: number, max: number): EffectParameter => ({ type: 'number', default: value, min, max });
const fade = { direction: { type: 'string', default: 'in', choices: ['in', 'out'] } as EffectParameter, start: numeric(0, 0, 86400), duration: numeric(1, 1 / 240, 3600) };
export const EFFECT_CATALOG: readonly EffectDescriptor[] = [
  { type: 'color_adjust', name: 'Color adjustment', description: 'Offset brightness, contrast around mid-gray, inverse gamma, then Rec.709 RGB saturation. Values clamp to the supported normalized range.', media: 'video', params: { brightness: numeric(0, -1, 1), contrast: numeric(1, 0, 2), saturation: numeric(1, 0, 3), gamma: numeric(1, .1, 10) }, export: 'cpu', preview: 'pixel-processing-required' },
  { type: 'grayscale', name: 'Grayscale', description: 'Replace RGB with weighted Rec.709 luma while retaining alpha.', media: 'video', params: {}, export: 'cpu', preview: 'pixel-processing-required' },
  { type: 'sepia', name: 'Sepia', description: 'Mix original RGB with a fixed golden sepia matrix; amount 0 preserves original and 1 applies the full matrix.', media: 'video', params: { amount: numeric(1, 0, 1) }, export: 'cpu', preview: 'pixel-processing-required' },
  { type: 'blur', name: 'Gaussian blur', description: 'Spatial Gaussian softening with radius in output pixels. Live browser preview is an approximation of the CPU filter.', media: 'video', params: { radius: numeric(3, 0, 20) }, export: 'cpu', preview: 'css-approximate' },
  { type: 'sharpen', name: 'Sharpen', description: 'CPU spatial unsharp processing with bounded amount. Live browser spatial processing does not establish identical exported pixels.', media: 'video', params: { amount: numeric(.5, 0, 2) }, export: 'cpu', preview: 'pixel-processing-required' },
  { type: 'video_fade', name: 'Video fade', description: 'Linear alpha envelope from clip-local start over duration seconds. Direction in raises alpha; out lowers alpha.', media: 'video', params: fade, export: 'cpu', preview: 'envelope' },
  { type: 'audio_fade', name: 'Audio fade', description: 'Linear audio gain envelope from clip-local start over duration seconds. Direction in raises gain; out lowers gain.', media: 'audio', params: fade, export: 'cpu', preview: 'envelope' },
];
export function effectDescriptor(type: string): EffectDescriptor {
  const descriptor = EFFECT_CATALOG.find((e) => e.type === type);
  if (!descriptor) throw new EditorError('UNSUPPORTED', `Unsupported effect: ${type}`, { type, supported: EFFECT_CATALOG.map((e) => e.type) });
  return descriptor;
}
export function validateEffectParams(type: string, params: Readonly<Record<string, unknown>> = {}): Record<string, number | string> {
  const definition = effectDescriptor(type), result: Record<string, number | string> = {};
  for (const key of Object.keys(params)) if (!(key in definition.params)) throw new EditorError('INVALID_ARGUMENT', 'Unknown effect parameter', { type, key });
  for (const [key, schema] of Object.entries(definition.params)) {
    const value = params[key] ?? schema.default;
    if (schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) || value < schema.min! || value > schema.max!
      : typeof value !== 'string' || !schema.choices?.includes(value)) {
      throw new EditorError('INVALID_ARGUMENT', 'Effect parameter outside supported bounds', { type, key, value, schema });
    }
    result[key] = value as number | string;
  }
  return result;
}
/** Fades use clip-local seconds. Used by browser alpha/gain and FFmpeg fade filters. */
export function fadeEnvelope(effect: Effect, localTime: number): number {
  const p = validateEffectParams(effect.type, effect.params);
  const progress = Math.min(1, Math.max(0, (localTime - Number(p.start)) / Number(p.duration)));
  return p.direction === 'out' ? 1 - progress : progress;
}

/** RGB in 0..255. Mirrors the export compiler; alpha is handled separately. */
export function applyColorEffect(rgb: readonly number[], type: string, params: Readonly<Record<string, unknown>> = {}): [number, number, number] {
  return createColorProcessor(type, params)(rgb);
}
/** Validate once per frame/stack; returned processor mirrors export RGB math. */
export function createColorProcessor(type: string, params: Readonly<Record<string, unknown>> = {}): (rgb: readonly number[]) => [number, number, number] {
  const p = validateEffectParams(type, params), clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (!['color_adjust', 'grayscale', 'sepia'].includes(type)) throw new EditorError('UNSUPPORTED', 'This effect requires spatial processing or a fade envelope', { type });
  return (rgb) => {
    const [r, g, b] = rgb as readonly [number, number, number];
    if (type === 'color_adjust') {
      // Offset brightness, center contrast, inverse gamma, then Rec.709 saturation.
      const values = [r, g, b].map((v) => Math.pow(clamp((v / 255 - .5) * Number(p.contrast) + .5 + Number(p.brightness)), 1 / Number(p.gamma)));
      const luma = .2126 * values[0]! + .7152 * values[1]! + .0722 * values[2]!;
      return values.map((v) => 255 * clamp(luma + (v - luma) * Number(p.saturation))) as [number, number, number];
    }
    if (type === 'grayscale') { const luma = .2126 * r + .7152 * g + .0722 * b; return [luma, luma, luma]; }
    if (type === 'sepia') {
      const amount = Number(p.amount), matrix = [[.393, .769, .189], [.349, .686, .168], [.272, .534, .131]];
      return matrix.map((row, i) => 255 * clamp(((1 - amount) * rgb[i]! + amount * (row[0]! * r + row[1]! * g + row[2]! * b)) / 255)) as [number, number, number];
    }
    throw new EditorError('UNSUPPORTED', 'Unsupported pixel effect', { type });
  };
}
