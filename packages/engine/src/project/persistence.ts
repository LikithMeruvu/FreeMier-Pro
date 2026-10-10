import type { Project } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

interface FileIdentity { readonly dev: number; readonly ino: number }

function ioPathError(message: string, target: string): EditorError {
  return new EditorError('IO_ERROR', message, { path: target });
}

function sameIdentity(stat: { readonly dev: number; readonly ino: number }, identity: FileIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

/** Create ordinary directories one component at a time and retain their identities for publication checks. */
async function ensureSafeDirectoryTree(directory: string): Promise<Map<string, FileIdentity>> {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  const identities = new Map<string, FileIdentity>();
  let current = root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  for (const component of [undefined, ...components]) {
    if (component !== undefined) current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || component === undefined) throw error;
      try { await fs.mkdir(current); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw ioPathError('Project path contains a linked or non-directory ancestor', current);
    identities.set(current, { dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function assertDirectoryIdentities(identities: ReadonlyMap<string, FileIdentity>): Promise<void> {
  for (const [directory, identity] of identities) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, identity)) throw ioPathError('Project directory changed during save', directory);
  }
}

async function captureTargetIdentity(target: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw ioPathError('Project target must be a regular unlinked file, not a link or directory', target);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertTargetIdentity(target: string, expected: FileIdentity | undefined): Promise<void> {
  const current = await captureTargetIdentity(target);
  if ((expected === undefined) !== (current === undefined) || (expected && current && !sameIdentity(current, expected))) {
    throw ioPathError('Project target changed during save', target);
  }
}

/** Save a project. Creates the directory tree. Writes atomically. */
export async function saveProject(project: Project, projectPath: string): Promise<string> {
  validateProject(project);
  let payload: string;
  try { payload = JSON.stringify(project, null, 2); }
  catch { throw new EditorError('INVALID_ARGUMENT', 'Project must be JSON-serializable'); }
  const dir = projectDir(projectPath);
  const directoryIdentities = await ensureSafeDirectoryTree(dir);
  const cacheIdentities = await ensureSafeDirectoryTree(path.join(dir, CACHE_DIR));
  for (const [directory, identity] of cacheIdentities) {
    const previous = directoryIdentities.get(directory);
    if (previous && !sameIdentity(previous, identity)) throw ioPathError('Project directory changed during save', directory);
    directoryIdentities.set(directory, identity);
  }

  const target = path.join(dir, PROJECT_FILE);
  const targetIdentity = await captureTargetIdentity(target);
  const tmp = `${target}.tmp-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let createdIdentity: FileIdentity | undefined;
  let published = false;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    const createdStat = await handle.stat();
    createdIdentity = { dev: createdStat.dev, ino: createdStat.ino };
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryIdentities(directoryIdentities);
    await assertTargetIdentity(target, targetIdentity);
    const tempStat = await fs.lstat(tmp);
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1 || !sameIdentity(tempStat, createdIdentity)) throw ioPathError('Temporary project file changed during save', tmp);
    await fs.rename(tmp, target); // atomic on the same volume
    published = true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published && createdIdentity) {
      try {
        await assertDirectoryIdentities(directoryIdentities);
        const current = await fs.lstat(tmp);
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && sameIdentity(current, createdIdentity)) await fs.unlink(tmp);
      } catch { /* Only the exact regular file created here is eligible for cleanup. */ }
    }
  }
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
