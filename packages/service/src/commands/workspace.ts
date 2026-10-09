import { z } from 'zod';
import type { WorkspaceLayoutPatch } from '@freemier/shared/workspace';
import { getWorkspaceSettingsOwner } from '../settings/workspace.js';
import type { CommandContext, CommandDefinition } from './context.js';
import { ok } from './helpers.js';

const expected = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  .describe('Refuse if the workspace settings revision changed. This is separate from the project revision and undo history.');
const panels = z.object({ library: z.boolean(), source: z.boolean(), inspector: z.boolean(), transitions: z.boolean() }).partial().strict();
const patch = z.object({
  mode: z.enum(['edit', 'color', 'audio']),
  browser: z.enum(['project', 'effects', 'presets', 'markers', 'titles', 'captions']),
  panels,
  libraryWidth: z.number().int().min(180).max(420),
  inspectorWidth: z.number().int().min(220).max(520),
  timelineHeight: z.number().int().min(180).max(560).nullable(),
  sourceRatio: z.number().min(.2).max(.8),
  timelineZoom: z.number().min(20).max(300),
  snap: z.boolean(), grid: z.boolean(),
}).partial().strict().describe('Change only these user layout fields; panel flags merge with the current layout. null timelineHeight restores responsive automatic sizing.');
const layoutId = z.string().min(1).max(128).describe('Stable saved layout ID returned by workspace_layout_list or workspace_layout_save');
async function owner(ctx: CommandContext) {
  const settings = ctx.workspaceSettings ?? getWorkspaceSettingsOwner(ctx.workspace);
  await settings.ready;
  return settings;
}

export const WORKSPACE_CAPABILITIES = {
  commands: ['workspace_settings_get', 'workspace_settings_update', 'workspace_settings_reset', 'workspace_layout_list', 'workspace_layout_save', 'workspace_layout_apply', 'workspace_layout_delete'],
  storage: 'user workspace/settings/workspace.json, outside video project files',
  maxLayouts: 24, maxNameCharacters: 48,
  modes: ['edit', 'color', 'audio'],
  panels: ['library', 'source', 'inspector', 'transitions'],
  alwaysVisible: ['program monitor', 'timeline', 'workspace settings entry'],
  sizing: { libraryWidth: [180, 420], inspectorWidth: [220, 520], timelineHeight: [180, 560], automaticTimelineHeight: null, sourceRatio: [.2, .8], timelineZoom: [20, 300] },
  history: 'independent settings revision; no project edit or undo entry',
  recovery: 'invalid settings stay read-only and unchanged until explicit reset makes an exclusive backup',
  concurrency: 'one serialized owner per resolved settings path in this process; optional expectedSettingsRevision',
  unsupported: ['floating panels', 'arbitrary CSS or panel scripts', 'vendor workspace import', 'custom themes', 'custom keyboard mappings', 'coordination with external file writers'],
};

export const WORKSPACE_COMMANDS: CommandDefinition[] = [
  {
    name: 'workspace_settings_get', title: 'Read workspace settings',
    description: 'Read the current user panel layout, saved named layouts, settings revision and recovery warning without changing files or project history. These preferences are independent of the video project.',
    inputSchema: {}, handler: async (_, ctx) => ok({ workspaceSettings: (await owner(ctx)).snapshot() }),
  },
  {
    name: 'workspace_settings_update', title: 'Change workspace settings',
    description: 'Persist selected panel visibility, sizes, workspace mode, browser tab, snap, grid and timeline zoom. Uses a separate settings revision and updates the live GUI without changing the project or its undo history.',
    inputSchema: { patch, expectedSettingsRevision: expected },
    handler: async (a, ctx) => ok({ workspaceSettings: await (await owner(ctx)).update(a.patch as WorkspaceLayoutPatch, a.expectedSettingsRevision as number | undefined) }),
  },
  {
    name: 'workspace_settings_reset', title: 'Restore workspace defaults',
    description: 'Restore the default panel layout while keeping valid saved named layouts. If the settings file is invalid, explicitly back up its original bytes before replacing it with defaults. A failed backup leaves the original untouched.',
    inputSchema: { expectedSettingsRevision: expected },
    handler: async (a, ctx) => ok({ workspaceSettings: await (await owner(ctx)).reset(a.expectedSettingsRevision as number | undefined) }),
  },
  {
    name: 'workspace_layout_list', title: 'List saved workspace layouts',
    description: 'Read up to 24 saved named panel layouts with stable IDs, along with the current settings snapshot and independent revision. Listing does not write files, change the current layout or alter project history.',
    inputSchema: {}, handler: async (_, ctx) => { const snapshot = (await owner(ctx)).snapshot(); return ok({ workspaceSettings: snapshot, layouts: snapshot.layouts }); },
  },
  {
    name: 'workspace_layout_save', title: 'Save a named workspace layout',
    description: 'Save the current user layout under a trimmed, normalized name of up to 48 characters. Names are unique without regard to letter case; up to 24 layouts are supported. This saves panel preferences, not the video project.',
    inputSchema: { name: z.string().min(1).max(256), expectedSettingsRevision: expected },
    handler: async (a, ctx) => ok(await (await owner(ctx)).saveLayout(a.name as string, a.expectedSettingsRevision as number | undefined)),
  },
  {
    name: 'workspace_layout_apply', title: 'Apply a saved workspace layout',
    description: 'Make a saved layout the current user layout, persist it and update the live GUI. The named record stays available and the video project, playback plan and undo history are unchanged. Unknown IDs are refused.',
    inputSchema: { layoutId, expectedSettingsRevision: expected },
    handler: async (a, ctx) => ok({ workspaceSettings: await (await owner(ctx)).applyLayout(a.layoutId as string, a.expectedSettingsRevision as number | undefined) }),
  },
  {
    name: 'workspace_layout_delete', title: 'Delete a saved workspace layout',
    description: 'Remove one saved named layout by its stable ID. The current panel arrangement remains as it is, even if it came from that record. This does not remove media, edit the video project or add a project undo entry.',
    inputSchema: { layoutId, expectedSettingsRevision: expected },
    handler: async (a, ctx) => ok({ workspaceSettings: await (await owner(ctx)).deleteLayout(a.layoutId as string, a.expectedSettingsRevision as number | undefined) }),
  },
];
