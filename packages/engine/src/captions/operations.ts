import type { CaptionCue, CaptionTrack, TextStyle } from '@freemier/shared';
import { captionFrames, DEFAULT_CAPTION_STYLE, DEFAULT_TEXT_STYLE, EditorError, formatSrt, MAX_CAPTIONS, newId, normalizeText, parseCaptionSrt, validateCaptions, validateText, validateTextStyle } from '@freemier/shared';
import type { EditorStore } from '../project/store.js';

export type CaptionInput = { text: string; startMs: number; endMs: number };
export type CaptionPatch = Partial<CaptionInput>;
function current(store: EditorStore): CaptionTrack | undefined { return store.project.timeline.captions; }
function write(store: EditorStore, captions: CaptionTrack, cueId: string): void {
  validateCaptions(captions);
  store.mutate('timeline', [store.project.timeline.id, cueId], (p) => ({ ...p, timeline: { ...p.timeline, captions } }));
}
function mutable(store: EditorStore): CaptionTrack {
  const track = current(store);
  if (track?.locked) throw new EditorError('CONFLICT', 'Caption track is locked; unlock it before editing', { trackId: track.id });
  return track ?? { id: newId('cap'), name: 'Captions', enabled: true, locked: false, style: { ...DEFAULT_CAPTION_STYLE }, cues: [] };
}
function normalizeCue(input: CaptionInput, id: string): CaptionCue {
  const cue = { id, text: normalizeText(input.text), startMs: input.startMs, endMs: input.endMs };
  validateText(cue.text);
  if (!Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > 86_400_000) throw new EditorError('INVALID_ARGUMENT', 'Caption times must be integer milliseconds in [0, 86400000), with end after start');
  return cue;
}
export { captionFrames } from '@freemier/shared';
export function addCaption(store: EditorStore, input: CaptionInput): CaptionCue {
  const track = mutable(store), cue = normalizeCue(input, newId('cue'));
  if (track.cues.length >= MAX_CAPTIONS) throw new EditorError('INVALID_ARGUMENT', `Caption track supports at most ${MAX_CAPTIONS} cues`);
  write(store, { ...track, cues: [...track.cues, cue].sort((a, b) => a.startMs - b.startMs) }, cue.id); return cue;
}
export function updateCaption(store: EditorStore, id: string, patch: CaptionPatch): CaptionCue {
  const track = mutable(store), old = track.cues.find((c) => c.id === id);
  if (!old) throw new EditorError('NOT_FOUND', 'Caption cue not found', { cueId: id });
  const cue = normalizeCue({ ...old, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) }, id);
  if (cue.text !== old.text || cue.startMs !== old.startMs || cue.endMs !== old.endMs) write(store, { ...track, cues: track.cues.map((c) => c.id === id ? cue : c).sort((a, b) => a.startMs - b.startMs) }, id);
  return cue;
}
export function removeCaption(store: EditorStore, id: string): void {
  const track = mutable(store); if (!track.cues.some((c) => c.id === id)) throw new EditorError('NOT_FOUND', 'Caption cue not found', { cueId: id });
  write(store, { ...track, cues: track.cues.filter((c) => c.id !== id) }, id);
}
export function updateCaptionTrack(store: EditorStore, patch: { name?: string; enabled?: boolean; locked?: boolean; style?: Partial<TextStyle> }): CaptionTrack {
  const old = current(store), unlockOnly = old?.locked === true && patch.locked === false && Object.keys(patch).every((k) => k === 'locked');
  if (old?.locked && !unlockOnly) throw new EditorError('CONFLICT', 'Caption track is locked; only an explicit unlock is allowed', { trackId: old.id });
  const track = old ?? { id: newId('cap'), name: 'Captions', enabled: true, locked: false, style: { ...DEFAULT_CAPTION_STYLE }, cues: [] };
  const next = { ...track, ...patch, style: { ...track.style, ...patch.style } };
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120)) throw new EditorError('INVALID_ARGUMENT', 'Caption track name must be 1..120 characters');
  validateTextStyle(next.style); validateCaptions(next);
  if (!old || JSON.stringify(old) !== JSON.stringify(next)) write(store, next, track.id);
  return next;
}
export function importCaptions(store: EditorStore, content: string, mode: 'replace' | 'append' = 'replace') {
  if (mode !== 'replace' && mode !== 'append') throw new EditorError('INVALID_ARGUMENT', 'Caption import mode must be replace or append');
  const parsed = parseCaptionSrt(content), old = current(store);
  if (old?.locked) throw new EditorError('CONFLICT', 'Caption track is locked; unlock it before importing', { trackId: old.id });
  const track = old ?? { id: newId('cap'), name: 'Captions', enabled: true, locked: false, style: { ...DEFAULT_CAPTION_STYLE }, cues: [] };
  const incoming = parsed.map((cue) => ({ ...cue, id: newId('cue') }));
  const cues = mode === 'append' ? [...track.cues, ...incoming].sort((a, b) => a.startMs - b.startMs) : incoming;
  const next = { ...track, cues }; validateCaptions(next);
  if (!old || JSON.stringify(old) !== JSON.stringify(next)) write(store, next, track.id);
  const fps = store.project.timeline.fps;
  return { track: next, imported: incoming.map((cue) => ({ ...cue, ...captionFrames(cue, fps) })), warnings: incoming.filter((cue) => !captionFrames(cue, fps).hasFrame).map((cue) => ({ cueId: cue.id, message: 'No sequence frame lies inside this subframe cue' })) };
}
export function exportCaptions(store: EditorStore): string { return formatSrt(current(store)?.cues ?? []); }
export function listCaptions(store: EditorStore) { const track = current(store); return { track, cues: (track?.cues ?? []).map((cue) => ({ ...cue, ...captionFrames(cue, store.project.timeline.fps) })), timeDomain: 'integer milliseconds', interval: '[startMs,endMs)' }; }
export function captionTextStyle(store: EditorStore): TextStyle { return current(store)?.style ?? DEFAULT_TEXT_STYLE; }
