import { EditorError } from '../errors/index.js';
import type { CaptionCue, CaptionTrack, TextStyle } from '../project/types.js';
import { DEFAULT_TEXT_STYLE, validateText, validateTextStyle } from '../titles/style.js';
import { MAX_SRT_CUES, parseSrt as parseSrtEntries, serializeSrt } from './srt.js';

export const MAX_CAPTIONS = MAX_SRT_CUES;
export const MAX_CAPTION_MS = 86_400_000;
export const DEFAULT_CAPTION_STYLE: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSize: 42, x: .5, y: .9, align: 'center', verticalAlign: 'bottom', backgroundOpacity: .72, padding: 10 };

/** Sequence frame timestamps that lie inside a millisecond cue. */
export function captionFrames(cue: Pick<CaptionCue, 'startMs' | 'endMs'>, fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) throw new EditorError('INVALID_ARGUMENT', 'Caption frame rate must be positive');
  const startFrame = Math.ceil(cue.startMs * fps / 1000 - 1e-9), endFrameExclusive = Math.ceil(cue.endMs * fps / 1000 - 1e-9);
  return { startFrame, endFrameExclusive, hasFrame: endFrameExclusive > startFrame };
}
/** Authored extent is independent of visibility and export policy. */
export function captionDuration(cues: readonly CaptionCue[], fps: number): number {
  return cues.reduce((end, cue) => Math.max(end, captionFrames(cue, fps).endFrameExclusive / fps), 0);
}

export function validateCaptions(track: unknown): asserts track is CaptionTrack {
  if (!track || typeof track !== 'object') throw new EditorError('INVALID_ARGUMENT', 'Caption track must be an object');
  const value = track as CaptionTrack;
  if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || typeof value.enabled !== 'boolean' || typeof value.locked !== 'boolean') throw new EditorError('INVALID_ARGUMENT', 'Invalid caption track metadata');
  validateTextStyle(value.style);
  if (!Array.isArray(value.cues) || value.cues.length > MAX_CAPTIONS) throw new EditorError('INVALID_ARGUMENT', `Caption track supports at most ${MAX_CAPTIONS} cues`);
  const ids = new Set<string>();
  for (const cue of value.cues) {
    if (!cue || typeof cue.id !== 'string' || !cue.id || ids.has(cue.id)) throw new EditorError('INVALID_ARGUMENT', 'Caption cue IDs must be unique and nonempty');
    ids.add(cue.id); validateText(cue.text);
    if (cue.text.split('\n').some((line: string) => !line.trim())) throw new EditorError('INVALID_ARGUMENT', 'Caption text cannot contain blank SRT separator lines', { cueId: cue.id });
    if (!Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) || cue.startMs < 0 || cue.endMs > MAX_CAPTION_MS || cue.endMs <= cue.startMs) throw new EditorError('INVALID_ARGUMENT', 'Caption cues require integer milliseconds within 24 hours and end after start', { cueId: cue.id });
  }
  const sorted = [...value.cues].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!, cue = sorted[i]!;
    if (cue.startMs < previous.endMs) throw new EditorError('CONFLICT', 'Caption cues may not overlap', { cueId: cue.id, previousCueId: previous.id });
  }
}

export function parseCaptionSrt(input: string): Array<Omit<CaptionCue, 'id'>> {
  return parseSrtEntries(input).map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
}
export function formatSrt(cues: readonly CaptionCue[]): string {
  return serializeSrt([...cues].sort((a, b) => a.startMs - b.startMs));
}
