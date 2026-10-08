import type { Clip, Effect } from '@freemier/shared';
import { EditorError, effectDescriptor, newClipId, validateEffectParams } from '@freemier/shared';
import { editable } from '../clips/guards.js';
import { updateClip } from '../clips/operations.js';
import { type EditorStore } from '../project/store.js';

function validateEffect(store: EditorStore, clipId: string, type: string, params: Readonly<Record<string, unknown>>) {
  const { clip, track } = editable(store, clipId), descriptor = effectDescriptor(type), validated = validateEffectParams(type, params);
  const asset = store.project.media.find((m) => m.id === clip.assetId);
  if (descriptor.media === 'audio' ? track.kind !== 'audio' || !asset?.hasAudio : track.kind !== 'video' || asset?.kind === 'audio') {
    throw new EditorError('UNSUPPORTED', `Effect requires a ${descriptor.media} clip on a ${descriptor.media} track`, { type, clipId });
  }
  if (type.endsWith('_fade') && Number(validated.start) + Number(validated.duration) > clip.duration + 1e-6) throw new EditorError('INVALID_ARGUMENT', 'Fade extends beyond clip-local duration');
  return validated;
}

export function addEffect(store: EditorStore, clipId: string, type: string, params: Readonly<Record<string, unknown>> = {}): Effect {
  const validated = validateEffect(store, clipId, type, params), { clip } = editable(store, clipId);
  if (clip.effects.length >= 32) throw new EditorError('INVALID_ARGUMENT', 'Maximum 32 effects per clip');
  const effect = { id: `fx_${newClipId()}`, type, params: validated, enabled: true };
  updateClip(store, clipId, { effects: [...clip.effects, effect] }); return effect;
}

export function updateEffect(store: EditorStore, clipId: string, effectId: string, params?: Readonly<Record<string, unknown>>, enabled?: boolean): Effect {
  const { clip } = editable(store, clipId), effect = clip.effects.find((e) => e.id === effectId);
  if (!effect) throw new EditorError('NOT_FOUND', 'Effect not found', { effectId });
  const updated = { ...effect, params: validateEffect(store, clipId, effect.type, { ...effect.params, ...params }), enabled: enabled ?? effect.enabled };
  updateClip(store, clipId, { effects: clip.effects.map((e) => e.id === effectId ? updated : e) }); return updated;
}

export function removeEffect(store: EditorStore, clipId: string, effectId: string): Clip {
  const { clip } = editable(store, clipId);
  if (!clip.effects.some((e) => e.id === effectId)) throw new EditorError('NOT_FOUND', 'Effect not found', { effectId });
  return updateClip(store, clipId, { effects: clip.effects.filter((e) => e.id !== effectId) });
}

export function applyEffectStack(store: EditorStore, clipId: string, entries: readonly Omit<Effect, 'id'>[], mode: 'append' | 'replace' = 'append'): Clip {
  if (mode !== 'append' && mode !== 'replace') throw new EditorError('INVALID_ARGUMENT', 'Expected append or replace');
  const { clip } = editable(store, clipId);
  if (!Array.isArray(entries) || !entries.length || entries.length > 32 || (mode === 'append' && clip.effects.length + entries.length > 32)) throw new EditorError('INVALID_ARGUMENT', 'Expected a nonempty stack with maximum 32 resulting effects');
  const effects = entries.map((entry) => {
    if (typeof entry.enabled !== 'boolean') throw new EditorError('INVALID_ARGUMENT', 'Effect enabled must be boolean');
    return { id: `fx_${newClipId()}`, type: entry.type, enabled: entry.enabled, params: validateEffect(store, clipId, entry.type, entry.params) };
  });
  return updateClip(store, clipId, { effects: [...(mode === 'append' ? clip.effects : []), ...effects] });
}
