import { replaceMediaLocation } from '@freemier/engine';
import { hashMediaSource, probeMedia } from '@freemier/media';
import type { MediaAsset } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandContext } from '../commands/context.js';

export interface RelinkOptions {
  assetId: string;
  path: string;
  expectedRevision?: number;
  acceptUnverified?: boolean;
}

function assertCompatible(asset: MediaAsset, candidate: MediaAsset, ctx: CommandContext): void {
  for (const field of ['kind', 'width', 'height', 'hasAudio', 'sampleRate', 'videoCodec', 'audioCodec'] as const) {
    if (asset[field] !== candidate[field]) throw new EditorError('CONFLICT', 'Replacement media properties differ', { field, expected: asset[field], actual: candidate[field] });
  }
  const tolerance = .5 / Math.max(1, asset.fps);
  if (Math.abs(asset.duration - candidate.duration) > tolerance || Math.abs(asset.fps - candidate.fps) > 1e-6)
    throw new EditorError('CONFLICT', 'Replacement duration or frame rate differs');
  for (const track of ctx.store.project.timeline.tracks) for (const clip of track.clips) {
    if (clip.assetId === asset.id && clip.sourceOut > candidate.duration + tolerance)
      throw new EditorError('CONFLICT', 'Replacement does not cover an edited source range', { clipId: clip.id });
  }
}

/** Verify first; switch only one asset location in the owning store. */
export async function relinkMedia(ctx: CommandContext, options: RelinkOptions): Promise<MediaAsset> {
  const asset = ctx.store.project.media.find((item) => item.id === options.assetId);
  if (!asset) throw new EditorError('NOT_FOUND', 'Media asset not found', { assetId: options.assetId });
  if (options.expectedRevision !== undefined && ctx.store.revision !== options.expectedRevision)
    throw new EditorError('CONFLICT', 'Project changed; refresh before relinking');
  if (!asset.sourceIdentity && !options.acceptUnverified)
    throw new EditorError('CONFLICT', 'This older asset has no saved file identity. Explicitly accept an unverified replacement or choose a newer verified import.');
  const source = path.resolve(options.path);
  let changed = false, staged: string | null = null, committed = false;
  let stagedIdentity: { dev: number; ino: number; directory: string } | null = null;
  // Undo restores snapshot revisions. Any intervening event, including undo,
  // invalidates this asynchronous operation even if the revision repeats.
  const unsubscribe = ctx.store.subscribe(() => { changed = true; });
  try {
    const identity = await hashMediaSource(source);
    if (asset.sourceIdentity && (identity.sha256 !== asset.sourceIdentity.sha256 || identity.size !== asset.sourceIdentity.size))
      throw new EditorError('CONFLICT', 'Replacement bytes do not match the imported file identity');
    const candidate = await probeMedia(source, { id: asset.id });
    assertCompatible(asset, candidate, ctx);
    const after = await hashMediaSource(source);
    if (identity.sha256 !== after.sha256 || identity.size !== after.size)
      throw new EditorError('CONFLICT', 'Replacement changed while it was being checked');
    let location = source;
    if (asset.copied) {
      const workspace = await fs.realpath(ctx.workspace);
      const mediaDirectory = path.join(workspace, 'media');
      await fs.mkdir(mediaDirectory, { recursive: true });
      const actualDirectory = await fs.realpath(mediaDirectory);
      if (!actualDirectory.startsWith(workspace + path.sep)) throw new EditorError('IO_ERROR', 'Project media directory is outside the owning workspace');
      const filename = `${asset.id}-${randomUUID()}${path.extname(asset.path)}`;
      const destination = path.join(actualDirectory, filename);
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      staged = destination;
      const created = await fs.lstat(destination);
      stagedIdentity = { dev: created.dev, ino: created.ino, directory: actualDirectory };
      const copied = await hashMediaSource(destination);
      if (copied.sha256 !== identity.sha256 || copied.size !== identity.size)
        throw new EditorError('CONFLICT', 'Replacement changed while it was being copied');
      location = filename;
    }
    if (changed) throw new EditorError('CONFLICT', 'Project changed while checking media; refresh and try again');
    const updated = replaceMediaLocation(ctx.store, asset.id, { path: location, copied: asset.copied, sourceIdentity: identity });
    committed = true;
    return updated;
  } finally {
    unsubscribe();
    // Only a file exclusively created by this operation can be removed.
    // Existing copies remain intact for undo; no recursive cleanup occurs.
    if (staged && stagedIdentity && !committed) {
      try {
        const current = await fs.lstat(staged);
        if (await fs.realpath(path.dirname(staged)) === stagedIdentity.directory && current.isFile() && current.dev === stagedIdentity.dev && current.ino === stagedIdentity.ino) await fs.unlink(staged);
      } catch { /* Keep uncertain or externally replaced paths untouched. */ }
    }
  }
}
