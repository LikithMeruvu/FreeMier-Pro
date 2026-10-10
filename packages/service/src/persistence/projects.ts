import { loadProject, projectDir, saveProject } from '@freemier/engine';
import path from 'node:path';
import type { CommandContext } from '../commands/context.js';
import { ok } from '../commands/helpers.js';
import { getProjectProtectionOwner, packageCopiedProject, protectionDirectory, resolvePackagedProject, verifyCopiedSources } from '../recovery/protection.js';

export async function saveOwnedProject(a: Record<string, unknown>, ctx: CommandContext) {
  const target = (a.path as string | undefined) ?? `${ctx.workspace}/project`;
  const owner = ctx.projectProtection ?? getProjectProtectionOwner(ctx.store, ctx.workspace);
  // Capture at invocation, before waiting for earlier save/recovery work.
  const receipt = owner.tracker.captureSave();
  return owner.runOperation(async () => {
    const portable = await packageCopiedProject(receipt.project, ctx.workspace, projectDir(target));
    await verifyCopiedSources(receipt.project, ctx.workspace, portable);
    const written = await saveProject(portable, target);
    owner.tracker.acknowledgeSave(receipt, written);
    return ok({ savedTo: written, savedToken: receipt.token, projectProtection: owner.snapshot() });
  });
}

export async function loadOwnedProject(a: Record<string, unknown>, ctx: CommandContext) {
  const owner = ctx.projectProtection ?? getProjectProtectionOwner(ctx.store, ctx.workspace);
  const guard = () => { if (a.expectedProtectionToken !== undefined) owner.tracker.assertReplacement(a.expectedProtectionToken as string, a.discardUnsaved === true); };
  guard();
  return owner.runOperation(async () => {
    guard();
    await protectionDirectory(projectDir(a.path as string));
    const loaded = await loadProject(a.path as string);
    const project = resolvePackagedProject(loaded, projectDir(a.path as string));
    guard();
    ctx.store.load(project);
    owner.tracker.markLoaded(path.join(projectDir(a.path as string), 'project.json'));
    ctx.notify({ kind: 'project', ids: [project.id] });
    return ok({ id: project.id, name: project.name, mediaCount: project.media.length, projectProtection: owner.snapshot() });
  });
}
