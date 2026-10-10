import { createEmptyProject } from '@freemier/engine';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import { getProjectProtectionOwner } from '../recovery/protection.js';
import { loadOwnedProject } from '../persistence/projects.js';
import type { CommandContext, CommandDefinition } from './context.js';
import { ok } from './helpers.js';

const recoveryId = z.string().uuid().describe('Opaque ID returned by project_recovery_list; never a file path');
const protectionToken = z.string().min(1).max(256).describe('Exact token from project_protection_get; refuses intervening edits or project replacement');
const discardUnsaved = z.boolean().optional().describe('Explicitly allow replacing dirty work; defaults to false and still requires the current token');
const patch = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(10).max(3600).optional(),
  retention: z.number().int().min(1).max(50).optional(),
}).strict().describe('Merge only these autosave fields; changes do not edit the project or undo history');

async function owner(ctx: CommandContext) {
  const protection = ctx.projectProtection ?? getProjectProtectionOwner(ctx.store, ctx.workspace);
  await protection.ready;
  return protection;
}

export const PROTECTION_CAPABILITIES = {
  commands: ['project_protection_get', 'project_protection_configure', 'project_recovery_create', 'project_recovery_list', 'project_recovery_inspect', 'project_recovery_restore', 'project_recovery_delete', 'project_replace'],
  autosave: { enabledByDefault: true, intervalSeconds: [10, 3600], defaultIntervalSeconds: 60, retention: [1, 50], defaultRetention: 10 },
  savedState: 'Content equality against the published snapshot; undo revisions do not determine whether work is saved',
  recovery: 'Completed immutable packages; copied media is owned and verified, external media remains an inspectable external reference',
  replacement: 'Use project_replace or project_recovery_restore with the current protection token and explicit discard consent when dirty',
  legacyReplacement: 'project_create and project_load keep their explicitly destructive replacement behavior for backward compatibility',
  close: 'Standalone Save/Discard/Cancel; viewer close detaches while the owning MCP session continues; forced termination cannot prompt',
  limitations: ['Completed recovery generations only', 'No universal power-loss guarantee', 'No external-writer locking or cloud backup'],
};

export const PROTECTION_COMMANDS: CommandDefinition[] = [
  {
    name: 'project_protection_get', title: 'Project protection status',
    description: 'Read whether the current project matches its saved content, the monotonic protection token, saved path, autosave settings and last completed recovery. This never changes project history.',
    inputSchema: {},
    handler: async (_a, ctx) => ok({ projectProtection: (await owner(ctx)).snapshot() }),
  },
  {
    name: 'project_protection_configure', title: 'Configure autosave',
    description: 'Persist autosave enablement, interval and retained-version limit independently of the video project. Invalid stored settings are preserved until explicit backed-up reset; this does not mark project edits saved.',
    inputSchema: { patch, resetInvalid: z.boolean().optional().describe('Explicitly back up invalid configuration and restore valid defaults before applying the patch') },
    handler: async (a, ctx) => ok({ projectProtection: await (await owner(ctx)).configure(a.patch as { enabled?: boolean; intervalSeconds?: number; retention?: number }, a.resetInvalid as boolean | undefined) }),
  },
  {
    name: 'project_recovery_create', title: 'Save recovery version',
    description: 'Create a completed immutable recovery version of the captured project, including verified copied media. It does not overwrite the normal saved project or mark current edits saved; failures preserve earlier versions.',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const protection = await owner(ctx);
      const recovery = await protection.checkpoint();
      return ok({ recovery, projectProtection: protection.snapshot() });
    },
  },
  {
    name: 'project_recovery_list', title: 'List recovery versions',
    description: 'List completed validated recovery versions in the owning workspace, with IDs, project names and creation times. Interrupted staging directories and corrupt packages are not advertised as recoverable versions.',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const protection = await owner(ctx);
      return ok({ recoveries: await protection.listRecovery(), projectProtection: protection.snapshot() });
    },
  },
  {
    name: 'project_recovery_inspect', title: 'Inspect recovery version',
    description: 'Validate one completed recovery package and inspect its copied and external media availability before restoring. A structurally valid project does not imply that every external media file is still available.',
    inputSchema: { recoveryId },
    handler: async (a, ctx) => {
      const protection = await owner(ctx);
      return ok({ ...await protection.inspectRecovery(a.recoveryId as string), projectProtection: protection.snapshot() });
    },
  },
  {
    name: 'project_recovery_restore', title: 'Restore recovery version',
    description: 'Restore a validated version into the same owning store after checking the current protection token. Dirty work requires explicit discard consent. Recovered work remains unsaved until a normal project_save; original saved files are untouched.',
    inputSchema: { recoveryId, expectedProtectionToken: protectionToken, discardUnsaved },
    handler: async (a, ctx) => ok(await (await owner(ctx)).restoreRecovery(a.recoveryId as string, a.expectedProtectionToken as string, a.discardUnsaved as boolean | undefined)),
  },
  {
    name: 'project_recovery_delete', title: 'Delete recovery version',
    description: 'Delete only the selected validated recovery package owned by this workspace. This does not delete source footage, the current project or normal saved project files, and refuses unknown or unsafe package paths.',
    inputSchema: { recoveryId },
    handler: async (a, ctx) => ok({ projectProtection: await (await owner(ctx)).deleteRecovery(a.recoveryId as string) }),
  },
  {
    name: 'project_replace', title: 'Safely create or open project',
    description: 'Create an empty project or load a saved directory through a guarded replacement. Supply the exact current protection token; dirty work is refused unless discardUnsaved is explicitly true. Load rechecks after file I/O, so intervening edits are protected.',
    inputSchema: {
      action: z.enum(['create', 'load']), expectedProtectionToken: protectionToken, discardUnsaved,
      path: z.string().min(1).optional().describe('Required for load; .freemier and legacy .palmier directories supported'),
      name: z.string().min(1).max(120).optional(),
      fps: z.number().min(1).max(240).optional(),
      width: z.number().int().min(1).max(8192).optional(),
      height: z.number().int().min(1).max(8192).optional(),
    },
    handler: async (a, ctx) => {
      if (a.action === 'load') {
        if (!a.path || ['name', 'fps', 'width', 'height'].some(key => a[key] !== undefined))
          throw new EditorError('INVALID_ARGUMENT', 'Loading requires path and does not accept new-project settings');
        return loadOwnedProject(a, ctx);
      }
      if (a.path !== undefined) throw new EditorError('INVALID_ARGUMENT', 'Creating a project does not accept a saved-project path');
      const protection = await owner(ctx);
      const project = createEmptyProject(a as { name?: string; fps?: number; width?: number; height?: number });
      protection.tracker.assertReplacement(a.expectedProtectionToken as string, a.discardUnsaved as boolean | undefined);
      ctx.store.load(project);
      ctx.notify({ kind: 'project', ids: [project.id] });
      return ok({ id: project.id, name: project.name, mediaCount: 0, projectProtection: protection.snapshot() });
    },
  },
];
