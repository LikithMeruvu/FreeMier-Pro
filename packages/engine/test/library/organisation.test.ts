import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaAsset, MediaBin, Project } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import {
  EditorStore, addEffect, addLinkedClip, addMediaAsset, assignMediaBin, createMediaBin,
  listMediaBins, loadProject, queryMedia, removeMediaBin, replaceMediaLocation,
  saveProject, setKeyframe, updateMediaBin, updateMediaMetadata, validateProject,
} from '../../src/index.js';

function asset(id = 'sample', overrides: Partial<MediaAsset> = {}): MediaAsset {
  return { id, path: '/missing/sample.mp4', copied: false, name: id, kind: 'video', duration: 10,
    width: 640, height: 360, fps: 30, hasAudio: true, sampleRate: 48000,
    videoCodec: 'h264', audioCodec: 'aac', probedAt: 0, ...overrides };
}

function populated(): EditorStore {
  const store = EditorStore.create();
  addMediaAsset(store, asset());
  return new EditorStore(store.project);
}

function unchanged(store: EditorStore, action: () => unknown, code?: string): void {
  const state = store.state, undo = store.canUndo, redo = store.canRedo, events: unknown[] = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  try {
    expect(action).toThrow(EditorError);
    if (code) { try { action(); } catch (error) { expect(error).toMatchObject({ code }); } }
    expect(store.state).toBe(state); expect(store.canUndo).toBe(undo); expect(store.canRedo).toBe(redo);
    expect(events).toEqual([]);
  } finally { unsubscribe(); }
}

