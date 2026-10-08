import { effectDescriptor, validateEffectParams } from '../calculations/effects.js';
import { EditorError } from '../errors/index.js';
import type { Effect } from '../project/types.js';

export const PRESET_MAX_BYTES = 65536;
export const PRESET_MAX_COUNT = 64;
export interface EffectPresetDocument {
  readonly format: 'freemier-effect-preset';
  readonly version: 1;
  readonly name: string;
  /** Untrusted author text, displayed as text and never evaluated. */
  readonly description: string;
  readonly author: string;
  readonly tags: readonly string[];
  readonly media: 'video' | 'audio';
  readonly effects: readonly Omit<Effect, 'id'>[];
}
export interface ImportedEffectPreset {
  readonly id: string;
  readonly sha256: string;
  readonly importedAt: number;
  readonly document: EffectPresetDocument;
}
function invalid(field: string, message: string): never {
  throw new EditorError('INVALID_ARGUMENT', 'Invalid effect preset: ' + message, { field });
}
function object(value: unknown, field: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'expected an object');
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some((key) => !keys.includes(key))) invalid(field, 'unknown field');
  return result;
}
function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || (required && !value.trim())) invalid(field, 'invalid text or length');
  return value;
}
/** Closed portable format. No script, path, vendor plugin or expression evaluation. */
export function normalizeEffectPreset(value: unknown): EffectPresetDocument {
  const p = object(value, 'preset', ['format', 'version', 'name', 'description', 'author', 'tags', 'media', 'effects']);
  if (p.format !== 'freemier-effect-preset') throw new EditorError('UNSUPPORTED', 'Expected FreeMier effect preset JSON; vendor presets require separate adapters');
  if (p.version !== 1) throw new EditorError('UNSUPPORTED', 'Unsupported effect preset version', { supported: [1] });
  const name = text(p.name, 'name', 128, true), description = text(p.description, 'description', 4096), author = text(p.author, 'author', 128);
  if (!Array.isArray(p.tags) || p.tags.length > 16) invalid('tags', 'maximum 16 tags');
  const tags = p.tags.map((tag, i) => text(tag, `tags[${i}]`, 64, true));
  if (new Set(tags).size !== tags.length) invalid('tags', 'duplicate tags');
  if (p.media !== 'video' && p.media !== 'audio') invalid('media', 'expected video or audio');
  if (!Array.isArray(p.effects) || p.effects.length < 1 || p.effects.length > 32) invalid('effects', 'expected 1–32 effects');
  const effects = p.effects.map((raw, i) => {
    const e = object(raw, `effects[${i}]`, ['type', 'enabled', 'params']);
    const type = text(e.type, `effects[${i}].type`, 128, true), descriptor = effectDescriptor(type);
    if (descriptor.media !== p.media) invalid(`effects[${i}].type`, 'effect requires a different media kind');
    if (typeof e.enabled !== 'boolean') invalid(`effects[${i}].enabled`, 'expected boolean');
    const params = object(e.params, `effects[${i}].params`);
    if (Object.keys(params).some((key) => !Object.hasOwn(descriptor.params, key))) invalid(`effects[${i}].params`, 'unknown parameter');
    for (const [key, value] of Object.entries(params)) if (typeof value !== descriptor.params[key]!.type) invalid(`effects[${i}].params.${key}`, 'incorrect parameter type');
    return { type, enabled: e.enabled, params: validateEffectParams(type, params) };
  });
  return { format: 'freemier-effect-preset', version: 1, name, description, author, tags, media: p.media, effects };
}
/** Stable field/default order; author text and effect order are part of identity. */
export function canonicalEffectPreset(document: EffectPresetDocument): string { return JSON.stringify(normalizeEffectPreset(document)); }
export function describeEffectPreset(document: EffectPresetDocument) {
  return {
    name: document.name, description: document.description, descriptionSource: 'declared-author-text', author: document.author, tags: document.tags,
    media: document.media, dependencies: [], executableCode: false,
    effects: document.effects.map((e) => ({ ...e, descriptor: effectDescriptor(e.type) })),
    compatibility: { format: document.format, version: document.version, export: 'CPU FFmpeg', application: 'ordered stack; append or replace; fresh effect IDs; one undo step', timing: 'fade times are absolute clip-local seconds, unchanged on apply', limits: ['Only the seven built-in effects', 'No transform curves, effect animation, external resources or vendor plugin binaries', 'Spatial preview approximations retain their effect-catalog labels'] },
  };
}
