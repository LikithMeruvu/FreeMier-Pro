import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorStore, ProjectProtectionTracker, createEmptyProject, projectContentDigest } from '../../src/index.js';
import { loadProject, saveProject } from '../../src/project/persistence.js';

describe('project protection tracker', () => {
  it('tracks dirty baseline equality across edit, undo and redo with monotonic tokens', () => {
    const store = EditorStore.create(), tracker = new ProjectProtectionTracker(store);
    const clean = tracker.snapshot();
    store.mutate('project', [], (project) => ({ ...project, name: 'Changed' }));
    const dirty = tracker.snapshot();
    expect(dirty.dirty).toBe(true); expect(dirty.generation).toBeGreaterThan(clean.generation);
    expect(store.undo()).toBe(true);
    const undone = tracker.snapshot();
    expect(undone.dirty).toBe(false); expect(undone.token).not.toBe(dirty.token);
    expect(store.redo()).toBe(true); expect(tracker.snapshot().dirty).toBe(true);
    store.undo();
    const receipt = tracker.captureSave();
    const saved = tracker.acknowledgeSave(receipt, '/tmp/saved.freemier/project.json');
    expect(saved.dirty).toBe(false);
    const saveToken = saved.token, saveGeneration = saved.generation;
    store.mutate('project', [], (project) => ({ ...project, name: 'Temporary edit' }));
    expect(tracker.snapshot().dirty).toBe(true);
    expect(store.undo()).toBe(true);
    expect(tracker.snapshot().dirty).toBe(false);
    expect(tracker.snapshot().token).not.toBe(saveToken);
    expect(tracker.snapshot().generation).toBeGreaterThan(saveGeneration);
    expect(store.redo()).toBe(true);
    expect(tracker.snapshot().dirty).toBe(true);
    tracker.dispose();
  });

  it('acknowledges the captured save while preserving newer concurrent edits as dirty', () => {
    const store = EditorStore.create(), tracker = new ProjectProtectionTracker(store);
    store.mutate('project', [], (project) => ({ ...project, name: 'Saved version' }));
    const receipt = tracker.captureSave();
    store.mutate('project', [], (project) => ({ ...project, name: 'Newer edit' }));
    const result = tracker.acknowledgeSave(receipt, '/tmp/saved.freemier/project.json');
    expect(result.savedTo).toBe('/tmp/saved.freemier/project.json');
    expect(result.token).toBe(tracker.snapshot().token);
    expect(result.token).not.toBe(receipt.token);
    expect(result.dirty).toBe(true);
    expect(receipt.project.name).toBe('Saved version');
    expect(Object.isFrozen(receipt.project)).toBe(true);
    tracker.dispose();
  });

  it('ignores a late receipt after load, invalidates old tokens and marks recovery dirty', () => {
    const store = EditorStore.create(), tracker = new ProjectProtectionTracker(store);
    const receipt = tracker.captureSave(), token = tracker.snapshot().token;
    const loads = store.loadGeneration;
    store.load(createEmptyProject({ name: 'Replacement' }));
    expect(store.loadGeneration).toBe(loads + 1);
    expect(() => tracker.assertReplacement(token)).toThrow(/changed/);
    expect(tracker.snapshot().dirty).toBe(false);
    const afterLateSave = tracker.acknowledgeSave(receipt, '/tmp/old/project.json');
    expect(afterLateSave.savedTo).toBeUndefined();
    const loadedGeneration = tracker.snapshot().generation;
    store.mutate('project', [], (project) => ({ ...project, name: 'Post-load edit' }));
    const loadGeneration = store.loadGeneration;
    expect(store.undo()).toBe(true);
    expect(store.loadGeneration).toBe(loadGeneration);
    expect(tracker.snapshot().generation).toBeGreaterThan(loadedGeneration);
    expect(tracker.snapshot().dirty).toBe(false);
    expect(tracker.markRecovered().dirty).toBe(true);
    const recovered = tracker.captureSave();
    expect(tracker.acknowledgeSave(recovered, '/tmp/recovered.freemier/project.json').dirty).toBe(false);
    tracker.dispose();
  });

  it('checks expected tokens and requires discard consent only while dirty', () => {
    const store = EditorStore.create(), tracker = new ProjectProtectionTracker(store);
    const token = tracker.snapshot().token;
    expect(() => tracker.assertReplacement(token)).not.toThrow();
    store.mutate('project', [], (project) => ({ ...project, name: 'Unsaved' }));
    expect(() => tracker.assertReplacement(tracker.snapshot().token)).toThrow(/unsaved/);
    expect(() => tracker.assertReplacement(tracker.snapshot().token, true)).not.toThrow();
    tracker.dispose();
  });

  it('canonical digest ignores updatedAt and object-key order', () => {
    const project = createEmptyProject();
    expect(projectContentDigest({ ...project, updatedAt: project.updatedAt + 5 })).toBe(projectContentDigest(project));
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
      return value;
    };
    expect(projectContentDigest(reverseKeys(project) as typeof project)).toBe(projectContentDigest(project));
  });

  it('publishes successive snapshots atomically and preserves an existing target after rename failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-protection-'));
    try {
      const projectPath = path.join(root, 'concurrent');
      const first = createEmptyProject({ name: 'First' }), second = createEmptyProject({ name: 'Second' });
      await saveProject(first, projectPath);
      await saveProject(second, projectPath);
      const loaded = await loadProject(projectPath);
      expect(loaded.name).toBe('Second');
      const directory = path.join(root, 'blocked.freemier');
      await fs.mkdir(path.join(directory, 'cache'), { recursive: true });
      const target = path.join(directory, 'project.json');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'keep.txt'), 'preserve');
      await expect(saveProject(createEmptyProject(), directory)).rejects.toThrow();
      expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('preserve');
      expect((await fs.readdir(directory)).filter((name) => name.startsWith('project.json.tmp-'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlink or junction ancestors, cache folders, and project targets before publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-links-'));
    try {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      const externalFile = path.join(outside, 'project.json');
      await fs.writeFile(externalFile, 'outside bytes');
      const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

      const linkedProject = path.join(root, 'linked.freemier');
      await fs.symlink(outside, linkedProject, linkKind);
      await expect(saveProject(createEmptyProject(), linkedProject)).rejects.toThrow(/linked|ancestor/);

      const linkedCacheProject = path.join(root, 'linked-cache.freemier');
      await fs.mkdir(linkedCacheProject);
      await fs.symlink(outside, path.join(linkedCacheProject, 'cache'), linkKind);
      await expect(saveProject(createEmptyProject(), linkedCacheProject)).rejects.toThrow(/linked|ancestor/);

      const linkedTargetProject = path.join(root, 'linked-target.freemier');
      await fs.mkdir(path.join(linkedTargetProject, 'cache'), { recursive: true });
      await fs.link(externalFile, path.join(linkedTargetProject, 'project.json'));
      await expect(saveProject(createEmptyProject(), linkedTargetProject)).rejects.toThrow(/regular unlinked file/);

      const blockedProject = path.join(root, 'blocked.freemier');
      await fs.mkdir(path.join(blockedProject, 'cache'), { recursive: true });
      await fs.mkdir(path.join(blockedProject, 'project.json'));
      await fs.writeFile(path.join(blockedProject, 'project.json', 'keep.txt'), 'preserve');
      await expect(saveProject(createEmptyProject(), blockedProject)).rejects.toThrow(/regular unlinked file/);
      expect(await fs.readFile(path.join(blockedProject, 'project.json', 'keep.txt'), 'utf8')).toBe('preserve');
      expect(await fs.readFile(externalFile, 'utf8')).toBe('outside bytes');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not remove a replacement file at the owned temporary path after a failed rename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-temp-owner-'));
    let foreignTemp: string | undefined;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source) => {
      foreignTemp = String(source);
      await fs.unlink(source);
      await fs.writeFile(source, 'foreign temp');
      throw new Error('injected rename failure');
    });
    try {
      await expect(saveProject(createEmptyProject(), path.join(root, 'failed'))).rejects.toThrow(/injected/);
      expect(foreignTemp).toBeDefined();
      expect(await fs.readFile(foreignTemp!, 'utf8')).toBe('foreign temp');
    } finally {
      rename.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
