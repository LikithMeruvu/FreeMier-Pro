import type { EditorStore } from '@freemier/engine';
import { exportProject, type ExportOptions } from '@freemier/media';
import path from 'node:path';

/** Coordinate existing export progress with the owning project and workspace. */
export function exportSession(store: EditorStore, workspace: string, options: Omit<ExportOptions, 'mediaDirectory' | 'textCacheDirectory'>) {
  return exportProject(store.project, {
    ...options,
    mediaDirectory: path.join(workspace, 'media'),
    textCacheDirectory: path.join(workspace, 'cache', 'text'),
  });
}
