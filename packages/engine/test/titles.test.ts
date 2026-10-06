import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorStore, addTitle, updateTitle, removeTitle, timelineDuration, validateProject, saveProject, loadProject } from '../src/index.js';
describe('styled title state', () => {
  it('quantizes sequence ranges, merges partial style and creates atomic history', () => {
    const store = EditorStore.create({ fps: 24 }), initial = store.project;
    const t = addTitle(store, { text: 'Δ · Ж\r\nQuoted: "100%"', start: .019, end: 2, style: { x: .3 } });
    expect(t.start).toBe(0); expect(t.text).toContain('\n'); expect(t.text).not.toContain('\r'); expect(timelineDuration(store.project.timeline)).toBe(2);
    const added = store.project; updateTitle(store, t.id, { style: { color: '#00ff00' } });
    expect(store.project.timeline.titles![0]!.style.x).toBe(.3); expect(store.revision).toBe(2);
    store.undo(); expect(store.project).toBe(added); store.undo(); expect(store.project).toBe(initial); store.redo(); expect(store.project).toBe(added);
    removeTitle(store, t.id); expect(timelineDuration(store.project.timeline)).toBe(0); store.undo(); expect(store.project).toBe(added);
  });
  it('refuses malformed text, timings, styles and unsupported fonts without mutation', () => {
    const store = EditorStore.create(), t = addTitle(store, { text: 'Valid', start: 0, end: 1 }), before = store.state;
    for (const patch of [{ text: '  ' }, { text: '\0' }, { start: -.001 }, { end: 0 }, { end: NaN }, { end: .001 }, { style: { opacity: 2 } }, { style: { x: -1 } }, { style: { padding: 1.5 } }, { style: { color: 'yellow' } }, { style: { fontId: 'missing' } }, { style: { constructor: 'bad' } }]) {
      expect(() => updateTitle(store, t.id, patch as never)).toThrow(); expect(store.state).toBe(before);
    }
    expect(() => removeTitle(store, 'missing')).toThrow(); expect(store.state).toBe(before);
  });
  it('preserves no-op history and validates persisted schema-1 extension', () => {
    const store = EditorStore.create(), t = addTitle(store, { text: 'Same', start: 0, end: 1 }), before = store.state;
    updateTitle(store, t.id, { style: { color: t.style.color }, text: t.text }); expect(store.state).toBe(before);
    expect(() => validateProject({ ...store.project, timeline: { ...store.project.timeline, titles: [t, t] } })).toThrow();
    expect(() => validateProject({ ...store.project, timeline: { ...store.project.timeline, titles: [{ ...t, start: .017 }] } })).toThrow();
  });
  it('round-trips plain Unicode and optional legacy data', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-title-save-'));
    try { const store = EditorStore.create(); addTitle(store, { text: 'Résumé · Δ · Ж\n"Quoted" 100%', start: 0, end: 1 }); await saveProject(store.project, path.join(directory, 'Title')); expect(await loadProject(path.join(directory, 'Title'))).toEqual(store.project); }
    finally { expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
