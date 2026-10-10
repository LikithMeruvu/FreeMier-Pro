import { ProjectProtectionTracker, projectContentDigest, validateProject, type EditorStore, type ProtectionSnapshot } from '@freemier/engine';
import { hashMediaSource, inspectMediaSource } from '@freemier/media';
import { EditorError, type Project } from '@freemier/shared';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

export interface ProtectionConfiguration { enabled: boolean; intervalSeconds: number; retention: number }
export interface RecoveryDescriptor { id: string; projectId: string; projectName: string; createdAt: number; mediaCount: number }
export interface RecoveryMediaObservation { assetId: string; copied: boolean; path: string; status: string; reason?: string }
export interface RecoveryInspection { recovery: RecoveryDescriptor; valid: true; media: readonly RecoveryMediaObservation[] }
export interface ProjectProtectionSnapshot extends ProtectionSnapshot, ProtectionConfiguration {
  readonly version: 1; readonly sequence: number;
  readonly lastRecovery?: { id: string; createdAt: number };
  readonly recoveryError?: string; readonly configurationReadOnly?: boolean; readonly configurationError?: string;
}
interface Identity { sha256: string; size: number }
interface ManifestMedia { assetId: string; copied: boolean; path: string; identity?: Identity }
interface Manifest extends RecoveryDescriptor { version: 1; digest: string; media: ManifestMedia[] }
const DEFAULTS: ProtectionConfiguration = { enabled: true, intervalSeconds: 60, retention: 10 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]{1,12})?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const META_LIMIT = 16 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const normalized = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
function fail(message: string): never { throw new EditorError('INVALID_ARGUMENT', message); }
function io(error: unknown, message: string): EditorError {
  return error instanceof EditorError ? error : new EditorError('IO_ERROR', message, { causeCode: (error as NodeJS.ErrnoException).code });
}
function frozen<T>(value: T): T {
  const result = structuredClone(value);
  const visit = (item: unknown) => { if (item && typeof item === 'object') { Object.values(item).forEach(visit); Object.freeze(item); } };
  visit(result); return result;
}
function record(value: unknown, keys: readonly string[], required = true): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Protection metadata must be a plain object');
  const object = value as Record<string, unknown>;
  if (Reflect.ownKeys(object).some(key => typeof key !== 'string' || !keys.includes(key)) || required && keys.some(key => !Object.hasOwn(object, key))) fail('Protection metadata contains unknown or missing fields');
  return object;
}
function configuration(value: unknown, partial = false): ProtectionConfiguration {
  const object = record(value, ['enabled', 'intervalSeconds', 'retention'], !partial);
  const result = { ...DEFAULTS, ...object };
  if (typeof result.enabled !== 'boolean' || !Number.isInteger(result.intervalSeconds) || result.intervalSeconds < 10 || result.intervalSeconds > 3600
    || !Number.isInteger(result.retention) || result.retention < 1 || result.retention > 50) fail('Protection configuration exceeds supported bounds');
  return result as ProtectionConfiguration;
}
function identity(value: unknown): asserts value is Identity {
  const object = record(value, ['sha256', 'size']);
  if (typeof object.sha256 !== 'string' || !DIGEST.test(object.sha256) || !Number.isSafeInteger(object.size) || (object.size as number) < 0) fail('Invalid media identity');
}
function assertId(id: unknown): asserts id is string { if (typeof id !== 'string' || !UUID.test(id)) fail('Recovery ID must be an opaque UUID'); }

/** Reject links along the resolved directory chain before creating owned storage. */
export async function protectionDirectory(directory: string, create = false): Promise<string | undefined> {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info: Stats;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return undefined;
      try { await fs.mkdir(current); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new EditorError('IO_ERROR', 'Protection storage must contain only real directories');
  }
  if (normalized(await fs.realpath(absolute)) !== normalized(absolute)) throw new EditorError('IO_ERROR', 'Protection storage is outside its owning directory');
  return absolute;
}

