import {
  addMediaAsset, listMediaBins
} from '@freemier/engine';
import { extractThumbnail, extractWaveform, importMedia, probeMedia } from '@freemier/media';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandDefinition } from './context.js';
import { ok, resolveMediaPath } from './helpers.js';

export const MEDIA_COMMANDS: CommandDefinition[] = [
  {
    name: 'media_probe', title: 'Probe media',
    description: 'Inspect a media file with ffprobe without importing it or changing the project.',
    inputSchema: { path: z.string().describe('Absolute media file path') },
    handler: async (a) => ok({ asset: await probeMedia(a.path as string) }),
  },
  {
    name: 'media_inspect', title: 'Inspect media asset',
    description: 'Read one imported media asset and the timeline clips referencing it.',
    inputSchema: { assetId: z.string().describe('Imported media asset id') },
    handler: async (a, ctx) => {
      const asset = ctx.store.project.media.find((m) => m.id === a.assetId);
      if (!asset) throw new EditorError('NOT_FOUND', `Media asset not found: ${a.assetId}`);
      return ok({ asset, clips: ctx.store.project.timeline.tracks.flatMap((t) => t.clips.filter((c) => c.assetId === asset.id).map((c) => ({ clipId: c.id, trackId: t.id }))) });
    },
  },
  {
    name: 'media_import',
    title: 'Import media',
    description:
      'Import a media file (video, audio, or image) into the project library and return its asset id and probed metadata. Use the returned assetId with clip_add.',
    inputSchema: {
      path: z.string().describe('Absolute path to the media file'),
      copyIntoProject: z.boolean().optional().describe('Copy the file into the project instead of referencing it'),
      binId: z.string().nullable().optional().describe('Import into this project bin atomically; null/omit means root'),
    },
    handler: async (a, ctx) => {
      const binId = a.binId as string | null | undefined;
      if (binId && !listMediaBins(ctx.store).some((bin) => bin.id === binId)) throw new EditorError('NOT_FOUND', 'Media bin not found', { binId });
      let changed = false;
      const unsubscribe = ctx.store.subscribe(() => { changed = true; });
      let asset;
      let committed = false;
      let copyTo: string | undefined;
      let staged: { file: string; dev: number; ino: number } | undefined;
      try { asset = await importMedia(a.path as string, {
        copyTo: a.copyIntoProject ? await (async () => {
          const workspace = await fs.realpath(ctx.workspace);
          await fs.mkdir(path.join(workspace, 'media'), { recursive: true });
          copyTo = await fs.realpath(path.join(workspace, 'media'));
          if (!copyTo.startsWith(workspace + path.sep)) throw new EditorError('IO_ERROR', 'Project media directory is outside the owning workspace');
          return copyTo;
        })() : undefined,
        onCopyCreated: (file, identity) => { staged = { file, ...identity }; },
      });
      if (changed) throw new EditorError('CONFLICT', 'Project changed while importing media; refresh and try again');
      addMediaAsset(ctx.store, asset, binId);
      committed = true;
      } finally {
        unsubscribe();
        // importMedia uses an exclusive fresh filename. Remove only this
        // uncommitted copy if an intervening edit prevented its registration.
        if (!committed && staged && copyTo && staged.file.startsWith(copyTo + path.sep)) {
          try {
            const current = await fs.lstat(staged.file);
            if (await fs.realpath(path.dirname(staged.file)) === copyTo && current.isFile() && current.dev === staged.dev && current.ino === staged.ino) await fs.unlink(staged.file);
          } catch { /* Keep uncertain or externally replaced paths untouched. */ }
        }
      }
      ctx.notify({ kind: 'media', ids: [asset.id] });
      return ok({ asset });
    },
  },
  {
    name: 'media_list',
    title: 'List media',
    description: 'List every media asset in the project library with its metadata.',
    inputSchema: {},
    handler: async (_a, ctx) => ok({ media: ctx.store.project.media }),
  },
  {
    name: 'media_thumbnail',
    title: 'Extract thumbnail',
    description:
      'Extract a still frame from a media asset as a JPEG. Returns the file path. Use this to see what a clip looks like.',
    inputSchema: {
      assetId: z.string().describe('Media asset id, or a direct file path'),
      atSeconds: z.number().min(0).optional().describe('Timestamp to grab, default 0'),
      size: z.number().int().positive().optional().describe('Thumbnail width in pixels, default 320'),
    },
    handler: async (a, ctx) => {
      const source = resolveMediaPath(a.assetId as string, ctx);
      const out = `${ctx.workspace}/cache/thumb-${Date.now()}.jpg`;
      await extractThumbnail(source, out, (a.atSeconds as number | undefined) ?? 0, (a.size as number | undefined) ?? 320);
      return ok({ path: out });
    },
  },
  {
    name: 'media_waveform',
    title: 'Extract waveform',
    description: 'Extract normalized audio peaks for a media asset, for drawing a waveform.',
    inputSchema: {
      assetId: z.string().describe('Media asset id, or a direct file path'),
      buckets: z.number().int().positive().max(10000).optional().describe('Number of peaks, default 600'),
    },
    handler: async (a, ctx) => {
      const source = resolveMediaPath(a.assetId as string, ctx);
      const peaks = await extractWaveform(source, (a.buckets as number | undefined) ?? 600);
      return ok({ buckets: peaks.length, peaks });
    },
  }
];
