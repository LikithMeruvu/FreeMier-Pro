import type { EditorStore } from '@freemier/engine';
import { timelineDuration } from '@freemier/engine';
import { EditorError } from '@freemier/shared';
import type { MediaAsset } from '@freemier/shared';
import type { CommandContext } from './context.js';
import path from 'node:path';

export const ok = (data: Record<string, unknown>) => ({ ok: true, ...data });
export function resolveAssetPath(asset: MediaAsset, workspace: string): string {
  return asset.copied && !path.isAbsolute(asset.path) ? path.resolve(workspace, 'media', asset.path) : asset.path;
}
export function assertExportable(store: EditorStore): void {
  if (timelineDuration(store.project.timeline) <= 0) {
    throw new EditorError('INVALID_ARGUMENT', 'Timeline is empty — add media or visible text before exporting.');
  }
}
export function resolveMediaPath(assetIdOrPath: string, ctx: CommandContext): string {
  const asset = ctx.store.project.media.find((m) => m.id === assetIdOrPath);
  if (asset) {
    return resolveAssetPath(asset, ctx.workspace);
  }
  // Not an asset id — treat it as a path.
  if (assetIdOrPath.includes('/') || assetIdOrPath.includes('\\') || assetIdOrPath.includes('.')) {
    return assetIdOrPath;
  }
  throw new EditorError('NOT_FOUND', `No media asset or path matching: ${assetIdOrPath}`, {
    reference: assetIdOrPath,
    availableAssets: ctx.store.project.media.map((m) => m.id),
  });
}
