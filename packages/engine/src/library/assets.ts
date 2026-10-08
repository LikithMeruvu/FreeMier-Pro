import type { MediaAsset, MediaBin, MediaLibrary, MediaLibraryEntry, MediaSourceIdentity, Project } from '@freemier/shared';
import { EditorError, invalidArgument, newId, notFound } from '@freemier/shared';
import type { EditorStore } from '../project/store.js';

export interface ResolvedMediaLibraryEntry extends MediaLibraryEntry {
  readonly asset: MediaAsset;
}

export interface MediaQueryOptions {
  readonly text?: string;
  readonly kind?: MediaAsset['kind'];
  readonly binId?: string | null;
  readonly includeDescendants?: boolean;
  readonly sortBy?: 'name' | 'duration' | 'importedAt' | 'rating';
  readonly sortDirection?: 'asc' | 'desc';
  readonly limit?: number;
  readonly offset?: number;
}

export interface MediaQueryResult {
  readonly items: readonly ResolvedMediaLibraryEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CreateMediaBinOptions { readonly name: string; readonly parentId?: string | null }
export interface UpdateMediaBinOptions { readonly name?: string; readonly parentId?: string | null }
export interface UpdateMediaMetadataOptions {
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly rating?: number;
}
export interface ReplaceMediaLocationOptions {
  readonly path: string;
  readonly copied: boolean;
  readonly sourceIdentity?: MediaSourceIdentity;
}

function options(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidArgument('Options must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalidArgument(`Unknown option: ${key}`);
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw invalidArgument('Expected a valid ID');
}

function requireBin(project: Project, binId: string | null): void {
  if (binId === null) return;
  identifier(binId);
  if (!project.mediaLibrary?.bins.some((bin) => bin.id === binId)) throw notFound('Media bin', binId);
}

function requireAsset(project: Project, assetId: string): MediaAsset {
  identifier(assetId);
  const asset = project.media.find((item) => item.id === assetId);
  if (!asset) throw notFound('Media asset', assetId);
  return asset;
}

function library(project: Project): MediaLibrary {
  return project.mediaLibrary ?? { version: 1, bins: [], entries: [] };
}

function metadata(project: Project, assetId: string): MediaLibraryEntry {
  return project.mediaLibrary?.entries.find((entry) => entry.assetId === assetId)
    ?? { assetId, binId: null, description: '', tags: [], rating: 0 };
}

function resolve(project: Project, asset: MediaAsset): ResolvedMediaLibraryEntry {
  const entry = metadata(project, asset.id);
  return { ...entry, tags: [...entry.tags], asset };
}

function withEntry(project: Project, entry: MediaLibraryEntry): Project {
  const current = library(project);
  return { ...project, mediaLibrary: { ...current, entries: [...current.entries.filter((item) => item.assetId !== entry.assetId), entry] } };
}

/** Import and optional bin membership form one validated undoable mutation. */
export function addMediaAsset(store: EditorStore, asset: MediaAsset, binId?: string | null): MediaAsset {
  store.mutate('media', [asset.id], (project) => {
    if (binId !== undefined) requireBin(project, binId);
    const next = { ...project, media: [...project.media, asset] };
    return binId == null ? next : withEntry(next, { assetId: asset.id, binId, description: '', tags: [], rating: 0 });
  });
  return asset;
}

export function listMediaBins(store: EditorStore): readonly MediaBin[] {
  return (store.project.mediaLibrary?.bins ?? []).map((bin) => ({ ...bin }));
}

export function createMediaBin(store: EditorStore, opts: CreateMediaBinOptions): MediaBin {
  options(opts, ['name', 'parentId']);
  const bin: MediaBin = { id: newId('bin'), name: opts.name, parentId: opts.parentId === undefined ? null : opts.parentId };
  store.mutate('media', [bin.id], (project) => {
    requireBin(project, bin.parentId);
    const current = library(project);
    return { ...project, mediaLibrary: { ...current, bins: [...current.bins, bin] } };
  });
  return bin;
}

export function updateMediaBin(store: EditorStore, binId: string, opts: UpdateMediaBinOptions): MediaBin {
  identifier(binId); options(opts, ['name', 'parentId']);
  let result: MediaBin;
  store.mutate('media', [binId], (project) => {
    requireBin(project, binId);
    const current = library(project), before = current.bins.find((bin) => bin.id === binId)!;
    result = { ...before, ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}) };
    requireBin(project, result.parentId);
    if (result.name === before.name && result.parentId === before.parentId) return project;
    return { ...project, mediaLibrary: { ...current, bins: current.bins.map((bin) => bin.id === binId ? result : bin) } };
  });
  return result!;
}

