import type { Clip, Effect, Keyframe, Track } from '@freemier/shared';
import { EditorError, newClipId, validateTransformValue, validateEffectParams, effectDescriptor, EASINGS, type TransformProperty } from '@freemier/shared';
import { type EditorStore, withClips } from './store.js';
import { findClip, updateClip, assertOriginEditable } from './operations.js';
import { clipEnd, sortClips, quantize, assertNoOverlap } from './timeline.js';

function editable(store: EditorStore, id: string) {
  const found = findClip(store.project.timeline, id);
  if (!found) throw new EditorError('NOT_FOUND', 'Clip not found', { clipId: id });
  if (found.track.locked) throw new EditorError('CONFLICT', 'Track is locked', { trackId: found.track.id });
  return found;
}
function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new EditorError('INVALID_ARGUMENT', `${name} must be finite`);
}
function sourceBound(store: EditorStore, clip: Clip) {
  const asset = store.project.media.find((m) => m.id === clip.assetId);
  if (!asset) throw new EditorError('NOT_FOUND', 'Media asset not found', { assetId: clip.assetId });
  if (clip.sourceIn < -1e-6 || clip.sourceOut > asset.duration + 1e-6 || clip.duration < 1 / store.project.timeline.fps - 1e-6) {
    throw new EditorError('INVALID_ARGUMENT', 'Edit exceeds source handles or minimum one-frame duration', { clipId: clip.id, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, assetDuration: asset.duration });
  }
}
function writeTrack(store: EditorStore, track: Track, clips: Clip[], ids: string[]) {
  const next = { ...track, clips: sortClips(clips) }; assertNoOverlap(next);
  store.mutate('clip', [track.id, ...ids], (p) => ({ ...p, timeline: withClips(p.timeline, track.id, next.clips) }));
}
export function slipClip(store: EditorStore, clipId: string, delta: number): Clip {
  finite(delta, 'delta'); const { track, clip } = editable(store, clipId), fps = store.project.timeline.fps;
  const shift = quantize(delta, fps);
  const updated = { ...clip, sourceIn: quantize(clip.sourceIn + shift, fps), sourceOut: quantize(clip.sourceOut + shift, fps) };
  sourceBound(store, updated);
  writeTrack(store, track, track.clips.map((c) => c.id === clipId ? updated : c), [clipId]); return updated;
}
/** Move an adjacent cut; sequence length and the outer source endpoints stay fixed. */
export function rollClips(store: EditorStore, leftClipId: string, rightClipId: string, at: number): [Clip, Clip] {
  finite(at, 'at'); const left = editable(store, leftClipId), right = editable(store, rightClipId), fps = store.project.timeline.fps;
  if (left.track.id !== right.track.id || Math.abs(clipEnd(left.clip) - right.clip.start) > 1e-6) throw new EditorError('CONFLICT', 'Rolling edit requires two adjacent clips on the same track');
  const boundary = quantize(at, fps), delta = boundary - right.clip.start;
  if (Math.abs(delta) > 1e-6) assertOriginEditable(right.clip);
  const a = { ...left.clip, duration: quantize(boundary - left.clip.start, fps), sourceOut: quantize(left.clip.sourceOut + delta, fps) };
  const b = { ...right.clip, start: boundary, duration: quantize(clipEnd(right.clip) - boundary, fps), sourceIn: quantize(right.clip.sourceIn + delta, fps) };
  sourceBound(store, a); sourceBound(store, b);
  writeTrack(store, left.track, left.track.clips.map((c) => c.id === a.id ? a : c.id === b.id ? b : c), [a.id, b.id]); return [a, b];
}
export function duplicateClip(store: EditorStore, clipId: string, start?: number, trackId?: string): Clip {
  const found = editable(store, clipId), track = store.project.timeline.tracks.find((t) => t.id === (trackId ?? found.track.id));
  if (!track) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  if (track.locked) throw new EditorError('CONFLICT', 'Track is locked', { trackId: track.id });
  finite(start ?? clipEnd(found.clip), 'start');
  const copy = { ...structuredClone(found.clip), id: newClipId(), start: quantize(start ?? clipEnd(found.clip), store.project.timeline.fps) };
  if (copy.start < 0) throw new EditorError('INVALID_ARGUMENT', 'Start must be nonnegative');
  writeTrack(store, track, [...track.clips, copy], [copy.id]); return copy;
}
/** Header controls can unlock/mute/rename a track; all content editing honors its lock. */
export function updateTrack(store: EditorStore, trackId: string, patch: Partial<Pick<Track, 'name' | 'muted' | 'locked' | 'order'>>): Track {
  const track = store.project.timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120)) throw new EditorError('INVALID_ARGUMENT', 'Track name must contain 1–120 characters');
  if (patch.order !== undefined && (!Number.isInteger(patch.order) || patch.order < 0 || patch.order > 1024)) throw new EditorError('INVALID_ARGUMENT', 'Track order must be an integer between 0 and 1024');
  if (track.locked && patch.order !== undefined && patch.locked !== false) throw new EditorError('CONFLICT', 'Unlock the track before changing its compositing order');
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const updated = { ...track, ...defined } as Track;
  store.mutate('track', [trackId], (p) => ({ ...p, timeline: { ...p.timeline, tracks: p.timeline.tracks.map((t) => t.id === trackId ? updated : t) } })); return updated;
}
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
