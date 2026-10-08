import {
  addTrack, removeTrack,
  updateTrack
} from '@freemier/engine';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';
import { ok } from './helpers.js';

export const TRACKS_COMMANDS: CommandDefinition[] = [
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
  }
];