export function removeMediaBin(store: EditorStore, binId: string): void {
  identifier(binId);
  store.mutate('media', [binId], (project) => {
    requireBin(project, binId);
    const current = library(project);
    if (current.bins.some((bin) => bin.parentId === binId) || current.entries.some((entry) => entry.binId === binId)) {
      throw new EditorError('CONFLICT', 'Only empty bins can be removed', { binId });
    }
    return { ...project, mediaLibrary: { ...current, bins: current.bins.filter((bin) => bin.id !== binId) } };
  });
}

export function assignMediaBin(store: EditorStore, assetIds: readonly string[], binId: string | null): readonly ResolvedMediaLibraryEntry[] {
  if (!Array.isArray(assetIds) || assetIds.length === 0) throw invalidArgument('assetIds must be a nonempty array');
  assetIds.forEach(identifier);
  if (new Set(assetIds).size !== assetIds.length) throw invalidArgument('assetIds must be unique');
  store.mutate('media', assetIds, (project) => {
    requireBin(project, binId);
    for (const assetId of assetIds) requireAsset(project, assetId);
    const changed = assetIds.filter((assetId) => metadata(project, assetId).binId !== binId);
    if (!changed.length) return project;
    const current = library(project), changedIds = new Set(changed);
    return { ...project, mediaLibrary: { ...current, entries: [
      ...current.entries.filter((entry) => !changedIds.has(entry.assetId)),
      ...changed.map((assetId) => ({ ...metadata(project, assetId), binId })),
    ] } };
  });
  return assetIds.map((assetId) => resolve(store.project, requireAsset(store.project, assetId)));
}

export function updateMediaMetadata(store: EditorStore, assetId: string, opts: UpdateMediaMetadataOptions): ResolvedMediaLibraryEntry {
  identifier(assetId); options(opts, ['name', 'description', 'tags', 'rating']);
  if (opts.name !== undefined && (typeof opts.name !== 'string' || !opts.name.trim() || opts.name.includes('\0'))) throw invalidArgument('name must be a nonempty string');
  if (opts.tags !== undefined && !Array.isArray(opts.tags)) throw invalidArgument('tags must be an array');
  store.mutate('media', [assetId], (project) => {
    const asset = requireAsset(project, assetId), before = metadata(project, assetId);
    const entry: MediaLibraryEntry = { ...before,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.tags !== undefined ? { tags: [...opts.tags] } : {}),
      ...(opts.rating !== undefined ? { rating: opts.rating } : {}),
    };
    const nameChanged = opts.name !== undefined && opts.name !== asset.name;
    const entryChanged = entry.description !== before.description || entry.rating !== before.rating
      || entry.tags.length !== before.tags.length || entry.tags.some((tag, i) => tag !== before.tags[i]);
    if (!nameChanged && !entryChanged) return project;
    const next = nameChanged ? { ...project, media: project.media.map((item) => item.id === assetId ? { ...item, name: opts.name! } : item) } : project;
    return entryChanged ? withEntry(next, entry) : next;
  });
  return resolve(store.project, requireAsset(store.project, assetId));
}

