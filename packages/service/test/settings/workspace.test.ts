import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WORKSPACE_LAYOUT } from '@freemier/shared/workspace';
import { WorkspaceSettingsOwner, getWorkspaceSettingsOwner } from '../../src/settings/workspace.js';
import { createSession } from '../../src/session/session.js';
import { LiveBridge } from '../../src/connection/bridge.js';

let root: string;
const settingsFile = () => path.join(root, 'settings', 'workspace.json');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-settings-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  await fs.rm(root, { recursive: true, force: true });
});
async function owner() { const value = new WorkspaceSettingsOwner(root); await value.ready; return value; }
async function seed(value: unknown) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('WorkspaceSettingsOwner', () => {
  it('bootstraps without creating directories and shares case/relative aliases', async () => {
    const absent = path.join(root, 'absent');
    const value = getWorkspaceSettingsOwner(absent); await value.ready;
    await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(value.snapshot().current).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(Object.isFrozen(value.snapshot().current.panels)).toBe(true);
    expect(getWorkspaceSettingsOwner(path.join(absent, '..', 'absent'))).toBe(value);
    if (process.platform === 'win32') expect(getWorkspaceSettingsOwner(absent.toUpperCase())).toBe(value);
  });

  it('persists partial layouts, fractional zoom and named snapshots across restart', async () => {
    const value = await owner();
    await value.update({ mode: 'color', timelineZoom: 91.25, panels: { source: false } }, 0);
    const saved = await value.saveLayout('  Color desk  ', 1);
    await value.reset(2);
    expect(value.snapshot().current).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(value.snapshot().layouts).toHaveLength(1);
    await value.applyLayout(saved.layoutId, 3);
    const fresh = await owner();
    expect(fresh.snapshot()).toMatchObject({ revision: 4, current: { mode: 'color', timelineZoom: 91.25, panels: { source: false, library: true } } });
    expect(fresh.snapshot().epoch).not.toBe(value.snapshot().epoch);
    expect(fresh.snapshot().layouts[0]).toMatchObject({ id: saved.layoutId, name: 'Color desk' });
    await expect(fresh.saveLayout('COLOR DESK')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(fresh.applyLayout('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fresh.deleteLayout('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await fresh.deleteLayout(saved.layoutId, 4);
    expect(fresh.snapshot().layouts).toEqual([]);
  });

  it('rejects invalid patches and makes no-op updates silent without ignoring stale revisions', async () => {
    const value = await owner(), listener = vi.fn(); value.subscribe(listener);
    const rename = vi.spyOn(fs, 'rename');
    await value.update({ snap: true }, 0);
    expect(rename).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
    for (const patch of [{ unknown: true }, { timelineZoom: NaN }, { libraryWidth: 179 }, { panels: { unknown: false } }])
      await expect(value.update(patch as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await value.update({ snap: false }, 0);
    const bytes = await fs.readFile(settingsFile(), 'utf8');
    await value.update({ snap: false }, 1);
    await expect(value.update({ snap: false }, 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(bytes);
    expect(rename).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledTimes(1);
  });

  it('checks expected revision inside the queue and publishes only after rename', async () => {
    const value = await owner(), listener = vi.fn(); value.subscribe(listener);
    const original = fs.rename.bind(fs);
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => { started(); await gate; await original(from, to); });
    const first = value.update({ snap: false }, 0);
    await entered;
    const second = value.update({ grid: false }, 0);
    const refused = expect(second).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(value.snapshot().revision).toBe(0); expect(listener).not.toHaveBeenCalled();
    release(); await first; await refused;
    await value.update({ grid: false }, 1);
    expect(value.snapshot().revision).toBe(2);
  });

  it.each(['open', 'write', 'sync', 'rename'] as const)('preserves committed state after %s failure and permits retry', async stage => {
    const value = await owner(); await value.update({ snap: false });
    const before = value.snapshot(), bytes = await fs.readFile(settingsFile(), 'utf8'), listener = vi.fn(); value.subscribe(listener);
    const fault = Object.assign(new Error('injected'), { code: 'EIO' });
    if (stage === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(fault);
    else {
      const original = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
        if (stage === 'open') throw fault;
        const handle = await original(...args);
        vi.spyOn(handle, stage === 'write' ? 'writeFile' : 'sync').mockRejectedValueOnce(fault);
        return handle;
      });
    }
    await expect(value.update({ grid: false })).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(value.snapshot()).toEqual(before); expect(listener).not.toHaveBeenCalled();
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(bytes);
    expect(await fs.readdir(path.dirname(settingsFile()))).toEqual(['workspace.json']);
    vi.restoreAllMocks(); await value.update({ grid: false }); expect(value.snapshot().revision).toBe(2);
  });

  it('isolates throwing listeners from committed mutations and subsequent writes', async () => {
    const value = await owner(), good = vi.fn();
    value.subscribe(() => { throw new Error('viewer failed'); }); value.subscribe(good);
    await value.update({ snap: false }); await value.update({ grid: false });
    expect(good).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8')).revision).toBe(2);
  });

  it.each(['{bad json', JSON.stringify({ version: 2, revision: 9 })])('preserves unsupported bytes until explicit backed-up recovery', async bytes => {
    await seed(bytes); const value = await owner();
    expect(value.snapshot()).toMatchObject({ readOnly: true, revision: 0 });
    for (const operation of [() => value.update({ snap: false }), () => value.saveLayout('desk'), () => value.applyLayout('missing'), () => value.deleteLayout('missing')])
      await expect(operation()).rejects.toMatchObject({ code: 'CONFLICT' });
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('backup denied'), { code: 'EACCES' }));
    await expect(value.reset()).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(bytes); expect(value.snapshot().readOnly).toBe(true);
    await value.reset(0);
    const backup = (await fs.readdir(path.dirname(settingsFile()))).find(name => name.startsWith('workspace-recovery-'))!;
    expect(await fs.readFile(path.join(path.dirname(settingsFile()), backup), 'utf8')).toBe(bytes);
    expect(value.snapshot()).toMatchObject({ readOnly: false, revision: 1, current: DEFAULT_WORKSPACE_LAYOUT });
  });

  it('refuses settings directory links before bootstrap and recovery writes', async () => {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'unchanged');
    await fs.symlink(outside, path.join(root, 'settings'), process.platform === 'win32' ? 'junction' : 'dir');
    const value = await owner(); expect(value.snapshot().readOnly).toBe(true);
    await expect(value.reset()).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(await fs.readdir(outside)).toEqual(['sentinel']);
  });

  it('bounds an opened file that grows after metadata inspection and rejects invalid UTF-8', async () => {
    await seed({ version: 1, revision: 0, current: DEFAULT_WORKSPACE_LAYOUT, layouts: [] });
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args), stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const metadata = await stat();
        await fs.appendFile(settingsFile(), Buffer.alloc(1024 * 1024, 32));
        return metadata;
      });
      return handle;
    });
    const grown = await owner(); expect(grown.snapshot().readOnly).toBe(true);
    expect(grown.snapshot().persistenceError).toContain('size');
    vi.restoreAllMocks();
    await fs.writeFile(settingsFile(), Buffer.from([0xff, 0xfe, 0x7b]));
    const invalid = await owner(); expect(invalid.snapshot().readOnly).toBe(true);
    expect(await fs.readFile(settingsFile())).toEqual(Buffer.from([0xff, 0xfe, 0x7b]));
  });

  it('refuses a directory replacement after closing the temp without touching the new target', async () => {
    const value = await owner(), listener = vi.fn(); value.subscribe(listener);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'unchanged');
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args), close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        await fs.rename(path.join(root, 'settings'), path.join(root, 'settings-moved'));
        await fs.symlink(outside, path.join(root, 'settings'), process.platform === 'win32' ? 'junction' : 'dir');
      });
      return handle;
    });
    await expect(value.update({ snap: false })).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(value.snapshot().revision).toBe(0); expect(listener).not.toHaveBeenCalled();
    expect(await fs.readdir(outside)).toEqual(['sentinel']);
    // Uncertain old paths are deliberately preserved instead of deleting through a replacement link.
    expect((await fs.readdir(path.join(root, 'settings-moved'))).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
  });

  it('enforces the named layout limit without altering the file', async () => {
    await seed({ version: 1, revision: 4, current: DEFAULT_WORKSPACE_LAYOUT,
      layouts: Array.from({ length: 24 }, (_, i) => ({ id: `layout_${i}`, name: `Desk ${i}`, layout: DEFAULT_WORKSPACE_LAYOUT })) });
    const value = await owner(), bytes = await fs.readFile(settingsFile(), 'utf8');
    await expect(value.saveLayout('extra')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(bytes);
  });
});

