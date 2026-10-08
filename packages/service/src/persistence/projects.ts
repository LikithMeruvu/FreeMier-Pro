import { loadProject, projectDir, saveProject } from '@freemier/engine';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandContext } from '../commands/context.js';
import { ok } from '../commands/helpers.js';

export async function saveOwnedProject(a: Record<string, unknown>, ctx: CommandContext) {
  const target = (a.path as string | undefined) ?? `${ctx.workspace}/project`;
  const snapshot = ctx.store.project;
  const portableMedia = await Promise.all(snapshot.media.map(async (asset) => {
    if (!asset.copied) return asset;
    const source = path.isAbsolute(asset.path) ? asset.path : path.resolve(ctx.workspace, 'media', asset.path);
    const mediaDir = path.join(projectDir(target), 'media'); await fs.mkdir(mediaDir, { recursive: true });
    const filename = `${asset.id}${path.extname(asset.path)}`;
    const destination = path.join(mediaDir, filename);
    if (path.resolve(source) !== path.resolve(destination)) await fs.copyFile(source, destination);
    return { ...asset, path: filename };
  }));
  const written = await saveProject({ ...snapshot, media: portableMedia }, target);
  return ok({ savedTo: written });
}

export async function loadOwnedProject(a: Record<string, unknown>, ctx: CommandContext) {
  const loaded = await loadProject(a.path as string);
  const media = await Promise.all(loaded.media.map(async (asset) => {
    if (!asset.copied || path.isAbsolute(asset.path)) return asset;
    const packaged = path.resolve(projectDir(a.path as string), 'media', asset.path);
    try { await fs.access(packaged); return { ...asset, path: packaged }; } catch { return asset; }
  }));
  const project = { ...loaded, media };
  ctx.store.load(project);
  ctx.notify({ kind: 'project', ids: [project.id] });
  return ok({ id: project.id, name: project.name, mediaCount: project.media.length });
}
