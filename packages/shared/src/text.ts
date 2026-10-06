import { EditorError } from './errors.js';
import type { TextStyle, TitleOverlay } from './types.js';
export const MAX_TITLES = 64;
export const TEXT_FONT_HASH = 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5';
export function textRasterPayload(text: string, style: TextStyle, width: number, height: number): string {
  return JSON.stringify({ text, style, width, height, font: TEXT_FONT_HASH, renderer: 1 });
}
export const DEFAULT_TEXT_STYLE: TextStyle = { fontId: 'noto-sans', fontSize: 64, color: '#ffffff', outlineColor: '#000000', outlineWidth: 2, backgroundColor: '#000000', backgroundOpacity: 0, padding: 8, opacity: 1, x: .5, y: .5, align: 'center', verticalAlign: 'middle', lineSpacing: 4 };
export function validateText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 4096 || text.split('\n').length > 16 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new EditorError('INVALID_ARGUMENT', 'Text requires 1–4096 characters, at most 16 lines and no control characters other than newline/tab');
}
export function validateTextStyle(value: unknown): asserts value is TextStyle {
  if (!value || typeof value !== 'object') throw new EditorError('INVALID_ARGUMENT', 'Text style must be an object');
  const s = value as TextStyle;
  if (s.fontId !== 'noto-sans') throw new EditorError('UNSUPPORTED', 'Unknown font ID; use font_list');
  for (const [key, min, max] of [['fontSize', 8, 512], ['outlineWidth', 0, 20], ['backgroundOpacity', 0, 1], ['padding', 0, 32], ['opacity', 0, 1], ['x', 0, 1], ['y', 0, 1], ['lineSpacing', 0, 64]] as const) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < min || s[key] > max) throw new EditorError('INVALID_ARGUMENT', `Text ${key} must be within ${min}..${max}`);
  }
  for (const key of ['fontSize', 'outlineWidth', 'padding', 'lineSpacing'] as const) if (!Number.isInteger(s[key])) throw new EditorError('INVALID_ARGUMENT', `Text ${key} must use integer pixels`);
  for (const key of ['color', 'outlineColor', 'backgroundColor'] as const) if (typeof s[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(s[key])) throw new EditorError('INVALID_ARGUMENT', `Text ${key} must be hex RGB`);
  if (!['left', 'center', 'right'].includes(s.align) || !['top', 'middle', 'bottom'].includes(s.verticalAlign)) throw new EditorError('INVALID_ARGUMENT', 'Invalid text block alignment');
  if (Object.keys(s).some((key) => !Object.hasOwn(DEFAULT_TEXT_STYLE, key))) throw new EditorError('INVALID_ARGUMENT', 'Unknown text style field');
}
export function normalizeText(text: string): string { return text.replace(/\r\n?/g, '\n'); }
export function validateTitles(value: unknown, fps: number): asserts value is readonly TitleOverlay[] {
  if (!Array.isArray(value) || value.length > MAX_TITLES || !Number.isFinite(fps) || fps <= 0) throw new EditorError('INVALID_ARGUMENT', 'Invalid title collection');
  const ids = new Set<string>();
  for (const title of value as TitleOverlay[]) {
    if (!title || typeof title.id !== 'string' || !title.id || title.id.length > 128 || ids.has(title.id)) throw new EditorError('INVALID_ARGUMENT', 'Title IDs must be unique and nonempty');
    ids.add(title.id); validateText(title.text); validateTextStyle(title.style);
    for (const time of [title.start, title.end]) if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 86400 || Math.abs(time * fps - Math.round(time * fps)) > 1e-5) throw new EditorError('INVALID_ARGUMENT', 'Title timing must use sequence frames within 24 hours');
    if (title.end <= title.start) throw new EditorError('INVALID_ARGUMENT', 'Title end must follow start');
  }
}
