import { EditorError } from './errors.js';
import { normalizeText, validateText } from './text.js';
export interface SrtEntry { readonly startMs: number; readonly endMs: number; readonly text: string; readonly sourceLine?: number }
export const MAX_SRT_CUES = 256;
const MAX_TIME = 86_400_000;
function failure(message: string, line?: number): never { throw new EditorError('INVALID_ARGUMENT', message, line === undefined ? undefined : { line }); }
function checkTime(value: number): void { if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIME) failure('SubRip time must use integer milliseconds within 24 hours'); }
export function formatSrtTime(milliseconds: number): string {
  checkTime(milliseconds);
  const seconds = Math.floor(milliseconds / 1000), hour = Math.floor(seconds / 3600), minute = Math.floor(seconds / 60) % 60;
  return [hour, minute, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':') + ',' + String(milliseconds % 1000).padStart(3, '0');
}
function parseTime(value: string, line: number): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if (!match) failure('Use SubRip HH:MM:SS,mmm timestamps', line);
  const [hour, minute, second, ms] = match.slice(1).map(Number) as [number, number, number, number];
  if (minute > 59 || second > 59) failure('SubRip minute/second fields must be within 0..59', line);
  const time = ((hour * 60 + minute) * 60 + second) * 1000 + ms;
  if (!Number.isSafeInteger(time) || time > MAX_TIME) failure('SubRip timestamp exceeds 24 hours', line);
  return time;
}
function validateEntry(cue: SrtEntry, line?: number): void {
  checkTime(cue.startMs); checkTime(cue.endMs);
  if (cue.endMs <= cue.startMs) failure('SubRip cue end must follow start', line);
  try { validateText(cue.text); } catch { failure('SubRip cue needs bounded plain text (up to 4096 characters/16 lines)', line); }
  if (cue.text.split('\n').some((s) => !s.trim())) failure('SubRip text cannot contain blank separator lines', line);
}
/** Format parser only: preserves cue order/overlaps for an explicit engine policy. */
export function parseSrt(content: string): readonly SrtEntry[] {
  if (typeof content !== 'string' || content.length > 131072) failure('SubRip input exceeds 131072 characters');
  const lines = normalizeText(content.replace(/^\uFEFF/, '')).split('\n'), cues: SrtEntry[] = [];
  let at = 0;
  while (at < lines.length) {
    if (!lines[at]!.trim()) { at++; continue; }
    const numberLine = at + 1, number = lines[at++]!.trim();
    if (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number)) || Number(number) < 1) failure('SubRip cue index must be a positive integer', numberLine);
    const timeLine = at + 1, interval = /^\s*(\d{2,}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2},\d{3})\s*$/.exec(lines[at++] ?? '');
    if (!interval) failure('Invalid SubRip interval; timestamp settings are unsupported', timeLine);
    const body: string[] = []; while (at < lines.length && lines[at]!.trim()) body.push(lines[at++]!);
    const cue = { startMs: parseTime(interval[1]!, timeLine), endMs: parseTime(interval[2]!, timeLine), text: body.join('\n'), sourceLine: timeLine };
    validateEntry(cue, timeLine); cues.push(cue);
    if (cues.length > MAX_SRT_CUES) failure(`Maximum ${MAX_SRT_CUES} SubRip cues`, numberLine);
  }
  return cues;
}
/** Canonical UTF-8-compatible text. Styling is deliberately external to SRT. */
export function serializeSrt(cues: readonly SrtEntry[]): string {
  if (!Array.isArray(cues) || cues.length > MAX_SRT_CUES) failure('Invalid SubRip cue collection');
  return cues.map((cue, index) => { validateEntry(cue, cue.sourceLine); return `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}\n`; }).join('\n');
}
