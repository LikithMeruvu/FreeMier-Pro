import {
  addClip,
  findClip,
  linkedPairFor,
  moveClip,
  removeClip,
  splitClip, trimClip
} from '@freemier/engine';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import { setClipAudio, setClipTransformValues } from '@freemier/engine';
import type { CommandDefinition } from './context.js';
import { ok } from './helpers.js';

export const CLIPS_COMMANDS: CommandDefinition[] = [
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
      const transform = setClipTransformValues(ctx.store, clipId, a as never);
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
      const clip = setClipAudio(ctx.store, clipId, a as never);
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
      const link = linkedPairFor(ctx.store.project.timeline, found.clip.id);
      const partnerId = link ? (link.videoClipId === found.clip.id ? link.audioClipId : link.videoClipId) : null;
      const partner = partnerId ? findClip(ctx.store.project.timeline, partnerId) : null;
      return ok({ clip: found.clip, trackId: found.track.id, trackName: found.track.name, asset,
        link, linkedClip: partner?.clip ?? null, linkedTrackId: partner?.track.id ?? null });
    },
  }
];
