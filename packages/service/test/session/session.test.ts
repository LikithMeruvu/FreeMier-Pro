import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { EditorStore, addMarker, updateMarker } from '@freemier/engine';
import { createServer } from '@freemier/mcp';
import { createSession, LiveBridge } from '../../src/index.js';
import { callTool } from '../../../mcp/src/tools/call.js';

let bridge: LiveBridge | undefined;
afterEach(async () => { await bridge?.stop(); bridge = undefined; });

describe('one editing session across adapters', () => {
  it('uses one resolved default workspace and accepts an existing owner', () => {
    const store = EditorStore.create();
    const session = createSession({ store });
    const mcp = createServer({ store });
    expect(session.store).toBe(store);
    expect(mcp.store).toBe(store);
    expect(session.workspace).toBe(path.resolve(os.homedir(), '.freemier'));
    expect(mcp.context.workspace).toBe(session.workspace);
  });

  it('shares commands, undo and atomic refusals between MCP and the GUI bridge', async () => {
    const store = EditorStore.create({ name: 'Shared owner' });
    const session = createSession({ store, workspace: '.' });
    const mcp = createServer({ store, workspace: session.workspace });
    bridge = new LiveBridge({ store: session.store, workspace: session.workspace, port: 0 });
    const port = await bridge.start(), base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(base + '/health')).json() as { workspace: string };
    expect(health.workspace).toBe(mcp.context.workspace);
    const result = await callTool({ params: { name: 'marker_add', arguments: { time: 1, label: 'From AI' } } }, mcp.context);
    const marker = JSON.parse(result.content[0]!.text).marker as { id: string };
    expect(store.project.timeline.markers![0]!.label).toBe('From AI');
    const gui = await (await fetch(base + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'marker_update', markerId: marker.id, label: 'From screen' }) })).json() as { ok: boolean };
    expect(gui.ok).toBe(true);
    expect(mcp.store.project.timeline.markers![0]!.label).toBe('From screen');
    const before = store.state;
    const invalid = await callTool({ params: { name: 'marker_update', arguments: { markerId: marker.id, time: -1 } } }, mcp.context);
    expect(invalid.isError).toBe(true);
    expect(store.state).toBe(before);
    await callTool({ params: { name: 'undo' } }, mcp.context);
    const snapshot = await (await fetch(base + '/state')).json() as { project: { timeline: { markers: Array<{ label: string }> } } };
    expect(snapshot.project.timeline.markers[0]!.label).toBe('From AI');
  });

  it('keeps bounded history and drops a redo branch after a new edit', () => {
    const store = new EditorStore(EditorStore.create().project, 2);
    const marker = addMarker(store, { time: 1, label: 'One' });
    updateMarker(store, marker.id, { label: 'Two' });
    updateMarker(store, marker.id, { label: 'Three' });
    expect(store.undo()).toBe(true);
    expect(store.project.timeline.markers![0]!.label).toBe('Two');
    expect(store.undo()).toBe(true);
    expect(store.project.timeline.markers![0]!.label).toBe('One');
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(true);
    updateMarker(store, marker.id, { label: 'New branch' });
    expect(store.canRedo).toBe(false);
    expect(store.undo()).toBe(true);
    expect(store.project.timeline.markers![0]!.label).toBe('Two');
  });
});
