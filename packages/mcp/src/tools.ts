import { z } from 'zod';
import type { EditorStore } from '@freemier/engine';
import {
  addClip, removeClip, moveClip, splitClip, trimClip, addTrack, removeTrack,
  updateClip, updateTrack, addMediaAsset, inspectTimeline, findClip, clipAt, gaps,
} from '@freemier/engine';
import { importMedia, probeMedia, extractThumbnail, extractWaveform, exportProject } from '@freemier/ffmpeg';
import { timelineDuration } from '@freemier/engine';
import { saveProject, loadProject, projectDir } from '@freemier/engine';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { newMediaId, defaultTransform, EditorError } from '@freemier/shared';
import type { Clip } from '@freemier/shared';
import { PROFESSIONAL_TOOLS } from './professional-tools.js';
import { MARKER_TOOLS } from './marker-tools.js';
import { TITLE_TOOLS } from './title-tools.js';
import { CAPTION_TOOLS } from './caption-tools.js';

/**
 * The MCP tool surface.
 *
 * Design rules:
 *  - Tool names are verbs an agent would naturally reach for.
 *  - Every tool returns JSON; nothing returns a formatted string for a machine
 *    to re-parse.
 *  - Read tools are separate from write tools so an agent can inspect cheaply.
 *  - Errors are structured and actionable — an agent must be able to recover.
 */