/** Read the opened file within a fixed budget and reject in-place growth or replacement. */
async function readJson(file: string, limit = META_LIMIT): Promise<unknown> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new EditorError('IO_ERROR', 'Protection metadata must be a regular file');
  const handle = await fs.open(file, 'r');
  let raw: string;
  try {
    if (!same(before, await handle.stat())) throw new EditorError('IO_ERROR', 'Protection metadata changed while opening');
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1)), chunks: Buffer[] = []; let length = 0;
    while (length <= limit) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, limit + 1 - length), length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
      if (length > limit) fail('Protection metadata exceeds the supported size');
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    const after = await handle.stat();
    if (!same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new EditorError('CONFLICT', 'Protection metadata changed while reading');
  } finally { await handle.close(); }
  const after = await fs.lstat(file);
  if (!same(before, after) || after.isSymbolicLink()) throw new EditorError('CONFLICT', 'Protection metadata was replaced while reading');
  return JSON.parse(raw);
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > META_LIMIT) fail('Protection metadata exceeds the supported size');
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Copied media uses distinct content addresses; a failed later save cannot overwrite old bytes. */
export async function packageCopiedProject(project: Project, workspace: string, destination: string): Promise<Project> {
  validateProject(project);
  const directory = await protectionDirectory(path.join(destination, 'media'), true);
  const directoryIdentity = await fs.lstat(directory!);
  const media = [];
  for (const asset of project.media) {
    if (!asset.copied) { media.push(asset); continue; }
    const source = path.isAbsolute(asset.path) ? asset.path : path.resolve(workspace, 'media', asset.path);
    const sourceInfo = await fs.lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new EditorError('IO_ERROR', 'Copied media source must be a regular file');
    const before = await hashMediaSource(source);
    if (asset.sourceIdentity && (before.sha256 !== asset.sourceIdentity.sha256 || before.size !== asset.sourceIdentity.size)) throw new EditorError('CONFLICT', 'Copied media no longer matches its saved identity');
    const extension = path.extname(asset.path);
    if (extension && !/^\.[A-Za-z0-9]{1,12}$/.test(extension)) fail('Copied media extension is unsupported');
    const filename = `${before.sha256}${extension.toLowerCase()}`, target = path.join(directory!, filename);
    let exists = false;
    try { const info = await fs.lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new EditorError('IO_ERROR', 'Packaged media must be a regular file'); exists = true; }
    catch (error) { if (!missing(error)) throw error; }
    if (!exists) {
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      const handle = await fs.open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    }
    const copied = await hashMediaSource(target), after = await hashMediaSource(source), sourceAfter = await fs.lstat(source);
    if (!same(sourceInfo, sourceAfter) || sourceAfter.isSymbolicLink() || before.sha256 !== after.sha256 || before.size !== after.size
      || copied.sha256 !== before.sha256 || copied.size !== before.size) throw new EditorError('CONFLICT', 'Copied media changed while packaging');
    const checkedDirectory = await protectionDirectory(directory!);
    if (!checkedDirectory || normalized(checkedDirectory) !== normalized(directory!) || !same(directoryIdentity, await fs.lstat(directory!))) throw new EditorError('IO_ERROR', 'Packaged media directory changed');
    media.push({ ...asset, path: filename, sourceIdentity: before });
  }
  return validateProject({ ...project, media });
}

/** Keep offline copied media attached to its correct package, never another workspace. */
export function resolvePackagedProject(project: Project, directory: string): Project {
  const mediaRoot = path.resolve(directory, 'media');
  return validateProject({ ...project, media: project.media.map(asset => {
    if (!asset.copied || path.isAbsolute(asset.path)) return asset;
    const location = path.resolve(mediaRoot, asset.path), relative = path.relative(mediaRoot, location);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.win32.isAbsolute(asset.path)) fail('Copied media escapes its project package');
    return { ...asset, path: location };
  }) });
}

