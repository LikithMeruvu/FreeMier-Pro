import { EditorError } from './errors.js';
function nominalRate(fps: number): number {
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new EditorError('INVALID_ARGUMENT', 'Timecode frame rate must be within 1–240');
  return Math.round(fps);
}
/** Non-drop HH:MM:SS:FF counts nominal frames, including fractional-rate projects. */
export function frameTimecode(seconds: number, fps: number): string {
  const nominal = nominalRate(fps);
  if (!Number.isFinite(seconds) || seconds < 0) throw new EditorError('INVALID_ARGUMENT', 'Timecode time must be finite and nonnegative');
  const frame = Math.floor(seconds * fps + 1e-5);
  return [Math.floor(frame / nominal / 3600), Math.floor(frame / nominal / 60) % 60, Math.floor(frame / nominal) % 60, frame % nominal].map((n) => String(n).padStart(2, '0')).join(':');
}
export function parseFrameTimecode(value: string, fps: number): number {
  const nominal = nominalRate(fps), match = /^(\d{2,}):(\d{2}):(\d{2}):(\d{2,3})$/.exec(value);
  if (!match) throw new EditorError('INVALID_ARGUMENT', 'Use non-drop HH:MM:SS:FF');
  const [hour, minute, second, frame] = match.slice(1).map(Number) as [number, number, number, number];
  if (!Number.isSafeInteger(hour) || minute > 59 || second > 59 || frame >= nominal) throw new EditorError('INVALID_ARGUMENT', 'Invalid timecode clock or frame field');
  const count = ((hour * 60 + minute) * 60 + second) * nominal + frame;
  if (!Number.isSafeInteger(count)) throw new EditorError('INVALID_ARGUMENT', 'Timecode frame count is too large');
  return count / fps;
}
