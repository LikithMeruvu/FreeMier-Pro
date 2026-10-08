import { DEFAULT_TEXT_STYLE, EditorError, MAX_TITLES, newId, normalizeText, validateTitles, type TextStyle, type TitleOverlay } from '@freemier/shared';
import type { EditorStore } from '../project/store.js';
import { quantize } from '../timeline/queries.js';

export type TitleInput = Pick<TitleOverlay, 'text' | 'start' | 'end'> & { style?: Partial<TextStyle> };
export type TitlePatch = Partial<TitleInput>;
function normalize(input: TitleInput, fps: number, id: string): TitleOverlay {
  const title = { id, text: normalizeText(input.text), start: quantize(input.start, fps), end: quantize(input.end, fps), style: { ...DEFAULT_TEXT_STYLE, ...input.style } };
  // Refuse negative/subframe intervals rather than normalizing them into valid state.
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end > 86400 || input.end <= input.start) throw new EditorError('INVALID_ARGUMENT', 'Invalid title interval');
  validateTitles([title], fps); return title;
}
function write(store: EditorStore, titles: readonly TitleOverlay[], id: string) {
  validateTitles(titles, store.project.timeline.fps);
  store.mutate('timeline', [store.project.timeline.id, id], (p) => ({ ...p, timeline: { ...p.timeline, titles } }));
}
export function addTitle(store: EditorStore, input: TitleInput): TitleOverlay {
  const titles = store.project.timeline.titles ?? [];
  if (titles.length >= MAX_TITLES) throw new EditorError('INVALID_ARGUMENT', `Maximum ${MAX_TITLES} titles`);
  const title = normalize(input, store.project.timeline.fps, newId('ttl')); write(store, [...titles, title], title.id); return title;
}
export function updateTitle(store: EditorStore, id: string, patch: TitlePatch): TitleOverlay {
  const titles = store.project.timeline.titles ?? [], previous = titles.find((t) => t.id === id);
  if (!previous) throw new EditorError('NOT_FOUND', 'Title not found', { titleId: id });
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const title = normalize({ ...previous, ...defined, style: { ...previous.style, ...patch.style } }, store.project.timeline.fps, id);
  if (title.text !== previous.text || title.start !== previous.start || title.end !== previous.end || Object.keys(DEFAULT_TEXT_STYLE).some((k) => title.style[k as keyof TextStyle] !== previous.style[k as keyof TextStyle])) write(store, titles.map((t) => t.id === id ? title : t), id);
  return title;
}
export function removeTitle(store: EditorStore, id: string): void {
  const titles = store.project.timeline.titles ?? [];
  if (!titles.some((t) => t.id === id)) throw new EditorError('NOT_FOUND', 'Title not found', { titleId: id });
  write(store, titles.filter((t) => t.id !== id), id);
}
export function listTitles(store: EditorStore): readonly TitleOverlay[] { return store.project.timeline.titles ?? []; }