export async function verifyCopiedSources(original: Project, workspace: string, packaged: Project): Promise<void> {
  for (const asset of original.media) {
    if (!asset.copied) continue;
    const source = path.isAbsolute(asset.path) ? asset.path : path.resolve(workspace, 'media', asset.path);
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new EditorError('CONFLICT', 'Copied media source changed before publication');
    const actual = await hashMediaSource(source), expected = packaged.media.find(item => item.id === asset.id)?.sourceIdentity;
    if (!expected || actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new EditorError('CONFLICT', 'Copied media source changed before publication');
  }
}

function validateManifest(value: unknown): Manifest {
  const object = record(value, ['version', 'id', 'projectId', 'projectName', 'createdAt', 'mediaCount', 'digest', 'media']);
  assertId(object.id);
  if (object.version !== 1 || typeof object.projectId !== 'string' || !object.projectId || typeof object.projectName !== 'string'
    || !Number.isSafeInteger(object.createdAt) || (object.createdAt as number) < 0 || !Number.isSafeInteger(object.mediaCount) || (object.mediaCount as number) < 0
    || typeof object.digest !== 'string' || !DIGEST.test(object.digest) || !Array.isArray(object.media) || object.media.length !== object.mediaCount) fail('Invalid recovery manifest');
  const seen = new Set<string>();
  for (const raw of object.media) {
    const item = record(raw, ['assetId', 'copied', 'path', 'identity'], false);
    if (typeof item.assetId !== 'string' || !item.assetId || seen.has(item.assetId) || typeof item.copied !== 'boolean' || typeof item.path !== 'string'
      || item.copied && !FILE.test(item.path) || !item.copied && !path.isAbsolute(item.path)) fail('Invalid recovery media reference');
    seen.add(item.assetId);
    if (item.identity !== undefined) identity(item.identity);
    if (item.copied && item.identity === undefined) fail('Copied recovery media needs a verified identity');
  }
  return object as unknown as Manifest;
}
const descriptor = (manifest: Manifest): RecoveryDescriptor => ({ id: manifest.id, projectId: manifest.projectId, projectName: manifest.projectName, createdAt: manifest.createdAt, mediaCount: manifest.mediaCount });

export class ProjectProtectionOwner {
  readonly ready: Promise<void>;
  readonly tracker: ProjectProtectionTracker;
  readonly #store: EditorStore; readonly #workspace: string;
  readonly #listeners = new Set<(snapshot: ProjectProtectionSnapshot) => void>();
  #config = { ...DEFAULTS }; #configurationReadOnly = false; #configurationError: string | undefined;
  #lastRecovery: { id: string; createdAt: number } | undefined; #recoveryError: string | undefined;
  #sequence = 0; #queue: Promise<void> = Promise.resolve(); #timer: NodeJS.Timeout | undefined; #timerPending = false;
  #lastCheckpointDigest: string | undefined; #disposed = false; readonly #unsubscribe: () => void;
  constructor(store: EditorStore, workspace: string) {
    this.#store = store; this.#workspace = path.resolve(workspace); this.tracker = new ProjectProtectionTracker(store);
    this.#unsubscribe = this.tracker.subscribe(() => this.#emit());
    this.ready = this.#initialize();
  }
  snapshot(): ProjectProtectionSnapshot {
    return frozen({ ...this.tracker.snapshot(), ...this.#config, version: 1, sequence: this.#sequence,
      ...(this.#lastRecovery ? { lastRecovery: this.#lastRecovery } : {}), ...(this.#recoveryError ? { recoveryError: this.#recoveryError } : {}),
      ...(this.#configurationReadOnly ? { configurationReadOnly: true } : {}), ...(this.#configurationError ? { configurationError: this.#configurationError } : {}) });
  }
  subscribe(listener: (snapshot: ProjectProtectionSnapshot) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => { await this.ready; if (this.#disposed) throw new EditorError('CONFLICT', 'Project protection owner is disposed'); return operation(); });
    this.#queue = result.then(() => {}, () => {}); return result;
  }
  configure(patch: Partial<ProtectionConfiguration>, resetInvalid = false): Promise<ProjectProtectionSnapshot> {
    try { configuration(patch, true); } catch (error) { return Promise.reject(error); }
    const captured = structuredClone(patch);
    return this.runOperation(async () => {
      const next = configuration({ ...(this.#configurationReadOnly && resetInvalid ? DEFAULTS : this.#config), ...captured });
      if (this.#configurationReadOnly && !resetInvalid) throw new EditorError('CONFLICT', 'Invalid protection configuration must be explicitly restored to defaults');
      if (!this.#configurationReadOnly && JSON.stringify(next) === JSON.stringify(this.#config)) return this.snapshot();
      const directory = (await protectionDirectory(path.join(this.#workspace, 'settings'), true))!, target = path.join(directory, 'project-protection.json');
      const beforeDirectory = await fs.lstat(directory);
      let old: Stats | undefined;
      try { old = await fs.lstat(target); if (old.isSymbolicLink() || !old.isFile()) throw new EditorError('IO_ERROR', 'Protection configuration must be a regular file'); } catch (error) { if (!missing(error)) throw error; }
      const oldIdentity = old ? await hashMediaSource(target) : undefined;
      if (this.#configurationReadOnly && old) {
        const backup = path.join(directory, `project-protection-recovery-${randomUUID()}.json`);
        await fs.copyFile(target, backup, constants.COPYFILE_EXCL);
        const handle = await fs.open(backup, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        const copied = await hashMediaSource(backup);
        if (copied.sha256 !== oldIdentity!.sha256 || copied.size !== oldIdentity!.size) throw new EditorError('CONFLICT', 'Configuration changed while creating recovery backup');
      }
      const temporary = path.join(directory, `project-protection-${randomUUID()}.tmp`);
      let temporaryIdentity: Stats | undefined, published = false;
      try {
        const handle = await fs.open(temporary, 'wx');
        try { temporaryIdentity = await handle.stat(); await handle.writeFile(JSON.stringify({ version: 1, ...next }) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await protectionDirectory(directory);
        if (!same(beforeDirectory, await fs.lstat(directory))) throw new EditorError('IO_ERROR', 'Configuration directory changed');
        if (old) {
          const checked = await fs.lstat(target), checkedIdentity = await hashMediaSource(target);
          if (checked.isSymbolicLink() || !same(old, checked) || old.size !== checked.size || old.mtimeMs !== checked.mtimeMs
            || checkedIdentity.sha256 !== oldIdentity!.sha256 || checkedIdentity.size !== oldIdentity!.size) throw new EditorError('CONFLICT', 'Configuration changed while saving');
        } else {
          try { await fs.lstat(target); throw new EditorError('CONFLICT', 'Configuration appeared while saving'); } catch (error) { if (!missing(error)) throw error; }
        }
        const checkedTemp = await fs.lstat(temporary);
        if (checkedTemp.isSymbolicLink() || !same(temporaryIdentity, checkedTemp)) throw new EditorError('CONFLICT', 'Temporary protection configuration changed');
        await fs.rename(temporary, target); published = true;
      } finally {
        if (!published && temporaryIdentity) {
          try {
            await protectionDirectory(directory);
            const checked = await fs.lstat(temporary);
            if (same(beforeDirectory, await fs.lstat(directory)) && checked.isFile() && !checked.isSymbolicLink() && same(temporaryIdentity, checked)) await fs.unlink(temporary);
          } catch { /* Never remove an uncertain or replaced temporary path. */ }
        }
      }
      this.#config = next; this.#configurationReadOnly = false; this.#configurationError = undefined; this.#startTimer(); this.#emit(); return this.snapshot();
    }).catch(error => { throw io(error, 'Unable to persist protection configuration'); });
  }
  checkpoint(): Promise<RecoveryDescriptor> {
    const receipt = this.tracker.captureSave();
    return this.runOperation(async () => {
      let staging: string | undefined;
      try {
        const recoveryRoot = (await protectionDirectory(path.join(this.#workspace, 'recovery'), true))!, rootIdentity = await fs.lstat(recoveryRoot);
        const id = randomUUID(), createdAt = Date.now(); staging = path.join(recoveryRoot, `.pending-${id}`);
        await fs.mkdir(staging); const stagingIdentity = await fs.lstat(staging);
        const project = await packageCopiedProject(receipt.project, this.#workspace, staging);
        const externalMedia = project.media.map(asset => asset.copied ? asset : { ...asset, path: path.resolve(asset.path) });
        const packaged = validateProject({ ...project, media: externalMedia });
        const manifest: Manifest = { version: 1, id, projectId: project.id, projectName: project.name, createdAt, mediaCount: project.media.length,
          digest: projectContentDigest(packaged), media: packaged.media.map(asset => ({ assetId: asset.id, copied: asset.copied, path: asset.path, ...(asset.sourceIdentity ? { identity: asset.sourceIdentity } : {}) })) };
        await writeExclusive(path.join(staging, 'project.json'), packaged);
        await writeExclusive(path.join(staging, 'manifest.json'), manifest);
        // Inspect staged bytes and all copied hashes before their directory becomes a candidate.
        await this.#readPackage(staging, id);
        await verifyCopiedSources(receipt.project, this.#workspace, packaged);
        await protectionDirectory(recoveryRoot);
        if (!same(rootIdentity, await fs.lstat(recoveryRoot)) || !same(stagingIdentity, await fs.lstat(staging))) throw new EditorError('IO_ERROR', 'Recovery directory changed during publication');
        await fs.rename(staging, path.join(recoveryRoot, id)); staging = undefined;
        this.#lastRecovery = { id, createdAt }; this.#lastCheckpointDigest = receipt.digest; this.#recoveryError = undefined; this.#emit();
        try { await this.#retain(project.id); } catch (error) { this.#recoveryError = io(error, 'Recovery retention failed; completed versions were preserved').message; this.#emit(); }
        return frozen(descriptor(manifest));
      } catch (error) {
        // Interrupted/failed staging stays non-candidate; never recursively remove unknown paths.
        this.#recoveryError = io(error, 'Recovery checkpoint failed; older completed versions were preserved').message; this.#emit(); throw io(error, 'Recovery checkpoint failed');
      }
    });
  }
  async listRecovery(): Promise<readonly RecoveryDescriptor[]> { await this.ready; return frozen(await this.#list()); }
  async inspectRecovery(id: string): Promise<RecoveryInspection> {
    await this.ready; const loaded = await this.#read(id); return frozen({ recovery: descriptor(loaded.manifest), valid: true, media: loaded.observations });
  }
  async restoreRecovery(id: string, expectedToken: string, discardUnsaved = false): Promise<{ recovery: RecoveryDescriptor; projectProtection: ProjectProtectionSnapshot }> {
    this.tracker.assertReplacement(expectedToken, discardUnsaved);
    return this.runOperation(async () => {
      this.tracker.assertReplacement(expectedToken, discardUnsaved);
      const loaded = await this.#read(id);
      this.tracker.assertReplacement(expectedToken, discardUnsaved);
      this.#store.load(resolvePackagedProject(loaded.project, loaded.directory)); this.tracker.markRecovered();
      return { recovery: frozen(descriptor(loaded.manifest)), projectProtection: this.snapshot() };
    });
  }
  deleteRecovery(id: string): Promise<ProjectProtectionSnapshot> {
    assertId(id);
    return this.runOperation(async () => { await this.#delete(id); if (this.#lastRecovery?.id === id) this.#lastRecovery = undefined; this.#emit(); return this.snapshot(); });
  }
  dispose(): void { this.#disposed = true; clearInterval(this.#timer); this.#unsubscribe(); this.tracker.dispose(); this.#listeners.clear(); }
  async #initialize(): Promise<void> {
    try {
      const directory = await protectionDirectory(path.join(this.#workspace, 'settings'));
      if (directory) {
        try { const raw = record(await readJson(path.join(directory, 'project-protection.json'), 64 * 1024), ['version', 'enabled', 'intervalSeconds', 'retention']);
          if (raw.version !== 1) fail('Unsupported protection configuration version');
          this.#config = configuration({ enabled: raw.enabled, intervalSeconds: raw.intervalSeconds, retention: raw.retention });
        } catch (error) { if (!missing(error)) throw error; }
      }
    } catch (error) { this.#configurationReadOnly = true; this.#configurationError = io(error, 'Protection configuration is invalid and was preserved').message; }
    try { const items = await this.#list(); if (items[0]) this.#lastRecovery = { id: items[0].id, createdAt: items[0].createdAt }; }
    catch (error) { this.#recoveryError = io(error, 'Recovery versions could not be listed').message; }
    this.#startTimer();
  }
  #startTimer(): void {
    clearInterval(this.#timer);
    if (this.#disposed || !this.#config.enabled) return;
    this.#timer = setInterval(() => {
      if (this.#timerPending || !this.tracker.snapshot().dirty || this.tracker.captureSave().digest === this.#lastCheckpointDigest) return;
      this.#timerPending = true; void this.checkpoint().catch(() => {}).finally(() => { this.#timerPending = false; });
    }, this.#config.intervalSeconds * 1000);
    this.#timer.unref();
  }
  #emit(): void { this.#sequence++; for (const listener of this.#listeners) { try { listener(this.snapshot()); } catch { /* Observers cannot invalidate committed protection state. */ } } }
  async #read(id: string) {
    assertId(id); const root = await protectionDirectory(path.join(this.#workspace, 'recovery'));
    if (!root) throw new EditorError('NOT_FOUND', 'Recovery version not found');
    const directory = path.join(root, id);
    try { await protectionDirectory(directory); return await this.#readPackage(directory, id); }
    catch (error) { if (missing(error)) throw new EditorError('NOT_FOUND', 'Recovery version not found'); throw io(error, 'Recovery version is invalid'); }
  }
  async #readPackage(directory: string, id: string) {
    const dirIdentity = await fs.lstat(directory);
    if (!dirIdentity.isDirectory() || dirIdentity.isSymbolicLink()) throw new EditorError('IO_ERROR', 'Recovery version must be a real directory');
    const manifest = validateManifest(await readJson(path.join(directory, 'manifest.json'))), project = validateProject(await readJson(path.join(directory, 'project.json')));
    if (manifest.id !== id || manifest.projectId !== project.id || manifest.projectName !== project.name || manifest.mediaCount !== project.media.length || manifest.digest !== projectContentDigest(project)) fail('Recovery document does not match its manifest');
    const observations: RecoveryMediaObservation[] = [];
    const mediaDirectory = await protectionDirectory(path.join(directory, 'media'));
    for (const asset of project.media) {
      const item = manifest.media.find(entry => entry.assetId === asset.id);
      const manifestIdentity = item?.identity, projectIdentity = asset.sourceIdentity;
      const identityMatches = manifestIdentity === undefined ? projectIdentity === undefined
        : projectIdentity !== undefined && manifestIdentity.sha256 === projectIdentity.sha256 && manifestIdentity.size === projectIdentity.size;
      if (!item || item.copied !== asset.copied || item.path !== asset.path || !identityMatches) fail('Recovery media does not match its document');
      const source = asset.copied ? path.join(directory, 'media', asset.path) : asset.path;
      if (asset.copied) {
        if (!mediaDirectory) throw new EditorError('IO_ERROR', 'Copied recovery media is missing');
        const info = await fs.lstat(source); if (!info.isFile() || info.isSymbolicLink()) throw new EditorError('IO_ERROR', 'Copied recovery media must be a regular file');
      }
      const observed = await inspectMediaSource(source, item.identity, true);
      if (asset.copied && observed.status !== 'available') throw new EditorError('CONFLICT', 'Copied recovery media is missing or changed');
      observations.push({ assetId: asset.id, copied: asset.copied, path: source, status: observed.status, ...(observed.reason ? { reason: observed.reason } : {}) });
    }
    await protectionDirectory(directory);
    if (!same(dirIdentity, await fs.lstat(directory))) throw new EditorError('CONFLICT', 'Recovery directory changed during inspection');
    return { manifest, project, observations, directory };
  }
  async #list(): Promise<RecoveryDescriptor[]> {
    const root = await protectionDirectory(path.join(this.#workspace, 'recovery')); if (!root) return [];
    const items: RecoveryDescriptor[] = [];
    const directory = await fs.opendir(root); let visited = 0;
    for await (const entry of directory) {
      if (++visited > 1000) throw new EditorError('CONFLICT', 'Recovery directory exceeds the supported entry budget');
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try { const loaded = await this.#readPackage(path.join(root, entry.name), entry.name); items.push(descriptor(loaded.manifest)); } catch { /* Corrupt generations never become valid candidates. */ }
    }
    return items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  async #delete(id: string): Promise<void> {
    const loaded = await this.#read(id), directoryIdentity = await fs.lstat(loaded.directory), mediaDir = path.join(loaded.directory, 'media');
    const files = [...new Set(loaded.manifest.media.filter(item => item.copied).map(item => item.path))].sort();
    const actual = (await fs.readdir(loaded.directory)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(['manifest.json', 'media', 'project.json'])) throw new EditorError('CONFLICT', 'Unknown recovery contents prevent deletion');
    if (JSON.stringify((await fs.readdir(mediaDir)).sort()) !== JSON.stringify(files)) throw new EditorError('CONFLICT', 'Unknown recovery media prevents deletion');
    const targets = [...files.map(file => path.join(mediaDir, file)), path.join(loaded.directory, 'manifest.json'), path.join(loaded.directory, 'project.json')];
    const identities = await Promise.all(targets.map(file => fs.lstat(file)));
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i], identity = identities[i];
      if (!target || !identity) throw new EditorError('IO_ERROR', 'Recovery deletion target is missing');
      await protectionDirectory(mediaDir);
      if (!same(directoryIdentity, await fs.lstat(loaded.directory))) throw new EditorError('CONFLICT', 'Recovery directory changed during deletion');
      const info = await fs.lstat(target); if (!info.isFile() || info.isSymbolicLink() || !same(info, identity)) throw new EditorError('CONFLICT', 'Recovery file changed during deletion');
      await fs.unlink(target);
    }
    await fs.rmdir(mediaDir); await fs.rmdir(loaded.directory);
  }
  async #retain(projectId: string): Promise<void> {
    const versions = (await this.#list()).filter(item => item.projectId === projectId);
    for (const item of versions.slice(this.#config.retention)) await this.#delete(item.id);
  }
}

const owners = new WeakMap<EditorStore, { workspace: string; owner: ProjectProtectionOwner }>();
export function getProjectProtectionOwner(store: EditorStore, workspace: string): ProjectProtectionOwner {
  const key = normalized(workspace), existing = owners.get(store);
  if (existing) { if (existing.workspace !== key) throw new EditorError('CONFLICT', 'The owning project store is already attached to a different workspace'); return existing.owner; }
  const owner = new ProjectProtectionOwner(store, workspace); owners.set(store, { workspace: key, owner }); return owner;
}
