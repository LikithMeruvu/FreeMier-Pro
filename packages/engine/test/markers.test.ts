import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorStore, addMarker, updateMarker, removeMarker, listMarkers, timelineDuration, validateProject, saveProject, loadProject } from '../src/index.js';
import { MAX_MARKERS } from '@freemier/shared';

describe('fixed sequence markers', () => {
  it('resolves frame times, preserves Unicode and queries half-open sorted ranges', () => {
    const store = EditorStore.create({ fps: 30 });
    const end = addMarker(store, { time: 2, label: 'End' });
    const a = addMarker(store, { time: 1.019, label: 'नमस्ते · Scene', notes: 'Line 1\nLine 2', color: '#ff0080' });
    addMarker(store, { time: 1, label: 'Same-frame note' });
    expect(a.time).toBe(31 / 30);
    expect(listMarkers(store).map((m) => m.time)).toEqual([1, 31 / 30, 2]);
    expect(listMarkers(store, 1, 2)).toHaveLength(2);
    expect(listMarkers(store, 2)[0]?.id).toBe(end.id);
    expect(a.notes).toBe('Line 1\nLine 2');
    expect(timelineDuration(store.project.timeline)).toBe(0);
  });

  it('creates exactly one event/history item and restores precise add/update/remove snapshots', () => {
    const store = EditorStore.create({ fps: 24 }), initial = store.project;
    const events: string[] = []; store.subscribe((event) => events.push(event.kind));
    const a = addMarker(store, { time: .5, label: 'Original' }), added = store.project;
    expect(store.revision).toBe(1); expect(events).toEqual(['timeline']);
    updateMarker(store, a.id, { time: 1, notes: 'Actual notes', label: 'Edited' }); const edited = store.project;
    expect(store.revision).toBe(2); expect(store.undo()).toBe(true); expect(store.project).toBe(added);
    expect(store.redo()).toBe(true); expect(store.project).toBe(edited);
    removeMarker(store, a.id); expect(listMarkers(store)).toEqual([]); expect(store.undo()).toBe(true); expect(store.project).toBe(edited);
    store.undo(); store.undo(); expect(store.project).toBe(initial);
  });

  it('refuses invalid mutations and missing IDs without touching state/history', () => {
    const store = EditorStore.create(), a = addMarker(store, { time: 1, label: 'Valid' }), before = store.state;
    const invalid = [
      () => addMarker(store, { time: NaN, label: 'NaN' }),
      () => addMarker(store, { time: -.001, label: 'Negative' }),
      () => addMarker(store, { time: 86401, label: 'Too far' }),
      () => updateMarker(store, a.id, { label: '   ' }),
      () => updateMarker(store, a.id, { color: 'url(file)' }),
      () => updateMarker(store, a.id, { notes: 'x'.repeat(4097) }),
      () => removeMarker(store, 'missing'),
    ];
    for (const change of invalid) { expect(change).toThrow(); expect(store.state).toBe(before); }
    store.undo(); expect(listMarkers(store)).toEqual([]);
  });

  it('does not create history for unchanged patches even with a different property order', () => {
    const store = EditorStore.create(), p = store.project;
    store.load({ ...p, timeline: { ...p.timeline, markers: [{ notes: '', label: 'Unchanged', color: '#f0a35e', time: 0, id: 'mrk_order' }] } });
    const before = store.state; updateMarker(store, 'mrk_order', {}); updateMarker(store, 'mrk_order', { label: 'Unchanged' });
    expect(store.state).toBe(before); expect(store.canUndo).toBe(false);
  });

  it('rejects duplicate IDs, invalid times/fields and off-grid persisted markers', () => {
    const store = EditorStore.create(), a = addMarker(store, { time: 1, label: 'Valid' }), p = store.project;
    for (const markers of [[a, a], [{ ...a, time: .017 }], [{ ...a, label: '' }], [{ ...a, time: Infinity }], [{ ...a, color: '#abcd' }]]) {
      expect(() => validateProject({ ...p, timeline: { ...p.timeline, markers } })).toThrow();
    }
  });

  it('bounds marker collections without a partial extra marker', () => {
    const store = EditorStore.create(), p = store.project;
    store.load({ ...p, timeline: { ...p.timeline, markers: Array.from({ length: MAX_MARKERS }, (_, i) => ({ id: 'mrk_' + i, time: i / 30, label: 'Note', color: '#ffffff', notes: '' })) } });
    const before = store.state; expect(() => addMarker(store, { time: 0, label: 'Extra' })).toThrow(); expect(store.state).toBe(before);
  });

  it('persists markers and still loads legacy schema-1 projects without them', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-markers-'));
    try {
      const store = EditorStore.create({ fps: 23.976 }); addMarker(store, { time: 20 / 23.976, label: 'Frame 20', notes: 'Unicode ✓' });
      await saveProject(store.project, path.join(directory, 'Current'));
      expect(await loadProject(path.join(directory, 'Current'))).toEqual(store.project);
      const { markers: _, ...timeline } = store.project.timeline, legacy = { ...store.project, timeline };
      await saveProject(legacy, path.join(directory, 'Legacy.palmier'));
      const loaded = await loadProject(path.join(directory, 'Legacy.palmier')); expect(loaded.timeline.markers).toBeUndefined(); expect(listMarkers(new EditorStore(loaded))).toEqual([]);
    } finally {
      expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects reversed or nonfinite marker query ranges', () => {
    const store = EditorStore.create();
    for (const [start, end] of [[-1, 2], [2, 2], [2, 1], [NaN, 3], [0, NaN]]) expect(() => listMarkers(store, start, end)).toThrow();
  });
});