describe('media bins and project metadata', () => {
  it('creates, moves and renames ordinary bins while enforcing sibling uniqueness and graph limits', () => {
    const store = populated(), first = createMediaBin(store, { name: 'Footage' });
    const second = createMediaBin(store, { name: 'Music' });
    const nested = createMediaBin(store, { name: 'Footage', parentId: first.id });
    unchanged(store, () => createMediaBin(store, { name: ' FOOTAGE ' }), 'INVALID_ARGUMENT');
    unchanged(store, () => updateMediaBin(store, second.id, { name: 'fOoTaGe' }));
    unchanged(store, () => updateMediaBin(store, first.id, { parentId: nested.id }));
    unchanged(store, () => updateMediaBin(store, nested.id, { parentId: nested.id }));
    unchanged(store, () => updateMediaBin(store, nested.id, { parentId: 'missing' }), 'NOT_FOUND');
    expect(updateMediaBin(store, nested.id, { parentId: second.id, name: 'Archive' })).toEqual({ ...nested, parentId: second.id, name: 'Archive' });
    expect(updateMediaBin(store, nested.id, { parentId: null })).toMatchObject({ parentId: null });
    for (const name of ['', '  ', 'x'.repeat(121), 'line\nbreak']) unchanged(store, () => createMediaBin(store, { name }));
    const before = store.state;
    updateMediaBin(store, first.id, { name: first.name, parentId: null });
    expect(store.state).toBe(before);
    const bins = listMediaBins(store) as MediaBin[];
    bins.pop(); expect(listMediaBins(store)).toHaveLength(3);
    const atLimit: MediaBin[] = Array.from({ length: 256 }, (_, i) => ({ id: `b${i}`, name: `Bin ${i}`, parentId: null }));
    const full = new EditorStore({ ...store.project, mediaLibrary: { version: 1, bins: atLimit, entries: [] } });
    unchanged(full, () => createMediaBin(full, { name: 'Over limit' }));
    const deep: MediaBin[] = Array.from({ length: 32 }, (_, i) => ({ id: `b${i}`, name: `Bin ${i}`, parentId: i ? `b${i - 1}` : null }));
    const tree = new EditorStore({ ...store.project, mediaLibrary: { version: 1, bins: deep, entries: [] } });
    unchanged(tree, () => createMediaBin(tree, { name: 'Over depth', parentId: 'b31' }));
    const sibling = createMediaBin(tree, { name: 'Another root' });
    unchanged(tree, () => updateMediaBin(tree, sibling.id, { parentId: 'b31' }));
  });

  it('assigns multiple assets in one event and only deletes bins without children or members', () => {
    const store = populated(); addMediaAsset(store, asset('second'));
    const parent = createMediaBin(store, { name: 'Assets' }), child = createMediaBin(store, { name: 'Child', parentId: parent.id });
    unchanged(store, () => removeMediaBin(store, parent.id), 'CONFLICT');
    const before = store.project, events: unknown[] = [], revision = store.revision;
    const unsubscribe = store.subscribe((event) => events.push(event));
    expect(assignMediaBin(store, ['sample', 'second'], child.id).map((row) => row.binId)).toEqual([child.id, child.id]);
    expect(store.revision).toBe(revision + 1); expect(events).toHaveLength(1);
    expect(store.undo()).toBe(true); expect(store.project).toBe(before);
    expect(store.redo()).toBe(true); unsubscribe();
    unchanged(store, () => removeMediaBin(store, child.id), 'CONFLICT');
    unchanged(store, () => assignMediaBin(store, ['sample', 'absent'], parent.id), 'NOT_FOUND');
    unchanged(store, () => assignMediaBin(store, ['sample', 'sample'], parent.id));
    unchanged(store, () => assignMediaBin(store, [], parent.id));
    unchanged(store, () => assignMediaBin(store, ['sample'], 'absent'), 'NOT_FOUND');
    assignMediaBin(store, ['sample', 'second'], null);
    removeMediaBin(store, child.id); removeMediaBin(store, parent.id);
    expect(listMediaBins(store)).toEqual([]);
    unchanged(store, () => removeMediaBin(store, parent.id), 'NOT_FOUND');
  });

  it('imports directly into a bin atomically and preserves original add semantics', () => {
    const store = EditorStore.create(), bin = createMediaBin(store, { name: 'Imports' }), before = store.project;
    const revision = store.revision, events: unknown[] = []; store.subscribe((event) => events.push(event));
    addMediaAsset(store, asset(), bin.id);
    expect(queryMedia(store).items[0]).toMatchObject({ assetId: 'sample', binId: bin.id });
    expect(store.revision).toBe(revision + 1); expect(events).toHaveLength(1);
    store.undo(); expect(store.project).toBe(before);
    unchanged(store, () => addMediaAsset(store, asset(), 'absent'), 'NOT_FOUND');
    expect(store.redo()).toBe(true);
    unchanged(store, () => addMediaAsset(store, asset(), bin.id));
    const legacy = EditorStore.create(); addMediaAsset(legacy, asset()); addMediaAsset(legacy, asset('root'), null);
    expect(legacy.project.mediaLibrary).toBeUndefined();
  });

  it('updates metadata and name once, preserves memberships and refuses invalid edits atomically', () => {
    const store = populated(), bin = createMediaBin(store, { name: 'Shots' }); assignMediaBin(store, ['sample'], bin.id);
    const before = store.project, revision = store.revision, events: unknown[] = []; store.subscribe((event) => events.push(event));
    const tags = ['Outdoor', 'Travel'];
    expect(updateMediaMetadata(store, 'sample', { name: 'Sunset', description: 'Warm evening', tags, rating: 5 })).toMatchObject({
      asset: { name: 'Sunset' }, binId: bin.id, description: 'Warm evening', tags, rating: 5,
    });
    expect(store.revision).toBe(revision + 1); expect(events).toHaveLength(1);
    tags.push('external edit'); expect(queryMedia(store).items[0]!.tags).toEqual(['Outdoor', 'Travel']);
    const row = queryMedia(store).items[0]!; (row.tags as string[]).push('external query');
    expect(queryMedia(store).items[0]!.tags).toEqual(['Outdoor', 'Travel']);
    store.undo(); expect(store.project).toBe(before); store.redo();
    for (const opts of [
      { description: 'x'.repeat(4097) }, { description: null }, { description: 'x\0' },
      { tags: Array.from({ length: 33 }, () => 'tag') }, { tags: ['x'.repeat(65)] }, { tags: [' '] }, { tags: [3] }, { tags: null },
      { rating: -1 }, { rating: 6 }, { rating: 2.5 }, { rating: NaN }, { rating: '3' }, { name: '' }, { name: null }, { typo: 'wrong' },
    ]) unchanged(store, () => updateMediaMetadata(store, 'sample', opts as any));
    unchanged(store, () => updateMediaMetadata(store, 'absent', {}), 'NOT_FOUND');
    const state = store.state; updateMediaMetadata(store, 'sample', { description: 'Warm evening', tags: ['Outdoor', 'Travel'], rating: 5 });
    expect(store.state).toBe(state);
    expect(updateMediaMetadata(store, 'sample', { description: 'x'.repeat(4096), tags: Array.from({ length: 32 }, (_, i) => String(i).padEnd(64, 'x')), rating: 0 }).tags).toHaveLength(32);
  });
});

