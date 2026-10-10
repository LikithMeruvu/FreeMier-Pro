import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_WORKSPACE_LAYOUT } from '@freemier/shared/workspace';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let workspace: string, client: Client;
async function connect() {
  client = new Client({ name: 'workspace-settings-acceptance', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.FREEMIER_BRIDGE_PORT;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/mcp/dist/cli.js')], env: { ...env, FREEMIER_WORKSPACE: workspace } }));
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const value = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
  if (response.isError) throw Object.assign(new Error(value.error.message), value.error);
  return value;
}
const settings = async () => (await call('workspace_settings_get')).workspaceSettings;
beforeEach(async () => { workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-settings-mcp-')); await connect(); });
afterEach(async () => {
  await client?.close();
  if (workspace) {
    expect(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

describe('workspace preferences through a standard MCP client', () => {
  it('discovers seven descriptive commands and refuses invalid or stale settings without editing the project', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(102);
    const capabilities = (await call('editor_capabilities')).workspaceSettings;
    expect(capabilities.commands).toHaveLength(7);
    for (const name of capabilities.commands) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool.description!.length).toBeGreaterThan(80); expect(tool.inputSchema.type).toBe('object');
    }
    const defaults = await settings(), project = await call('project_info');
    expect(defaults).toMatchObject({ version: 1, revision: 0, current: DEFAULT_WORKSPACE_LAYOUT, layouts: [], readOnly: false });
    expect(await fs.readdir(workspace)).toEqual([]);
    for (const patch of [{ panels: { surprise: true } }, { libraryWidth: 421 }, { sourceRatio: null }, { timelineHeight: -1 }, { mode: 'missing' }, { arbitraryCSS: 'display:none' }])
      await expect(call('workspace_settings_update', { patch })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await settings()).toEqual(defaults);
    const changed = (await call('workspace_settings_update', { patch: { panels: { library: false }, timelineZoom: 72.5 }, expectedSettingsRevision: 0 })).workspaceSettings;
    expect(changed.revision).toBe(1);
    expect(changed.current.panels).toEqual({ library: false, source: true, inspector: true, transitions: true });
    expect(changed.current.timelineZoom).toBe(72.5);
    await expect(call('workspace_settings_update', { patch: { snap: false }, expectedSettingsRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await settings()).toEqual(changed);
    const noop = await call('workspace_settings_update', { patch: { timelineZoom: 72.5 }, expectedSettingsRevision: 1 });
    expect(noop.workspaceSettings).toEqual(changed);
    expect(await call('project_info')).toEqual(project);
  });

  it('saves, applies and deletes named layouts separately from portable projects and undo', async () => {
    const marker = (await call('marker_add', { time: 1, label: 'Keep edit' })).marker;
    await call('workspace_settings_update', { patch: { mode: 'color', browser: 'presets', sourceRatio: .7, timelineHeight: 220, grid: false } });
    const saved = await call('workspace_layout_save', { name: '  Cafe\u0301  ' });
    expect(saved.workspaceSettings.layouts[0]).toMatchObject({ id: saved.layoutId, name: 'Café' });
    const named = saved.workspaceSettings.layouts[0], afterSave = await settings();
    await expect(call('workspace_layout_save', { name: 'CAFÉ' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await settings()).toEqual(afterSave);
    const projectPath = path.join(workspace, 'Portable.freemier');
    await call('project_save', { path: projectPath });
    const projectFile = JSON.parse(await fs.readFile(path.join(projectPath, 'project.json'), 'utf8'));
    expect(projectFile).not.toHaveProperty('workspaceSettings'); expect(projectFile).not.toHaveProperty('workspaceLayouts');
    await call('workspace_settings_update', { patch: { mode: 'audio', panels: { source: false }, snap: false } });
    const changed = await settings(), before = await call('project_info');
    await call('project_update', { name: 'Temporary project' });
    await call('project_load', { path: projectPath });
    expect(await settings()).toEqual(changed); expect((await call('marker_list')).markers[0]).toMatchObject(marker);
    await call('marker_update', { markerId: marker.id, label: 'Changed edit' });
    await call('undo'); expect((await call('marker_list')).markers[0].label).toBe('Keep edit');
    await call('redo'); expect((await call('marker_list')).markers[0].label).toBe('Changed edit');
    expect(await settings()).toEqual(changed);
    const projectAfter = await call('project_info');
    const applied = (await call('workspace_layout_apply', { layoutId: saved.layoutId, expectedSettingsRevision: changed.revision })).workspaceSettings;
    expect(applied.current).toEqual(named.layout); expect(applied.layouts).toEqual([named]);
    expect((await call('workspace_layout_list')).layouts).toEqual([named]);
    await expect(call('workspace_layout_apply', { layoutId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const reset = (await call('workspace_settings_reset')).workspaceSettings;
    expect(reset.current).toEqual(DEFAULT_WORKSPACE_LAYOUT); expect(reset.layouts).toEqual([named]);
    const deleted = (await call('workspace_layout_delete', { layoutId: saved.layoutId })).workspaceSettings;
    expect(deleted.current).toEqual(reset.current); expect(deleted.layouts).toEqual([]);
    await expect(call('workspace_layout_delete', { layoutId: saved.layoutId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await call('project_info')).toEqual(projectAfter); expect(before.id).toBe(projectAfter.id);
  });

  it('restores the same settings revision and named IDs after a real headless process restart', async () => {
    await call('workspace_settings_update', { patch: { mode: 'audio', inspectorWidth: 420, timelineZoom: 63.75, panels: { transitions: false } } });
    await call('workspace_layout_save', { name: 'Audio desk' });
    const first = await settings(), file = path.join(workspace, 'settings', 'workspace.json'), bytes = await fs.readFile(file);
    await client.close(); await connect();
    const reopened = await settings();
    expect(reopened.epoch).not.toBe(first.epoch);
    expect(reopened).toEqual({ ...first, epoch: reopened.epoch });
    expect(await fs.readFile(file)).toEqual(bytes);
    expect((await call('project_info')).revision).toBe(0);
  });

  it.each(['malformed', 'future version'])('preserves %s bytes until explicit backed-up recovery', async kind => {
    await client.close();
    const directory = path.join(workspace, 'settings'), file = path.join(directory, 'workspace.json');
    const original = kind === 'malformed' ? '{ broken settings\n' : JSON.stringify({ version: 9, revision: 37, current: DEFAULT_WORKSPACE_LAYOUT, layouts: [] });
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(file, original);
    await connect();
    const blocked = await settings();
    expect(blocked.readOnly).toBe(true); expect(blocked.persistenceError.length).toBeGreaterThan(0);
    await expect(call('workspace_settings_update', { patch: { snap: false } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call('workspace_layout_save', { name: 'Do not write' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    const reset = (await call('workspace_settings_reset', { expectedSettingsRevision: blocked.revision })).workspaceSettings;
    expect(reset.readOnly).toBe(false); expect(reset.current).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    const backups = (await fs.readdir(directory)).filter(name => name !== 'workspace.json');
    expect(backups).toHaveLength(1); expect(await fs.readFile(path.join(directory, backups[0]!), 'utf8')).toBe(original);
    await client.close(); await connect();
    const reopened = await settings();
    expect(reopened).toEqual({ ...reset, epoch: reopened.epoch });
    expect((await call('project_info')).revision).toBe(0);
  });
});
