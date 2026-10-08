import {
  assignMediaBin, createMediaBin, listMediaBins, queryMedia, removeMediaBin,
  updateMediaBin, updateMediaMetadata,
} from '@freemier/engine';
import { findMediaCandidates, inspectMediaSource } from '@freemier/media';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import { relinkMedia } from '../library/relink.js';
import type { CommandContext, CommandDefinition } from './context.js';
import { ok, resolveAssetPath } from './helpers.js';

const binId = z.string().nullable().describe('Bin id; null is the project root');
const revision = z.number().int().min(0).optional().describe('Refuse if the owning project revision has changed');
function checkRevision(a: Record<string, unknown>, ctx: CommandContext): void {
  if (a.expectedRevision !== undefined && a.expectedRevision !== ctx.store.revision)
    throw new EditorError('CONFLICT', 'Project changed; refresh before editing the library');
}

export const MEDIA_LIBRARY_COMMANDS: CommandDefinition[] = [
  {
    name: 'media_bins', title: 'List project bins',
    description: 'List the project’s ordinary hierarchical bins. The root is implicit null; old projects without a library extension place every asset there.',
    inputSchema: {}, handler: async (_a, ctx) => ok({ bins: listMediaBins(ctx.store), revision: ctx.store.revision }),
  },
  {
    name: 'media_bin_create', title: 'Create media bin',
    description: 'Create an ordinary project folder under the root or another bin. Names are unique among siblings; this is one undoable project edit.',
    inputSchema: { name: z.string().min(1).max(120).describe('Folder name'), parentId: binId.optional(), expectedRevision: revision },
    handler: async (a, ctx) => { checkRevision(a, ctx); const bin = createMediaBin(ctx.store, { name: a.name as string, parentId: a.parentId as string | null | undefined }); ctx.notify({ kind: 'media', ids: [bin.id] }); return ok({ bin }); },
  },
  {
    name: 'media_bin_update', title: 'Rename or move media bin',
    description: 'Change a bin’s name or parent without moving source files. Cycles and conflicting sibling names are refused before an undoable mutation.',
    inputSchema: { binId: z.string(), name: z.string().min(1).max(120).optional(), parentId: binId.optional(), expectedRevision: revision },
    handler: async (a, ctx) => { checkRevision(a, ctx); const bin = updateMediaBin(ctx.store, a.binId as string, { name: a.name as string | undefined, ...(a.parentId === undefined ? {} : { parentId: a.parentId as string | null }) }); ctx.notify({ kind: 'media', ids: [bin.id] }); return ok({ bin }); },
  },
  {
    name: 'media_bin_delete', title: 'Remove empty media bin',
    description: 'Remove an empty bin. Bins with child bins or assigned assets are refused. No media files are deleted; undo restores the folder.',
    inputSchema: { binId: z.string(), expectedRevision: revision },
    handler: async (a, ctx) => { checkRevision(a, ctx); removeMediaBin(ctx.store, a.binId as string); ctx.notify({ kind: 'media', ids: [a.binId as string] }); return ok({ removed: true }); },
  },
  {
    name: 'media_assign_bin', title: 'Assign media to bin',
    description: 'Move one or more imported asset entries into a bin or the root in one undoable edit. Source files and timeline clips stay in place.',
    inputSchema: { assetIds: z.array(z.string()).min(1).max(256), binId, expectedRevision: revision },
    handler: async (a, ctx) => { checkRevision(a, ctx); const assets = assignMediaBin(ctx.store, a.assetIds as string[], a.binId as string | null); ctx.notify({ kind: 'media', ids: a.assetIds as string[] }); return ok({ assets }); },
  },
  {
    name: 'media_metadata_update', title: 'Edit project media metadata',
    description: 'Edit an imported asset’s display name, description, tags or rating inside this project. Does not write XMP or modify the source media. One undo restores the metadata.',
    inputSchema: { assetId: z.string(), name: z.string().min(1).max(120).optional(), description: z.string().max(4096).optional(), tags: z.array(z.string().min(1).max(64)).max(32).optional(), rating: z.number().int().min(0).max(5).optional(), expectedRevision: revision },
    handler: async (a, ctx) => { checkRevision(a, ctx); const item = updateMediaMetadata(ctx.store, a.assetId as string, { name: a.name as string | undefined, description: a.description as string | undefined, tags: a.tags as string[] | undefined, rating: a.rating as number | undefined }); ctx.notify({ kind: 'media', ids: [a.assetId as string] }); return ok({ item }); },
  },
  {
    name: 'media_query', title: 'Search and sort project media',
    description: 'Search display names, descriptions and tags; filter by kind/bin with optional descendants; sort and paginate deterministically. This reads the owning project without changing history or source files.',
    inputSchema: { text: z.string().max(4096).optional(), binId: binId.optional(), includeChildren: z.boolean().optional(), kind: z.enum(['video', 'audio', 'image']).optional(), sortBy: z.enum(['name', 'duration', 'importedAt', 'rating']).optional(), sortDirection: z.enum(['asc', 'desc']).optional(), limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional() },
    handler: async (a, ctx) => { const { includeChildren, ...query } = a; const result = queryMedia(ctx.store, { ...query, ...(includeChildren === undefined ? {} : { includeDescendants: includeChildren }) } as Parameters<typeof queryMedia>[1]); return ok({ assets: result.items, total: result.total, limit: result.limit, offset: result.offset, revision: ctx.store.revision }); },
  },
  {
    name: 'media_availability', title: 'Inspect media file availability',
    description: 'Inspect imported files without editing the project or undo history. Default checks readability/existence/size; verify=true streams SHA-256 against saved identity. Older assets without identity remain explicitly unverified.',
    inputSchema: { assetIds: z.array(z.string()).min(1).max(256).optional(), verify: z.boolean().optional().describe('Hash file contents; may take time for large sources') },
    handler: async (a, ctx) => {
      const snapshot = ctx.store.project, observedRevision = ctx.store.revision;
      const selected = a.assetIds ? (a.assetIds as string[]).map((id) => { const asset = snapshot.media.find((item) => item.id === id); if (!asset) throw new EditorError('NOT_FOUND', 'Media asset not found', { assetId: id }); return asset; }) : snapshot.media;
      const observations = [];
      for (const asset of selected) observations.push({ assetId: asset.id, ...await inspectMediaSource(resolveAssetPath(asset, ctx.workspace), asset.sourceIdentity, Boolean(a.verify)) });
      return ok({ observations, revision: observedRevision, stale: ctx.store.project !== snapshot });
    },
  },
  {
    name: 'find_relink_candidates', title: 'Find verified replacement candidates',
    description: 'Search explicitly supplied directories within entry/depth/hash-byte limits. Size is only a hint; exact candidates require saved SHA-256 identity. Symlinks are skipped. Reports all matches/truncation and never selects a replacement automatically. Legacy assets need explicit location and unverified consent.',
    inputSchema: { assetId: z.string(), roots: z.array(z.string().min(1)).min(1).max(8), maxDepth: z.number().int().min(0).max(8).optional(), maxEntries: z.number().int().min(1).max(2000).optional(), maxHashBytes: z.number().int().min(1).max(1024 ** 3).optional() },
    handler: async (a, ctx) => { const snapshot = ctx.store.project, asset = snapshot.media.find((item) => item.id === a.assetId); if (!asset) throw new EditorError('NOT_FOUND', 'Media asset not found'); const observedRevision = ctx.store.revision; const result = await findMediaCandidates(asset.sourceIdentity, a.roots as string[], a); return ok({ ...result, assetId: asset.id, revision: observedRevision, stale: ctx.store.project !== snapshot }); },
  },
  {
    name: 'media_relink', title: 'Relink one imported asset',
    description: 'Verify replacement bytes and probed media facts before switching one asset location. Preserves clips/links/effects/keyframes. Known identities must match; legacy assets require explicit unverified consent. Copied media uses a new exclusive file and retains old bytes for undo. Refuses concurrent project edits.',
    inputSchema: { assetId: z.string(), path: z.string().min(1), expectedRevision: revision, acceptUnverified: z.boolean().optional().describe('Explicitly accept compatible replacement for a legacy asset without saved identity; never bypasses a known identity mismatch') },
    handler: async (a, ctx) => { const asset = await relinkMedia(ctx, a as unknown as Parameters<typeof relinkMedia>[1]); ctx.notify({ kind: 'media', ids: [asset.id] }); return ok({ asset }); },
  },
];
