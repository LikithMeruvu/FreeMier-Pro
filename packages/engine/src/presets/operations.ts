import { EditorError, PRESET_MAX_BYTES, PRESET_MAX_COUNT, canonicalEffectPreset, describeEffectPreset, normalizeEffectPreset, type EffectPresetDocument, type ImportedEffectPreset } from '@freemier/shared';
import { createHash } from 'node:crypto';
import { findClip } from '../clips/operations.js';
import { applyEffectStack } from '../effects/operations.js';
import type { EditorStore } from '../project/store.js';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function inspectEffectPreset(content: string) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > PRESET_MAX_BYTES) throw new EditorError('INVALID_ARGUMENT', 'Effect preset exceeds 64 KiB');
  let parsed: unknown; try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new EditorError('INVALID_ARGUMENT', 'Effect preset must be valid JSON'); }
  const document = normalizeEffectPreset(parsed), canonical = canonicalEffectPreset(document), sha256 = hash(canonical);
  return { id: 'preset_' + sha256, sha256, document, ...describeEffectPreset(document) };
}
export function validateEffectPresetLibrary(value: unknown): void {
  if (!Array.isArray(value) || value.length > PRESET_MAX_COUNT) throw new EditorError('INVALID_ARGUMENT', 'Maximum 64 imported effect presets');
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EditorError('INVALID_ARGUMENT', 'Invalid imported preset record');
    const p = raw as ImportedEffectPreset;
    const canonical = canonicalEffectPreset(p.document);
    if (Buffer.byteLength(canonical, 'utf8') > PRESET_MAX_BYTES || !Number.isSafeInteger(p.importedAt) || p.importedAt < 0 || p.sha256 !== hash(canonical) || p.id !== 'preset_' + p.sha256 || seen.has(p.id)) throw new EditorError('INVALID_ARGUMENT', 'Invalid or changed imported preset identity');
    seen.add(p.id);
  }
}
export function importEffectPreset(store: EditorStore, content: string): ImportedEffectPreset {
  const inspected = inspectEffectPreset(content), existing = store.project.effectPresets ?? [], previous = existing.find((p) => p.id === inspected.id);
  if (previous) return previous;
  if (existing.length >= PRESET_MAX_COUNT) throw new EditorError('INVALID_ARGUMENT', 'Maximum 64 imported effect presets');
  const preset = { id: inspected.id, sha256: inspected.sha256, importedAt: Date.now(), document: inspected.document };
  store.mutate('project', [preset.id], (p) => ({ ...p, effectPresets: [...existing, preset] })); return preset;
}
export function getEffectPreset(store: EditorStore, presetId: string): ImportedEffectPreset {
  const preset = store.project.effectPresets?.find((p) => p.id === presetId);
  if (!preset) throw new EditorError('NOT_FOUND', 'Imported effect preset not found', { presetId });
  return preset;
}
export function removeEffectPreset(store: EditorStore, presetId: string): void {
  getEffectPreset(store, presetId);
  store.mutate('project', [presetId], (p) => ({ ...p, effectPresets: p.effectPresets!.filter((preset) => preset.id !== presetId) }));
}
export function applyEffectPreset(store: EditorStore, presetId: string, clipId: string, mode: 'append' | 'replace' = 'append') {
  return applyEffectStack(store, clipId, getEffectPreset(store, presetId).document.effects, mode);
}
export function captureEffectPreset(store: EditorStore, clipId: string, metadata: Pick<EffectPresetDocument, 'name' | 'description' | 'author' | 'tags'>): EffectPresetDocument {
  const found = findClip(store.project.timeline, clipId);
  if (!found) throw new EditorError('NOT_FOUND', 'Clip not found', { clipId });
  return normalizeEffectPreset({ format: 'freemier-effect-preset', version: 1, ...metadata, media: found.track.kind, effects: found.clip.effects.map(({ type, enabled, params }) => ({ type, enabled, params })) });
}