/** Pure deterministic query; absent extension remains absent even after reads. */
export function queryMedia(store: EditorStore, opts: MediaQueryOptions = {}): MediaQueryResult {
  options(opts, ['text', 'kind', 'binId', 'includeDescendants', 'sortBy', 'sortDirection', 'limit', 'offset']);
  if (opts.text !== undefined && (typeof opts.text !== 'string' || opts.text.length > 4096 || opts.text.includes('\0'))) throw invalidArgument('text must be a string of at most 4096 characters');
  if (opts.kind !== undefined && !['video', 'audio', 'image'].includes(opts.kind)) throw invalidArgument('Unknown media kind');
  if (opts.includeDescendants !== undefined && typeof opts.includeDescendants !== 'boolean') throw invalidArgument('includeDescendants must be boolean');
  if (opts.includeDescendants && opts.binId === undefined) throw invalidArgument('includeDescendants requires a bin filter');
  const sortBy = opts.sortBy === undefined ? 'name' : opts.sortBy, direction = opts.sortDirection === undefined ? 'asc' : opts.sortDirection;
  const limit = opts.limit === undefined ? 100 : opts.limit, offset = opts.offset === undefined ? 0 : opts.offset;
  if (!['name', 'duration', 'importedAt', 'rating'].includes(sortBy)) throw invalidArgument('Unknown media sort');
  if (!['asc', 'desc'].includes(direction)) throw invalidArgument('Unknown sort direction');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw invalidArgument('limit must be an integer from 1 to 1000');
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidArgument('offset must be a nonnegative safe integer');
  const project = store.project, selectedBins = new Set<string | null>();
  if (opts.binId !== undefined) {
    requireBin(project, opts.binId); selectedBins.add(opts.binId);
    if (opts.includeDescendants) {
      // The validated graph is acyclic and at most 256 nodes.
      const bins = project.mediaLibrary?.bins ?? [];
      for (let size = -1; size !== selectedBins.size;) {
        size = selectedBins.size;
        for (const bin of bins) if (selectedBins.has(bin.parentId)) selectedBins.add(bin.id);
      }
    }
  }
  const text = opts.text?.trim().toLowerCase() ?? '';
  const rows = project.media.map((asset) => resolve(project, asset)).filter((row) =>
    (opts.kind === undefined || row.asset.kind === opts.kind)
    && (opts.binId === undefined || selectedBins.has(row.binId))
    && (!text || [row.asset.name, row.description, ...row.tags].some((value) => value.toLowerCase().includes(text))));
  const compare = (a: string | number, b: string | number): number => a < b ? -1 : a > b ? 1 : 0;
  const sortValue = (row: ResolvedMediaLibraryEntry): string | number => sortBy === 'name' ? row.asset.name.toLowerCase()
    : sortBy === 'duration' ? row.asset.duration : sortBy === 'importedAt' ? row.asset.probedAt : row.rating;
  rows.sort((a, b) => compare(sortValue(a), sortValue(b)) * (direction === 'asc' ? 1 : -1) || compare(a.assetId, b.assetId));
  return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

/** Service verifies source bytes and probe compatibility before this single pointer edit. */
export function replaceMediaLocation(store: EditorStore, assetId: string, opts: ReplaceMediaLocationOptions): MediaAsset {
  identifier(assetId); options(opts, ['path', 'copied', 'sourceIdentity']);
  store.mutate('media', [assetId], (project) => {
    const asset = requireAsset(project, assetId);
    const next: MediaAsset = { ...asset, path: opts.path, copied: opts.copied,
      ...(opts.sourceIdentity !== undefined ? { sourceIdentity: { ...opts.sourceIdentity } } : {}) };
    const identitySame = next.sourceIdentity?.sha256 === asset.sourceIdentity?.sha256 && next.sourceIdentity?.size === asset.sourceIdentity?.size;
    if (next.path === asset.path && next.copied === asset.copied && identitySame) return project;
    return { ...project, media: project.media.map((item) => item.id === assetId ? next : item) };
  });
  return requireAsset(store.project, assetId);
}