describe('shared media discovery', () => {
  function searchable() {
    const store = EditorStore.create();
    addMediaAsset(store, asset('c', { name: 'Same', duration: 3, probedAt: 20 }));
    addMediaAsset(store, asset('b', { name: 'same', duration: 3, probedAt: 20 }));
    addMediaAsset(store, asset('a', { name: 'Alpha', duration: 4, probedAt: 10, kind: 'audio', width: 0, height: 0 }));
    addMediaAsset(store, asset('d', { name: 'Still', duration: 1, probedAt: 30, kind: 'image', hasAudio: false, sampleRate: null, audioCodec: null }));
    const bin = createMediaBin(store, { name: 'Folder' }), child = createMediaBin(store, { name: 'Nested', parentId: bin.id });
    assignMediaBin(store, ['b'], bin.id); assignMediaBin(store, ['c'], child.id);
    updateMediaMetadata(store, 'c', { description: 'Golden sunset', tags: ['Outside'], rating: 4 });
    updateMediaMetadata(store, 'a', { rating: 4 });
    return { store, bin, child };
  }
  it('combines text, kind, direct and recursive bin filters without changing the store', () => {
    const { store, bin } = searchable(), state = store.state;
    const ids = (opts: any) => queryMedia(store, opts).items.map((row) => row.assetId);
    expect(ids({ text: '  SAME  ' })).toEqual(['b', 'c']);
    expect(ids({ text: 'SUNSET' })).toEqual(['c']); expect(ids({ text: 'outside' })).toEqual(['c']);
    expect(ids({ kind: 'image' })).toEqual(['d']);
    expect(ids({ binId: bin.id })).toEqual(['b']);
    expect(ids({ binId: bin.id, includeDescendants: true })).toEqual(['b', 'c']);
    expect(ids({ binId: null })).toEqual(['a', 'd']);
    expect(ids({ binId: null, includeDescendants: true })).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ text: 'same', kind: 'video', binId: bin.id, includeDescendants: true })).toEqual(['b', 'c']);
    expect(ids({ text: 'same', kind: 'image' })).toEqual([]);
    expect(store.state).toBe(state);
  });
  it('sorts and paginates deterministically with asset ID ties in either direction', () => {
    const { store } = searchable();
    const ids = (sortBy: any, sortDirection: any) => queryMedia(store, { sortBy, sortDirection }).items.map((row) => row.assetId);
    expect(ids('name', 'asc')).toEqual(['a', 'b', 'c', 'd']); expect(ids('name', 'desc')).toEqual(['d', 'b', 'c', 'a']);
    expect(ids('duration', 'asc')).toEqual(['d', 'b', 'c', 'a']); expect(ids('duration', 'desc')).toEqual(['a', 'b', 'c', 'd']);
    expect(ids('importedAt', 'asc')).toEqual(['a', 'b', 'c', 'd']); expect(ids('importedAt', 'desc')).toEqual(['d', 'b', 'c', 'a']);
    expect(ids('rating', 'desc')).toEqual(['a', 'c', 'b', 'd']); expect(ids('rating', 'asc')).toEqual(['b', 'd', 'a', 'c']);
    expect(queryMedia(store, { sortBy: 'duration', offset: 1, limit: 2 })).toMatchObject({ total: 4, limit: 2, offset: 1, items: [{ assetId: 'b' }, { assetId: 'c' }] });
    expect(queryMedia(store, { offset: 100 })).toMatchObject({ total: 4, items: [] });
  });
  it('refuses malformed, unknown and dangling filters without history or events', () => {
    const { store } = searchable();
    for (const opts of [null, [], { typo: 'bad' }, { text: 3 }, { text: 'x'.repeat(4097) }, { text: 'x\0' },
      { kind: 'stream' }, { kind: null }, { binId: 'absent' }, { binId: 3 }, { includeDescendants: 'true' }, { includeDescendants: true },
      { sortBy: 'size' }, { sortBy: null }, { sortDirection: 'reverse' }, { sortDirection: null },
      { limit: null }, { limit: 0 }, { limit: 1001 }, { limit: 2.5 }, { offset: null }, { offset: -1 }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    ]) unchanged(store, () => queryMedia(store, opts as any));
    expect(queryMedia(store, { limit: 1000, offset: Number.MAX_SAFE_INTEGER }).items).toEqual([]);
  });
});