export interface ToolContext {
  store: EditorStore;
  /** Broadcast a change so the GUI can update live. */
  notify: (event: { kind: string; ids: string[] }) => void;
  /** Directory used for project files, exports, and caches. */
  workspace: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

const ok = (data: Record<string, unknown>) => ({ ok: true, ...data });

/** Require that a project has at least one clip before exporting. */
function assertExportable(store: EditorStore): void {
  if (timelineDuration(store.project.timeline) <= 0) {
    throw new EditorError('INVALID_ARGUMENT', 'Timeline is empty — add media or visible text before exporting.');
  }
}

export const TOOLS: ToolDef[] = [
  ...PROFESSIONAL_TOOLS,
  ...MARKER_TOOLS,
  ...TITLE_TOOLS,
  ...CAPTION_TOOLS,
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
    name: 'timeline_at_time', title: 'Clips at time',
    description: 'Find every clip covering an absolute timeline time, including its source timestamp and track.',
    inputSchema: { time: z.number().min(0).describe('Timeline time in seconds') },
    handler: async (a, ctx) => ok({ clips: ctx.store.project.timeline.tracks.flatMap((track) => {
      const clip = clipAt(track, a.time as number);
      return clip ? [{ clip, trackId: track.id, muted: track.muted, sourceTime: clip.sourceIn + (a.time as number) - clip.start }] : [];
    }) }),
  },
  {
    name: 'timeline_gaps', title: 'Track gaps',
    description: 'List uncovered ranges on a track up to a chosen timeline time. Defaults to project duration.',
    inputSchema: { trackId: z.string(), until: z.number().min(0).optional() },
    handler: async (a, ctx) => {
      const track = ctx.store.project.timeline.tracks.find((t) => t.id === a.trackId);
      if (!track) throw new EditorError('NOT_FOUND', `Track not found: ${a.trackId}`);
      const until = (a.until as number | undefined) ?? timelineDuration(ctx.store.project.timeline);
      return ok({ gaps: gaps(track, until).filter((g) => g.start < until).map((g) => ({ start: g.start, end: Math.min(g.end, until) })) });
    },
  },
  {
    name: 'track_inspect', title: 'Inspect track',
    description: 'Read a complete track including order, muted/locked state, and full clip transforms.',
    inputSchema: { trackId: z.string() },
    handler: async (a, ctx) => {
      const track = ctx.store.project.timeline.tracks.find((t) => t.id === a.trackId);
      if (!track) throw new EditorError('NOT_FOUND', `Track not found: ${a.trackId}`);
      return ok({ track });
    },
  },
  // ---------------------------------------------------------------- project
  {
    name: 'project_info',
    title: 'Project info',
    description:
      'Get the current project: name, id, resolution, fps, duration, media count, and track count. Start here to learn what is loaded.',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const p = ctx.store.project;
      return ok({
        id: p.id,
        name: p.name,
        fps: p.timeline.fps,
        width: p.timeline.width,
        height: p.timeline.height,
        duration: timelineDuration(p.timeline),
        mediaCount: p.media.length,
        trackCount: p.timeline.tracks.length,
        revision: ctx.store.revision,
        canUndo: ctx.store.canUndo,
        canRedo: ctx.store.canRedo,
      });
    },
  },
  {
    name: 'project_create',
    title: 'Create project',
    description: 'Replace the current project with a new empty one. Discards the current timeline.',
    inputSchema: {
      name: z.string().optional().describe('Project name'),
      fps: z.number().positive().optional().describe('Frame rate, default 30'),
      width: z.number().int().positive().optional().describe('Output width, default 1920'),
      height: z.number().int().positive().optional().describe('Output height, default 1080'),
    },
    handler: async (a, ctx) => {
      const { EditorStore: Store, createEmptyProject } = await import('@freemier/engine');
      const project = createEmptyProject({
        name: a.name as string | undefined,
        fps: a.fps as number | undefined,
        width: a.width as number | undefined,
        height: a.height as number | undefined,
      });
      ctx.store.load(project);
      ctx.notify({ kind: 'project', ids: [project.id] });
      return ok({ id: project.id, name: project.name });
    },
  },
  {
    name: 'project_save',
    title: 'Save project',
    description: 'Save the current project and copied media to disk. Defaults to <workspace>/project.freemier. Legacy .palmier paths are supported.',
    inputSchema: { path: z.string().optional().describe('Destination project directory') },
    handler: async (a, ctx) => {
      const target = (a.path as string | undefined) ?? `${ctx.workspace}/project`;
      const snapshot = ctx.store.project;
      const portableMedia = await Promise.all(snapshot.media.map(async (asset) => {
        if (!asset.copied) return asset;
        const source = path.isAbsolute(asset.path) ? asset.path : path.resolve(ctx.workspace, 'media', asset.path);
        const mediaDir = path.join(projectDir(target), 'media'); await fs.mkdir(mediaDir, { recursive: true });
        const filename = `${asset.id}${path.extname(asset.path)}`;
        const destination = path.join(mediaDir, filename);
        if (path.resolve(source) !== path.resolve(destination)) await fs.copyFile(source, destination);
        return { ...asset, path: filename };
      }));
      const written = await saveProject({ ...snapshot, media: portableMedia }, target);
      return ok({ savedTo: written });
    },
  },
  {
    name: 'project_load',
    title: 'Load project',
    description: 'Load a .freemier or legacy .palmier project into the owning store.',
    inputSchema: { path: z.string().describe('Path to the project directory') },
    handler: async (a, ctx) => {
      const loaded = await loadProject(a.path as string);
      const media = await Promise.all(loaded.media.map(async (asset) => {
        if (!asset.copied || path.isAbsolute(asset.path)) return asset;
        const packaged = path.resolve(projectDir(a.path as string), 'media', asset.path);
        try { await fs.access(packaged); return { ...asset, path: packaged }; } catch { return asset; }
      }));
      const project = { ...loaded, media };
      ctx.store.load(project);
      ctx.notify({ kind: 'project', ids: [project.id] });
      return ok({ id: project.id, name: project.name, mediaCount: project.media.length });
    },
  },
  {
    name: 'undo',
    title: 'Undo',
    description: 'Undo the last timeline change.',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const did = ctx.store.undo();
      if (did) ctx.notify({ kind: 'undo', ids: [] });
      return ok({ undone: did, canUndo: ctx.store.canUndo, canRedo: ctx.store.canRedo });
    },
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redo the last undone change.',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const did = ctx.store.redo();
      if (did) ctx.notify({ kind: 'redo', ids: [] });
      return ok({ redone: did, canUndo: ctx.store.canUndo, canRedo: ctx.store.canRedo });
    },
  },

  // ------------------------------------------------------------------ media
  {
    name: 'media_import',
    title: 'Import media',
    description:
      'Import a media file (video, audio, or image) into the project library and return its asset id and probed metadata. Use the returned assetId with clip_add.',
    inputSchema: {
      path: z.string().describe('Absolute path to the media file'),
      copyIntoProject: z.boolean().optional().describe('Copy the file into the project instead of referencing it'),
    },
    handler: async (a, ctx) => {
      const asset = await importMedia(a.path as string, {
        copyTo: a.copyIntoProject ? `${ctx.workspace}/media` : undefined,
      });
      addMediaAsset(ctx.store, asset);
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
  },

  // --------------------------------------------------------------- timeline
  {
    name: 'timeline_inspect',
    title: 'Inspect timeline',
    description:
      'Get the full timeline structure: every track and every clip with its id, start, duration, and source window. This is the primary way to understand what is currently edited.',
    inputSchema: {},
    handler: async (_a, ctx) => ok(inspectTimeline(ctx.store) as Record<string, unknown>),
  },
  {
    name: 'timeline_duration',
    title: 'Timeline duration',
    description: 'Get the total duration of the timeline in seconds.',
    inputSchema: {},
    handler: async (_a, ctx) => ok({ duration: timelineDuration(ctx.store.project.timeline) }),
  },
  {
    name: 'track_add',
    title: 'Add track',
    description: 'Add a new video or audio track.',
    inputSchema: {
      kind: z.enum(['video', 'audio']).describe('Track kind'),
      name: z.string().optional().describe('Display name, e.g. V2'),
    },
    handler: async (a, ctx) => {
      const track = addTrack(ctx.store, a.kind as 'video' | 'audio', a.name as string | undefined);
      ctx.notify({ kind: 'track', ids: [track.id] });
      return ok({ track: { id: track.id, name: track.name, kind: track.kind } });
    },
  },
  {
    name: 'track_remove',
    title: 'Remove track',
    description: 'Remove a track and every clip on it.',
    inputSchema: { trackId: z.string().describe('Track id') },
    handler: async (a, ctx) => {
      const removed = removeTrack(ctx.store, a.trackId as string);
      ctx.notify({ kind: 'track', ids: [a.trackId as string] });
      return ok({ removed });
    },
  },
  {
    name: 'track_update',
    title: 'Update track',
    description: 'Rename a track, or mute/lock it.',
    inputSchema: {
      trackId: z.string().describe('Track id'),
      name: z.string().optional(),
      muted: z.boolean().optional(),
      locked: z.boolean().optional(),
      order: z.number().int().min(0).max(1024).optional(),
    },
    handler: async (a, ctx) => {
      const trackId = a.trackId as string;
      const track = updateTrack(ctx.store, trackId, { name: a.name as string | undefined, muted: a.muted as boolean | undefined, locked: a.locked as boolean | undefined, order: a.order as number | undefined });
      ctx.notify({ kind: 'track', ids: [trackId] });
      return ok({ updated: trackId, track });
    },
  },

  // ------------------------------------------------------------------ clips
  {
    name: 'clip_add',
    title: 'Add clip',
    description:
      'Place a media asset onto a track. If the requested position overlaps an existing clip the clip is pushed to the next free slot (pass strict to fail instead). Returns the created clip id.',
    inputSchema: {
      trackId: z.string().describe('Target track id (from timeline_inspect)'),
      assetId: z.string().describe('Media asset id (from media_import)'),
      start: z.number().min(0).optional().describe('Start time in seconds; defaults to the end of the track'),
      duration: z.number().positive().optional().describe('Length in seconds; defaults to the rest of the source'),
      sourceIn: z.number().min(0).optional().describe('Offset into the source media, default 0'),
      label: z.string().optional().describe('Optional label'),
      strict: z.boolean().optional().describe('Fail instead of relocating when the position is occupied'),
      ripple: z.boolean().optional().describe('Insert at a boundary/gap and shift later clips right; split a clip before inserting inside it'),
    },
    handler: async (a, ctx) => {
      const clip = addClip(ctx.store, {
        trackId: a.trackId as string,
        assetId: a.assetId as string,
        start: a.start as number | undefined,
        duration: a.duration as number | undefined,
        sourceIn: a.sourceIn as number | undefined,
        label: (a.label as string | undefined) ?? null,
        strict: a.strict as boolean | undefined,
        ripple: a.ripple as boolean | undefined,
      });
      ctx.notify({ kind: 'clip', ids: [clip.id] });
      return ok({ clip });
    },
  },
  {
    name: 'clip_remove',
    title: 'Remove clip',
    description: 'Remove a clip. With ripple=true, later clips shift left to close the gap.',
    inputSchema: {
      clipId: z.string().describe('Clip id'),
      ripple: z.boolean().optional().describe('Close the gap by shifting later clips left'),
    },
    handler: async (a, ctx) => {
      const removed = removeClip(ctx.store, a.clipId as string, Boolean(a.ripple));
      if (removed) ctx.notify({ kind: 'clip', ids: [a.clipId as string] });
      return ok({ removed });
    },
  },
  {
    name: 'clip_move',
    title: 'Move clip',
    description: 'Move a clip to a new start time, optionally onto a different track. Fails if the destination overlaps.',
    inputSchema: {
      clipId: z.string().describe('Clip id'),
      start: z.number().min(0).describe('New start time in seconds'),
      trackId: z.string().optional().describe('Target track id; omit to keep the current track'),
      ripple: z.boolean().optional().describe('Close the source gap and insert at a destination boundary/gap; start is measured after removal'),
    },
    handler: async (a, ctx) => {
      const clip = moveClip(ctx.store, a.clipId as string, a.start as number, a.trackId as string | undefined, Boolean(a.ripple));
      ctx.notify({ kind: 'clip', ids: [clip.id] });
      return ok({ clip });
    },
  },
  {
    name: 'clip_split',
    title: 'Split clip',
    description: 'Split a clip in two at an absolute timeline time. Returns both resulting clips.',
    inputSchema: {
      clipId: z.string().describe('Clip id'),
      at: z.number().min(0).describe('Timeline time in seconds to cut at (must be inside the clip)'),
    },
    handler: async (a, ctx) => {
      const [first, second] = splitClip(ctx.store, a.clipId as string, a.at as number);
      ctx.notify({ kind: 'clip', ids: [first.id, second.id] });
      return ok({ first, second });
    },
  },
  {
    name: 'clip_trim',
    title: 'Trim clip',
    description:
      'Move a clip edge. edge="in" moves the left edge and keeps the right pinned; edge="out" moves the right edge and keeps the left pinned. Time is absolute on the timeline.',
    inputSchema: {
      clipId: z.string().describe('Clip id'),
      edge: z.enum(['in', 'out']).describe('Which edge to move'),
      time: z.number().min(0).describe('New absolute time in seconds for that edge'),
    },
    handler: async (a, ctx) => {
      const clip = trimClip(ctx.store, a.clipId as string, a.edge as 'in' | 'out', a.time as number);
      ctx.notify({ kind: 'clip', ids: [clip.id] });
      return ok({ clip });
    },
  },
  {
    name: 'clip_set_transform',
    title: 'Set clip transform',
    description:
      'Set a clip transform. Position is normalized: x/y of 0 centers the clip, ±0.5 moves it half a frame. scale 1 fills the output. opacity is 0..1. rotation is degrees.',
    inputSchema: {
      clipId: z.string().describe('Clip id'),
      x: z.number().optional().describe('Horizontal offset, normalized'),
      y: z.number().optional().describe('Vertical offset, normalized'),
      scale: z.number().positive().optional().describe('Uniform scale; 0.5 is half size'),
      rotation: z.number().optional().describe('Rotation in degrees'),
      opacity: z.number().min(0).max(1).optional().describe('Opacity 0..1'),
    },
    handler: async (a, ctx) => {
      const clipId = a.clipId as string;
      const found = findClip(ctx.store.project.timeline, clipId);
      if (!found) throw new EditorError('NOT_FOUND', `Clip not found: ${clipId}`, { clipId });

      const base = found.clip.transform;
      const prop = (current: { value: number; keyframes: readonly unknown[] }, next: unknown) =>
        typeof next === 'number' ? { value: next, keyframes: [] } : current;

      const transform = {
        x: prop(base.x, a.x),
        y: prop(base.y, a.y),
        scale: prop(base.scale, a.scale),
        rotation: prop(base.rotation, a.rotation),
        opacity: prop(base.opacity, a.opacity),
      } as Clip['transform'];

      updateClip(ctx.store, clipId, { transform });
      ctx.notify({ kind: 'clip', ids: [clipId] });
      return ok({ transform });
    },
  },
  {
    name: 'clip_set_audio',
    title: 'Set clip audio',
    description: 'Set a clip volume or label. volume 1 is unity, 0 is silent.',
    inputSchema: {
      clipId: z.string().describe('Clip id'),
      volume: z.number().min(0).max(4).optional().describe('Volume multiplier'),
      label: z.string().optional().describe('Clip label'),
    },
    handler: async (a, ctx) => {
      const clipId = a.clipId as string;
      const patch: Record<string, unknown> = {};
      if (typeof a.volume === 'number') patch.volume = a.volume;
      if (typeof a.label === 'string') patch.label = a.label;
      const clip = updateClip(ctx.store, clipId, patch as never);
      ctx.notify({ kind: 'clip', ids: [clipId] });
      return ok({ clip });
    },
  },
  {
    name: 'clip_inspect',
    title: 'Inspect clip',
    description: 'Get one clip in full, including its transform and the source asset metadata.',
    inputSchema: { clipId: z.string().describe('Clip id') },
    handler: async (a, ctx) => {
      const found = findClip(ctx.store.project.timeline, a.clipId as string);
      if (!found) throw new EditorError('NOT_FOUND', `Clip not found: ${a.clipId}`, { clipId: a.clipId });
      const asset = ctx.store.project.media.find((m) => m.id === found.clip.assetId) ?? null;
      return ok({ clip: found.clip, trackId: found.track.id, trackName: found.track.name, asset });
    },
  },

  // ----------------------------------------------------------------- export
  {
    name: 'export_video',
    title: 'Export video',
    description:
      'Render the timeline to a video file. Returns the output path and duration. This is the final step — call it once the edit is complete.',
    inputSchema: {
      outputPath: z.string().optional().describe('Destination file; defaults to <workspace>/export-<timestamp>.mp4'),
      codec: z.enum(['h264', 'h265', 'prores']).optional().describe('Video codec, default h264'),
      crf: z.number().min(0).max(51).optional().describe('Quality: lower is better. Default 20'),
      preset: z.string().optional().describe('Encoder preset, e.g. ultrafast/fast/medium/slow'),
      captionPolicy: z.enum(['burn-in', 'none', 'sidecar']).optional().describe('Subtitle output: burn-in (default), none, or create a neighboring .srt file'),
    },
    handler: async (a, ctx) => {
      assertExportable(ctx.store);
      const out = (a.outputPath as string | undefined) ?? `${ctx.workspace}/export-${Date.now()}.mp4`;
      const result = await exportProject(ctx.store.project, {
        outputPath: out,
        mediaDirectory: `${ctx.workspace}/media`,
        textCacheDirectory: `${ctx.workspace}/cache/text`,
        codec: a.codec as 'h264' | 'h265' | 'prores' | undefined,
        crf: a.crf as number | undefined,
        preset: a.preset as string | undefined,
        captionPolicy: a.captionPolicy as 'burn-in' | 'none' | 'sidecar' | undefined,
      });
      return ok({
        outputPath: result.outputPath,
        durationSeconds: result.durationSeconds,
        clipCount: result.clipCount,
        ...(result.sidecarPath ? { sidecarPath: result.sidecarPath } : {}),
      });
    },
  },
  {
    name: 'export_preview',
    title: 'Preview export plan',
    description:
      'Describe export duration, clip count and actual FFmpeg arguments without rendering video. Text glyph assets may be prepared in the cache. Use this before a long export.',
    inputSchema: {
      outputPath: z.string().optional(),
      codec: z.enum(['h264', 'h265', 'prores']).optional(),
      crf: z.number().min(0).max(51).optional(),
      captionPolicy: z.enum(['burn-in', 'none', 'sidecar']).optional(),
    },
    handler: async (a, ctx) => {
      assertExportable(ctx.store);
      const { buildExportArgs, describeExport, prepareCaptionLayers, prepareTitleLayers } = await import('@freemier/ffmpeg');
      const timeline = ctx.store.project.timeline, width = timeline.width, height = timeline.height;
      const captionPolicy = a.captionPolicy as 'burn-in' | 'none' | 'sidecar' | undefined ?? 'burn-in';
      const preparedTextLayers = await prepareTitleLayers(timeline.titles ?? [], width, height, `${ctx.workspace}/cache/text`);
      if (captionPolicy === 'burn-in' && timeline.captions?.enabled) preparedTextLayers.push(...await prepareCaptionLayers(timeline.captions.cues, timeline.captions.style, width, height, `${ctx.workspace}/cache/text`));
      const options = {
        preparedTextLayers,
        outputPath: (a.outputPath as string | undefined) ?? `${ctx.workspace}/preview.mp4`,
        mediaDirectory: `${ctx.workspace}/media`,
        codec: a.codec as 'h264' | 'h265' | 'prores' | undefined,
        crf: a.crf as number | undefined,
        captionPolicy,
      };
      const summary = describeExport(ctx.store.project, options), plan = buildExportArgs(ctx.store.project, options);
      return ok({ summary, duration: plan.duration, captionPolicy });
    },
  },
];

/** Resolve a media reference that may be an asset id or a raw path. */
function resolveMediaPath(assetIdOrPath: string, ctx: ToolContext): string {
  const asset = ctx.store.project.media.find((m) => m.id === assetIdOrPath);
  if (asset) {
    if (asset.copied) return `${ctx.workspace}/media/${asset.path}`;
    return asset.path;
  }
  // Not an asset id — treat it as a path.
  if (assetIdOrPath.includes('/') || assetIdOrPath.includes('\\') || assetIdOrPath.includes('.')) {
    return assetIdOrPath;
  }
  throw new EditorError('NOT_FOUND', `No media asset or path matching: ${assetIdOrPath}`, {
    reference: assetIdOrPath,
    availableAssets: ctx.store.project.media.map((m) => m.id),
  });
}

export { resolveMediaPath };
export { newMediaId, defaultTransform };
