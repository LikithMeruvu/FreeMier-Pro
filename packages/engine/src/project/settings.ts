import { EditorError } from '@freemier/shared';
import type { EditorStore } from './store.js';

export interface ProjectSettingsPatch { name?: string; width?: number; height?: number; fps?: number }

/** Change project output settings in one undoable store mutation. */
export function updateProjectSettings(store: EditorStore, patch: ProjectSettingsPatch) {
  const current = store.project;
  const name = patch.name;
  if (name !== undefined && (!name.trim() || name.length > 120)) throw new EditorError('INVALID_ARGUMENT', 'Project name must contain 1–120 characters');
  for (const [field, value] of [['width', patch.width], ['height', patch.height]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 8192)) throw new EditorError('INVALID_ARGUMENT', `${field} must be an integer between 1 and 8192`);
  }
  if (patch.fps !== undefined && (!Number.isFinite(patch.fps) || patch.fps < 1 || patch.fps > 240)) throw new EditorError('INVALID_ARGUMENT', 'fps must be between 1 and 240');
  if (patch.fps !== undefined && patch.fps !== current.timeline.fps) {
    const t = current.timeline;
    if (t.tracks.some((track) => track.clips.length) || t.titles?.length || t.captions?.cues.length || t.markers?.length)
      throw new EditorError('CONFLICT', 'Cannot change fps while the timeline contains authored timing; retiming is not supported yet');
  }
  if ((name === undefined || name === current.name) && (patch.width === undefined || patch.width === current.timeline.width)
    && (patch.height === undefined || patch.height === current.timeline.height) && (patch.fps === undefined || patch.fps === current.timeline.fps)) return current;
  const ids = [current.id];
  store.mutate('project', ids, (project) => ({
    ...project,
    ...(name === undefined ? {} : { name }),
    timeline: { ...project.timeline, ...(patch.width === undefined ? {} : { width: patch.width }), ...(patch.height === undefined ? {} : { height: patch.height }), ...(patch.fps === undefined ? {} : { fps: patch.fps }) },
  }));
  return store.project;
}
