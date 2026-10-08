import {
  clipAt, gaps,
  inspectTimeline,
  timelineDuration
} from '@freemier/engine';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';
import { ok } from './helpers.js';

export const TIMELINE_COMMANDS: CommandDefinition[] = [
  {
    name: 'timeline_at_time', title: 'Clips at time',
    description: 'Find every clip covering an absolute timeline time, including its source timestamp and track.',
    inputSchema: { time: z.number().min(0).describe('Timeline time in seconds') },
    handler: async (a, ctx) => ok({
      clips: ctx.store.project.timeline.tracks.flatMap((track) => {
        const clip = clipAt(track, a.time as number);
        return clip ? [{ clip, trackId: track.id, muted: track.muted, sourceTime: clip.sourceIn + (a.time as number) - clip.start }] : [];
      })
    }),
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
  }
];
