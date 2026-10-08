import { describe, expect, it } from 'vitest';
import { EditorStore, addCaption, updateCaption, removeCaption, updateCaptionTrack, importCaptions, exportCaptions, listCaptions, timelineDuration, validateProject, saveProject, loadProject } from '../../src/index.js';
import { captionFrames, EditorError, MAX_CAPTIONS, validateCaptions } from '@freemier/shared';

describe('editable millisecond caption track', () => {
  it('uses the first covered frame and preserves authored extent when disabled', () => {
    const store = EditorStore.create({ fps: 10 }), cue = addCaption(store, { text: 'Boundary', startMs: 501, endMs: 1101 });
    expect(captionFrames(cue, 10)).toEqual({ startFrame: 6, endFrameExclusive: 12, hasFrame: true });
    expect(captionFrames({ startMs: 601, endMs: 602 }, 10).hasFrame).toBe(false);
    expect(timelineDuration(store.project.timeline)).toBe(1.2);
    updateCaptionTrack(store, { enabled: false }); expect(timelineDuration(store.project.timeline)).toBe(1.2);
    expect(exportCaptions(store)).toContain('00:00:00,501 --> 00:00:01,101');
  });
  it('refuses malformed cue arrays and non-SRT text with structured errors before mutation', () => {
    const store = EditorStore.create(), cue = addCaption(store, { text: 'Valid', startMs: 0, endMs: 1000 });
    const before = store.state, track = store.project.timeline.captions!;
    expect(() => validateCaptions({ ...track, cues: [null, cue] })).toThrow(EditorError);
    expect(() => updateCaption(store, cue.id, { text: 'First\n\nLast' })).toThrow(/separator/);
    expect(() => importCaptions(store, '', 'invalid' as 'replace')).toThrow(EditorError);
    expect(store.state).toBe(before);
  });
  it('rejects capacity overflow atomically and avoids history for identical cue/style updates', () => {
    const store = EditorStore.create(), cue = addCaption(store, { text: 'Same', startMs: 0, endMs: 1 });
    const before = store.state; updateCaption(store, cue.id, { text: 'Same' }); updateCaptionTrack(store, { style: { color: '#ffffff' } }); expect(store.state).toBe(before);
    const content = Array.from({ length: MAX_CAPTIONS }, (_, i) => `${i + 1}\n00:00:00,${String(i * 2).padStart(3, '0')} --> 00:00:00,${String(i * 2 + 1).padStart(3, '0')}\nCue ${i}`).join('\n\n');
    importCaptions(store, content); const full = store.state;
    expect(() => addCaption(store, { text: 'Overflow', startMs: 1000, endMs: 1001 })).toThrow(/256/); expect(store.state).toBe(full);
  });
  it('imports canonical SRT atomically, preserves cue time/text and resolves frame coverage', () => {
    const store = EditorStore.create({ fps: 30 });
    const result = importCaptions(store, '\uFEFF7\r\n00:00:01,003 --> 00:00:02,005\r\nHello\r\nworld\r\n\r\n15\r\n00:00:03,001 --> 00:00:03,002\r\nTiny', 'replace');
    expect(result.track.cues.map((cue) => [cue.startMs, cue.endMs, cue.text])).toEqual([[1003, 2005, 'Hello\nworld'], [3001, 3002, 'Tiny']]);
    expect(result.imported.map((cue) => cue.hasFrame)).toEqual([true, false]);
    expect(exportCaptions(store)).toContain('00:00:01,003 --> 00:00:02,005\nHello\nworld');
    expect(listCaptions(store).cues[0]?.startFrame).toBe(31);
    expect(timelineDuration(store.project.timeline)).toBe(3.033333333333333);
  });
  it('rejects overlap/invalid SRT with no partial mutation and appends as one atomic history item', () => {
    const store = EditorStore.create(), before = store.state;
    expect(() => importCaptions(store, '1\n00:00:00,000 --> 00:00:02,000\nOne\n\n2\n00:00:01,999 --> 00:00:03,000\nTwo')).toThrow();
    expect(store.state).toBe(before); expect(store.canUndo).toBe(false);
    importCaptions(store, '1\n00:00:00,000 --> 00:00:01,000\nOne');
    const afterFirst = store.state;
    importCaptions(store, '3\n00:00:01,000 --> 00:00:02,000\nTwo', 'append');
    expect(store.project.timeline.captions?.cues).toHaveLength(2); store.undo(); expect(store.state).toBe(afterFirst);
  });
  it('locks cue/style/import edits and permits only explicit unlock', () => {
    const store = EditorStore.create(), cue = addCaption(store, { text: 'Voice', startMs: 25, endMs: 725 });
    updateCaptionTrack(store, { locked: true }); const locked = store.state;
    expect(() => updateCaption(store, cue.id, { text: 'Changed' })).toThrow(/locked/i);
    expect(() => removeCaption(store, cue.id)).toThrow(/locked/i);
    expect(() => importCaptions(store, '1\n00:00:02,000 --> 00:00:03,000\nNo')).toThrow(/locked/i);
    expect(() => updateCaptionTrack(store, { enabled: false })).toThrow(/locked/i);
    expect(store.state).toBe(locked); updateCaptionTrack(store, { locked: false });
    updateCaption(store, cue.id, { text: 'Changed' }); expect(store.project.timeline.captions?.cues[0]?.text).toBe('Changed');
  });
  it('rejects overlapping cues, stores undoable millisecond changes and keeps schema-1 optional', async () => {
    const store = EditorStore.create({ fps: 25 }), first = addCaption(store, { text: 'A', startMs: 5, endMs: 105 });
    const p = store.project, saved = store.state;
    expect(() => addCaption(store, { text: 'B', startMs: 104, endMs: 250 })).toThrow(); expect(store.state).toBe(saved);
    const second = addCaption(store, { text: 'B', startMs: 105, endMs: 225 }); updateCaption(store, second.id, { startMs: 125 }); store.undo();
    expect(store.project.timeline.captions?.cues[1]?.startMs).toBe(105); removeCaption(store, first.id); store.undo();
    expect(store.project.timeline.captions?.cues).toHaveLength(2);
    const { captions: _captions, ...legacyTimeline } = p.timeline;
    expect(() => validateProject({ ...p, timeline: legacyTimeline })).not.toThrow();
  });
  it('persists edited cues and explicit track settings', async () => {
    const store = EditorStore.create({ fps: 24 }); addCaption(store, { text: 'Persistence', startMs: 500, endMs: 1300 });
    updateCaptionTrack(store, { name: 'Dialogue', enabled: true, style: { fontSize: 36, color: '#00ff00' } });
    const os = await import('node:os'), path = await import('node:path'), fs = await import('node:fs/promises');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-captions-'));
    try { await saveProject(store.project, path.join(temp, 'edit')); expect(await loadProject(path.join(temp, 'edit'))).toEqual(store.project); }
    finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
});
