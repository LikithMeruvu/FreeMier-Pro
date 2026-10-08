import type { Project } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateProject } from './validation.js';

export { validateProject } from './validation.js';

/**
 * Project persistence.
 *
 * A project is a DIRECTORY containing `project.json`. Keeping it a directory
 * (rather than a single file) means media caches, thumbnails, and waveforms
 * can live alongside the document without bloating it — and it matches how
 * professional NLEs package projects.
 *
 *   myproject.palmier/
 *     project.json
 *     cache/            (thumbnails, waveforms — regenerable)
 */

export const PROJECT_FILE = 'project.json';
export const CACHE_DIR = 'cache';

/** Resolve the on-disk directory for a project path. */
export function projectDir(projectPath: string): string {
  return /\.(freemier|palmier)$/i.test(projectPath) ? projectPath : `${projectPath}.freemier`;
}

/** Save a project. Creates the directory tree. Writes atomically. */
export async function saveProject(project: Project, projectPath: string): Promise<string> {
  validateProject(project);
  let payload: string;
  try { payload = JSON.stringify(project, null, 2); }
  catch { throw new EditorError('INVALID_ARGUMENT', 'Project must be JSON-serializable'); }
  const dir = projectDir(projectPath);
  await fs.mkdir(path.join(dir, CACHE_DIR), { recursive: true });

  const target = path.join(dir, PROJECT_FILE);
  const tmp = `${target}.tmp-${process.pid}`;

  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, target); // atomic on the same volume
  return target;
}

/** Load a project from disk. */
export async function loadProject(projectPath: string): Promise<Project> {
  const dir = projectDir(projectPath);
  const target = path.join(dir, PROJECT_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    throw new EditorError('IO_ERROR', `Cannot read project at ${target}`, {
      path: target,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EditorError('IO_ERROR', 'Project file is not valid JSON', {
      path: target,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  return validateProject(parsed, target);
}

/** List project directories under a parent folder. */
export async function listProjects(parentDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /\.(freemier|palmier)$/i.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}
