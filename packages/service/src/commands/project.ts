import { timelineDuration } from '@freemier/engine';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';
import { ok } from './helpers.js';
import { loadOwnedProject, saveOwnedProject } from '../persistence/projects.js';
import { updateProjectSettings, reorderTrack } from '@freemier/engine';

export const PROJECT_COMMANDS: CommandDefinition[] = [
  {
    name: 'project_info',
    title: 'Project info',
    description:
      'Get the current project: name, id, resolution, fps, duration, media count, and track count. Start here to learn what is loaded.',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const p = ctx.store.project;
      return ok({
        id: p.id,
        name: p.name,
        fps: p.timeline.fps,
        width: p.timeline.width,
        height: p.timeline.height,
        duration: timelineDuration(p.timeline),
        mediaCount: p.media.length,
        trackCount: p.timeline.tracks.length,
        revision: ctx.store.revision,
        canUndo: ctx.store.canUndo,
        canRedo: ctx.store.canRedo,
      });
    },
  },
  {
    name: 'project_create',
    title: 'Create project',
    description: 'Legacy destructive replacement: create a new empty project and discard the current timeline without checking unsaved edits. Prefer project_replace with the current protection token for guarded replacement.',
    inputSchema: {
      name: z.string().optional().describe('Project name'),
      fps: z.number().positive().optional().describe('Frame rate, default 30'),
      width: z.number().int().positive().optional().describe('Output width, default 1920'),
      height: z.number().int().positive().optional().describe('Output height, default 1080'),
    },
    handler: async (a, ctx) => {
      const { EditorStore: Store, createEmptyProject } = await import('@freemier/engine');
      const project = createEmptyProject({
        name: a.name as string | undefined,
        fps: a.fps as number | undefined,
        width: a.width as number | undefined,
        height: a.height as number | undefined,
      });
      ctx.store.load(project);
      ctx.notify({ kind: 'project', ids: [project.id] });
      return ok({ id: project.id, name: project.name });
    },
  },
  {
    name: 'project_update', title: 'Update project settings',
    description: 'Change the project name or output dimensions. Frame rate changes are refused while timing-authored content exists.',
    inputSchema: {
      name: z.string().min(1).max(120).optional(),
      width: z.number().int().min(1).max(8192).optional(),
      height: z.number().int().min(1).max(8192).optional(),
      fps: z.number().min(1).max(240).optional(),
    },
    handler: async (a, ctx) => {
      const project = updateProjectSettings(ctx.store, a as { name?: string; width?: number; height?: number; fps?: number });
      ctx.notify({ kind: 'project', ids: [project.id] });
      return ok({ id: project.id, name: project.name, width: project.timeline.width, height: project.timeline.height, fps: project.timeline.fps });
    },
  },
  {
    name: 'track_reorder', title: 'Reorder track',
    description: 'Move a track one visible position up or down atomically. Both tracks must be unlocked.',
    inputSchema: { trackId: z.string(), direction: z.enum(['up', 'down']) },
    handler: async (a, ctx) => {
      const moved = reorderTrack(ctx.store, a.trackId as string, a.direction as 'up' | 'down');
      ctx.notify({ kind: 'track', ids: [a.trackId as string] });
      return ok({ moved, trackId: a.trackId });
    },
  },
  {
    name: 'project_save',
    title: 'Save project',
    description: 'Publish the captured project snapshot and verified copied media. Returns a save receipt and protection state; edits made during I/O remain unsaved. Defaults to <workspace>/project.freemier. Legacy .palmier paths are supported.',
    inputSchema: { path: z.string().optional().describe('Destination project directory') },
    handler: saveOwnedProject,
  },
  {
    name: 'project_load',
    title: 'Load project',
    description: 'Legacy destructive replacement: load a .freemier or .palmier project without an unsaved-work guard. Prefer project_replace with the current protection token for guarded loading.',
    inputSchema: { path: z.string().describe('Path to the project directory') },
    handler: loadOwnedProject,
  }
];