describe('workspace settings adapters', () => {
  it('shares the session owner and broadcasts settings independently of project history', async () => {
    const session = createSession({ workspace: root });
    expect(createSession({ workspace: root }).workspaceSettings).toBe(session.workspaceSettings);
    expect(session.context.workspaceSettings).toBe(session.workspaceSettings);
    await session.workspaceSettings.update({ mode: 'audio' });
    const bridge = new LiveBridge({ store: session.store, workspace: root, port: 0 });
    const base = `http://127.0.0.1:${await bridge.start()}`, abort = new AbortController();
    try {
      const before = await (await fetch(`${base}/state`)).json();
      expect(before.workspaceSettings.current.mode).toBe('audio');
      const response = await fetch(`${base}/events`, { signal: abort.signal });
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
      const event = async () => {
        while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended'); buffer += decoder.decode(chunk.value, { stream: true }); }
        const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        return data ? JSON.parse(data.slice(6)) : event();
      };
      const initial = await event(); expect(initial.state.workspaceSettings.revision).toBe(1);
      await session.workspaceSettings.update({ grid: false }, 1);
      expect(await event()).toMatchObject({ type: 'workspace-settings', workspaceSettings: { revision: 2, current: { grid: false } } });
      const after = await (await fetch(`${base}/state`)).json();
      expect(after.project).toEqual(before.project);
      for (const key of ['revision', 'eventSequence', 'eventEpoch', 'canUndo', 'canRedo']) expect(after[key]).toEqual(before[key]);
      expect(session.store.canUndo).toBe(false);
    } finally { abort.abort(); await bridge.stop(); }
  }, 15000);
});