describe('optional schema-1 library validation and persistence', () => {
  const malformed: [string, (p: any) => void][] = [
    ['library null', (p) => p.mediaLibrary = null], ['version', (p) => p.mediaLibrary.version = 2],
    ['bins not array', (p) => p.mediaLibrary.bins = {}], ['entries not array', (p) => p.mediaLibrary.entries = {}],
    ['bin null', (p) => p.mediaLibrary.bins[0] = null], ['bin id', (p) => p.mediaLibrary.bins[0].id = ''],
    ['bin parent absent', (p) => delete p.mediaLibrary.bins[0].parentId], ['missing parent', (p) => p.mediaLibrary.bins[0].parentId = 'missing'],
    ['cycle', (p) => p.mediaLibrary.bins[0].parentId = 'bin'], ['bin name', (p) => p.mediaLibrary.bins[0].name = ''],
    ['duplicate bins', (p) => p.mediaLibrary.bins.push({ ...p.mediaLibrary.bins[0] })],
    ['duplicate sibling', (p) => p.mediaLibrary.bins.push({ ...p.mediaLibrary.bins[0], id: 'other', name: 'LIBRARY' })],
    ['entry null', (p) => p.mediaLibrary.entries[0] = null], ['entry asset missing', (p) => p.mediaLibrary.entries[0].assetId = 'missing'],
    ['entry duplicated', (p) => p.mediaLibrary.entries.push({ ...p.mediaLibrary.entries[0] })],
    ['entry bin missing', (p) => p.mediaLibrary.entries[0].binId = 'missing'], ['entry bin undefined', (p) => delete p.mediaLibrary.entries[0].binId],
    ['description missing', (p) => delete p.mediaLibrary.entries[0].description], ['tags null', (p) => p.mediaLibrary.entries[0].tags = null],
    ['rating missing', (p) => delete p.mediaLibrary.entries[0].rating], ['fractional rating', (p) => p.mediaLibrary.entries[0].rating = .5],
    ['identity null', (p) => p.media[0].sourceIdentity = null], ['identity hash uppercase', (p) => p.media[0].sourceIdentity.sha256 = 'A'.repeat(64)],
    ['identity short', (p) => p.media[0].sourceIdentity.sha256 = 'a'.repeat(63)], ['identity size missing', (p) => delete p.media[0].sourceIdentity.size],
    ['identity size negative', (p) => p.media[0].sourceIdentity.size = -1], ['identity size fractional', (p) => p.media[0].sourceIdentity.size = .5],
    ['identity size unsafe', (p) => p.media[0].sourceIdentity.size = Number.MAX_SAFE_INTEGER + 1],
  ];
  function extended(): Project {
    return { ...populated().project,
      media: [asset('sample', { sourceIdentity: { sha256: 'a'.repeat(64), size: 0 } })],
      mediaLibrary: { version: 1, bins: [{ id: 'bin', name: 'Library', parentId: null }],
        entries: [{ assetId: 'sample', binId: 'bin', description: '', tags: [], rating: 0 }] },
    };
  }
  it.each(malformed)('refuses malformed %s at constructor/load/mutation before clearing redo', (_name, corrupt) => {
    const project = extended(), store = new EditorStore(project);
    updateMediaMetadata(store, 'sample', { rating: 1 }); store.undo();
    const bad = structuredClone(project); corrupt(bad);
    unchanged(store, () => store.load(bad)); unchanged(store, () => store.mutate('media', [], () => bad));
    expect(() => new EditorStore(bad)).toThrow(EditorError); expect(store.redo()).toBe(true);
    expect(queryMedia(store).items[0]!.rating).toBe(1);
  });
  it('preserves legacy omission and unknown additive JSON while reading, default-editing, and saving', async () => {
    const project = populated().project, store = new EditorStore(project);
    const state = store.state;
    expect(queryMedia(store).items[0]).toMatchObject({ binId: null, description: '', tags: [], rating: 0 });
    expect(listMediaBins(store)).toEqual([]); assignMediaBin(store, ['sample'], null);
    updateMediaMetadata(store, 'sample', { description: '', tags: [], rating: 0 });
    expect(store.state).toBe(state); expect(store.project.mediaLibrary).toBeUndefined();
    updateMediaMetadata(store, 'sample', { name: 'Renamed' }); expect(store.project.mediaLibrary).toBeUndefined();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-library-'));
    try {
      const target = path.join(directory, 'legacy.palmier');
      const additive: any = { ...store.project, extra: { version: 'future' } };
      const file = await saveProject(additive, target); const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(parsed.version).toBe(1); expect(Object.hasOwn(parsed, 'mediaLibrary')).toBe(false);
      expect(await loadProject(target)).toEqual(additive);
      const extendedProject = extended(); expect(validateProject(extendedProject)).toBe(extendedProject);
      await saveProject(extendedProject, target); expect(await loadProject(target)).toEqual(extendedProject);
    } finally {
      expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects malformed extension saves before file writes and disk loads before replacement', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-library-'));
    try {
      const target = path.join(directory, 'project.freemier'), file = await saveProject(extended(), target), bytes = await fs.readFile(file);
      for (const [, corrupt] of malformed) {
        const bad = structuredClone(extended()); corrupt(bad);
        await expect(saveProject(bad, target)).rejects.toBeInstanceOf(EditorError);
        expect(await fs.readFile(file)).toEqual(bytes);
      }
      const bad = structuredClone(extended()); (bad as any).mediaLibrary.entries[0].binId = 'missing';
      await fs.writeFile(file, JSON.stringify(bad)); await expect(loadProject(target)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('immutable media location replacement', () => {
  it('switches once without changing asset facts, linked clips, effects, keys, bins or IDs and restores by undo', () => {
    const store = populated(), bin = createMediaBin(store, { name: 'Used' }); assignMediaBin(store, ['sample'], bin.id);
    const pair = addLinkedClip(store, { assetId: 'sample', videoTrackId: store.project.timeline.tracks[1]!.id,
      audioTrackId: store.project.timeline.tracks[0]!.id, start: 2, sourceIn: 1, duration: 3 });
    addEffect(store, pair.videoClip.id, 'blur', { radius: 2 }); setKeyframe(store, pair.videoClip.id, 'x', 1, .3);
    const before = store.project, original = before.media[0]!, revision = store.revision, events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    const identity = { sha256: 'b'.repeat(64), size: 42 };
    const replacement = replaceMediaLocation(store, 'sample', { path: 'media/recovered.mp4', copied: true, sourceIdentity: identity });
    expect(replacement).toEqual({ ...original, path: 'media/recovered.mp4', copied: true, sourceIdentity: identity });
    expect(store.project.timeline).toBe(before.timeline); expect(store.project.mediaLibrary).toBe(before.mediaLibrary);
    expect(store.revision).toBe(revision + 1); expect(events).toHaveLength(1);
    identity.size = 10; expect(replacement.sourceIdentity!.size).toBe(42);
    store.undo(); expect(store.project).toBe(before); store.redo();
    const state = store.state;
    replaceMediaLocation(store, 'sample', { path: 'media/recovered.mp4', copied: true }); expect(store.state).toBe(state);
    const next = replaceMediaLocation(store, 'sample', { path: '/verified/source.mp4', copied: false });
    expect(next.sourceIdentity).toEqual({ sha256: 'b'.repeat(64), size: 42 });
    unchanged(store, () => replaceMediaLocation(store, 'absent', { path: '/ok', copied: false }), 'NOT_FOUND');
    for (const opts of [{ path: '', copied: false }, { path: '../escape', copied: true }, { path: '/ok', copied: 'true' },
      { path: '/ok', copied: false, sourceIdentity: { sha256: 'bad', size: 42 } }, { path: '/ok', copied: false, duration: 999 },
    ]) unchanged(store, () => replaceMediaLocation(store, 'sample', opts as any));
  });
});
