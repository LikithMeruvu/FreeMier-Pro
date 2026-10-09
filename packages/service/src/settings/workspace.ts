import { EditorError } from '@freemier/shared';
import {
  DEFAULT_WORKSPACE_LAYOUT, normalizeWorkspaceLayoutName, patchWorkspaceLayout, validateStoredWorkspaceSettings,
  type StoredWorkspaceSettings, type WorkspaceLayoutPatch, type WorkspaceSettingsSnapshot,
} from '@freemier/shared/workspace';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

type Listener = (snapshot: WorkspaceSettingsSnapshot) => void;
const normalizedPath = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const samePath = (left: string, right: string) => normalizedPath(left) === normalizedPath(right);
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const defaults = (): StoredWorkspaceSettings => ({ version: 1, revision: 0, current: clone(DEFAULT_WORKSPACE_LAYOUT), layouts: [] });

interface ConfinedLocation {
  root: string;
  directory: string;
  file: string;
  rootIdentity?: Stats;
  directoryIdentity?: Stats;
  fileIdentity?: Stats;
}

/** User layout preferences belong to the service workspace, never project history. */
export class WorkspaceSettingsOwner {
  readonly ready: Promise<void>;
  readonly #workspace: string;
  readonly #epoch = randomUUID();
  readonly #listeners = new Set<Listener>();
  #settings = defaults();
  #readOnly = false;
  #persistenceError: string | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    this.#workspace = path.resolve(workspace);
    this.ready = this.#load();
  }

  snapshot(): WorkspaceSettingsSnapshot {
    return freeze(clone({ ...this.#settings, epoch: this.#epoch, readOnly: this.#readOnly,
      ...(this.#persistenceError === undefined ? {} : { persistenceError: this.#persistenceError }),
    }));
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  update(patch: WorkspaceLayoutPatch, expectedRevision?: number): Promise<WorkspaceSettingsSnapshot> {
    // Validate before cloning so unsupported fields/prototypes are not erased.
    try { patchWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, patch); }
    catch (error) { return Promise.reject(error); }
    const captured = clone(patch);
    return this.#enqueue(expectedRevision, async () => {
      this.#assertWritable();
      const current = patchWorkspaceLayout(this.#settings.current, captured);
      if (JSON.stringify(current) === JSON.stringify(this.#settings.current)) return this.snapshot();
      return this.#publish({ ...this.#settings, current });
    });
  }

  reset(expectedRevision?: number): Promise<WorkspaceSettingsSnapshot> {
    return this.#enqueue(expectedRevision, async () => {
      if (this.#readOnly) {
        const location = await this.#location(false);
        if (location.fileIdentity) {
          const backup = path.join(location.directory, `workspace-recovery-${randomUUID()}.json`);
          try {
            await fs.copyFile(location.file, backup, constants.COPYFILE_EXCL);
            const handle = await fs.open(backup, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
            const checked = await this.#location(false);
            if (!checked.fileIdentity || !sameFile(checked.fileIdentity, location.fileIdentity))
              throw new EditorError('IO_ERROR', 'Workspace settings changed while creating the recovery backup');
          } catch (error) {
            if (error instanceof EditorError) throw error;
            throw new EditorError('IO_ERROR', 'Unable to back up workspace settings; the original file was preserved', { causeCode: (error as NodeJS.ErrnoException).code });
          }
        }
        return this.#publish({ ...defaults(), revision: this.#settings.revision });
      }
      if (JSON.stringify(this.#settings.current) === JSON.stringify(DEFAULT_WORKSPACE_LAYOUT)) return this.snapshot();
      return this.#publish({ ...this.#settings, current: clone(DEFAULT_WORKSPACE_LAYOUT) });
    });
  }

  saveLayout(name: string, expectedRevision?: number): Promise<{ workspaceSettings: WorkspaceSettingsSnapshot; layoutId: string }> {
    return this.#enqueue(expectedRevision, async () => {
      this.#assertWritable();
      const normalized = normalizeWorkspaceLayoutName(name);
      if (this.#settings.layouts.some(layout => layout.name.toLowerCase() === normalized.toLowerCase()))
        throw new EditorError('CONFLICT', 'A workspace layout with that name already exists');
      if (this.#settings.layouts.length >= 24) throw new EditorError('CONFLICT', 'At most 24 named workspace layouts can be saved');
      const layoutId = randomUUID();
      const workspaceSettings = await this.#publish({ ...this.#settings, layouts: [...this.#settings.layouts, { id: layoutId, name: normalized, layout: clone(this.#settings.current) }] });
      return { workspaceSettings, layoutId };
    });
  }

  applyLayout(id: string, expectedRevision?: number): Promise<WorkspaceSettingsSnapshot> {
    return this.#enqueue(expectedRevision, async () => {
      this.#assertWritable();
      const layout = this.#settings.layouts.find(item => item.id === id);
      if (!layout) throw new EditorError('NOT_FOUND', 'Workspace layout not found');
      if (JSON.stringify(layout.layout) === JSON.stringify(this.#settings.current)) return this.snapshot();
      return this.#publish({ ...this.#settings, current: clone(layout.layout) });
    });
  }

  deleteLayout(id: string, expectedRevision?: number): Promise<WorkspaceSettingsSnapshot> {
    return this.#enqueue(expectedRevision, async () => {
      this.#assertWritable();
      if (!this.#settings.layouts.some(item => item.id === id)) throw new EditorError('NOT_FOUND', 'Workspace layout not found');
      return this.#publish({ ...this.#settings, layouts: this.#settings.layouts.filter(item => item.id !== id) });
    });
  }

  #assertWritable(): void {
    if (this.#readOnly) throw new EditorError('CONFLICT', 'Workspace settings are read-only; explicitly restore defaults to recover them');
  }

  #enqueue<T>(expectedRevision: number | undefined, operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      await this.ready;
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
        throw new EditorError('INVALID_ARGUMENT', 'Expected settings revision must be a nonnegative safe integer');
      if (expectedRevision !== undefined && expectedRevision !== this.#settings.revision)
        throw new EditorError('CONFLICT', 'Workspace settings changed; refresh before changing them', { expectedRevision, revision: this.#settings.revision });
      return operation();
    });
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  /** Read-only bootstrap never creates the workspace or settings directory. */
  async #load(): Promise<void> {
    try {
      const location = await this.#location(false);
      if (!location.fileIdentity) return;
      if (location.fileIdentity.size > 1024 * 1024) throw new EditorError('INVALID_ARGUMENT', 'Workspace settings file exceeds the supported size');
      const handle = await fs.open(location.file, 'r');
      let content: string;
      try {
        if (!sameFile(await handle.stat(), location.fileIdentity)) throw new EditorError('IO_ERROR', 'Workspace settings changed while opening them');
        // Bound the opened file too: an external writer may grow it after lstat.
        const limit = 1024 * 1024, bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length > limit) throw new EditorError('INVALID_ARGUMENT', 'Workspace settings file exceeds the supported size');
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      } finally { await handle.close(); }
      const checked = await this.#location(false);
      if (!checked.fileIdentity || !sameFile(checked.fileIdentity, location.fileIdentity)) throw new EditorError('IO_ERROR', 'Workspace settings changed while reading them');
      const settings: unknown = JSON.parse(content);
      validateStoredWorkspaceSettings(settings);
      this.#settings = clone(settings);
    } catch (error) {
      this.#readOnly = true;
      this.#persistenceError = error instanceof EditorError ? error.message : 'Workspace settings could not be read or contain invalid JSON; the original file was preserved';
    }
  }

  /** Resolve the owning directory and reject settings links before reading/writing. */
  async #location(create: boolean): Promise<ConfinedLocation> {
    let rootIdentity: Stats;
    try { rootIdentity = await fs.lstat(this.#workspace); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return { root: this.#workspace, directory: path.join(this.#workspace, 'settings'), file: path.join(this.#workspace, 'settings', 'workspace.json') };
      await fs.mkdir(this.#workspace, { recursive: true });
      rootIdentity = await fs.lstat(this.#workspace);
    }
    if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) throw new EditorError('IO_ERROR', 'The owning workspace must be a directory without a symbolic link');
    const root = await fs.realpath(this.#workspace), directory = path.join(root, 'settings'), file = path.join(directory, 'workspace.json');
    let directoryIdentity: Stats;
    try { directoryIdentity = await fs.lstat(directory); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return { root, directory, file, rootIdentity };
      try { await fs.mkdir(directory); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      directoryIdentity = await fs.lstat(directory);
    }
    if (directoryIdentity.isSymbolicLink() || !directoryIdentity.isDirectory()) throw new EditorError('IO_ERROR', 'Workspace settings directory must not be a symbolic link');
    if (!samePath(await fs.realpath(directory), directory)) throw new EditorError('IO_ERROR', 'Workspace settings directory is outside its owning workspace');
    let fileIdentity: Stats | undefined;
    try {
      fileIdentity = await fs.lstat(file);
      if (fileIdentity.isSymbolicLink() || !fileIdentity.isFile()) throw new EditorError('IO_ERROR', 'Workspace settings file must be a regular file without a symbolic link');
    } catch (error) { if (!missing(error)) throw error; }
    return { root, directory, file, rootIdentity, directoryIdentity, fileIdentity };
  }

  async #publish(candidate: StoredWorkspaceSettings): Promise<WorkspaceSettingsSnapshot> {
    if (this.#settings.revision >= Number.MAX_SAFE_INTEGER) throw new EditorError('CONFLICT', 'Workspace settings revision limit reached');
    const next: StoredWorkspaceSettings = { ...candidate, revision: this.#settings.revision + 1 };
    validateStoredWorkspaceSettings(next);
    let location: ConfinedLocation | undefined, temporary: string | undefined, identity: Stats | undefined;
    try {
      location = await this.#location(true);
      temporary = path.join(location.directory, `workspace-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx');
      try {
        identity = await handle.stat();
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      const checked = await this.#location(false);
      if (!checked.rootIdentity || !checked.directoryIdentity || !samePath(checked.directory, location.directory)
        || !sameFile(checked.rootIdentity, location.rootIdentity!) || !sameFile(checked.directoryIdentity, location.directoryIdentity!))
        throw new EditorError('IO_ERROR', 'Workspace settings directory changed while saving');
      if (!sameFile(await fs.lstat(temporary), identity)) throw new EditorError('IO_ERROR', 'Temporary workspace settings file changed while saving');
      await fs.rename(temporary, location.file);
      temporary = undefined;
    } catch (error) {
      if (error instanceof EditorError) throw error;
      throw new EditorError('IO_ERROR', 'Unable to persist workspace settings; the previous settings were preserved', { causeCode: (error as NodeJS.ErrnoException).code });
    } finally {
      if (temporary && identity && location) {
        try {
          const directoryIdentity = await fs.lstat(location.directory), fileIdentity = await fs.lstat(temporary);
          if (!directoryIdentity.isSymbolicLink() && sameFile(directoryIdentity, location.directoryIdentity!)
            && samePath(await fs.realpath(location.directory), location.directory) && fileIdentity.isFile() && sameFile(fileIdentity, identity)) await fs.unlink(temporary);
        } catch { /* Preserve uncertain or externally replaced paths. */ }
      }
    }
    this.#settings = clone(next);
    this.#readOnly = false;
    this.#persistenceError = undefined;
    for (const listener of this.#listeners) {
      try { listener(this.snapshot()); } catch { /* A committed write remains successful if a viewer fails. */ }
    }
    return this.snapshot();
  }
}

const owners = new Map<string, WorkspaceSettingsOwner>();
/** All adapters in one process share the owner for the resolved settings filename. */
export function getWorkspaceSettingsOwner(workspace: string): WorkspaceSettingsOwner {
  const key = normalizedPath(path.join(path.resolve(workspace), 'settings', 'workspace.json'));
  let owner = owners.get(key);
  if (!owner) { owner = new WorkspaceSettingsOwner(workspace); owners.set(key, owner); }
  return owner;
}
