import { addLinkedClip, linkClips, unlinkClip } from '@freemier/engine';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';
import { ok } from './helpers.js';

export const LINKED_MEDIA_COMMANDS: CommandDefinition[] = [
  {
    name: 'clip_add_linked',
    title: 'Place linked video and audio',
    description: 'Place one audio-bearing video asset on a video track and an audio track with identical timing and source range. Both clips form one undoable edit. Subsequent move, split, trim, slip, roll, duplicate and remove commands keep the pair aligned. Locked members and unsupported ripple propagation are refused atomically.',
    inputSchema: {
      assetId: z.string().describe('Audio-bearing video asset id from media_import'),
      videoTrackId: z.string().describe('Unlocked video track id'),
      audioTrackId: z.string().describe('Unlocked audio track id'),
      start: z.number().min(0).optional().describe('Sequence seconds; defaults to the end of both tracks'),
      duration: z.number().positive().optional().describe('Shared length in seconds; defaults to remaining source'),
      sourceIn: z.number().min(0).optional().describe('Shared source offset in seconds'),
      label: z.string().optional().describe('Label for both members'),
      strict: z.boolean().optional().describe('Refuse overlap instead of finding a common free slot'),
      ripple: z.boolean().optional().describe('Insert at a boundary/gap on both tracks; propagation must preserve all existing pairs'),
    },
    handler: async (a, ctx) => {
      const pair = addLinkedClip(ctx.store, {
        assetId: a.assetId as string, videoTrackId: a.videoTrackId as string,
        audioTrackId: a.audioTrackId as string, start: a.start as number | undefined,
        duration: a.duration as number | undefined, sourceIn: a.sourceIn as number | undefined,
        label: (a.label as string | undefined) ?? null,
        strict: a.strict as boolean | undefined, ripple: a.ripple as boolean | undefined,
      });
      ctx.notify({ kind: 'clip', ids: [pair.videoClip.id, pair.audioClip.id] });
      return ok({ ...pair });
    },
  },
  {
    name: 'clip_link', title: 'Link existing video and audio',
    description: 'Link an unlinked video clip and audio clip from the same audio-bearing video asset. Start, length and source range must already match. This aligned two-clip profile does not support offset or multiple-audio groups.',
    inputSchema: {
      videoClipId: z.string().describe('Unlinked clip on a video track'),
      audioClipId: z.string().describe('Aligned unlinked clip on an audio track'),
    },
    handler: async (a, ctx) => {
      const pair = linkClips(ctx.store, a.videoClipId as string, a.audioClipId as string);
      ctx.notify({ kind: 'clip', ids: [pair.videoClip.id, pair.audioClip.id] });
      return ok({ ...pair });
    },
  },
  {
    name: 'clip_unlink', title: 'Unlink video and audio',
    description: 'Remove a selected clip’s link without deleting either member or changing timing. Returns false when the clip is not linked. Both member tracks must be unlocked; one undo restores the link.',
    inputSchema: { clipId: z.string().describe('Either member of a linked pair') },
    handler: async (a, ctx) => {
      const unlinked = unlinkClip(ctx.store, a.clipId as string);
      if (unlinked) ctx.notify({ kind: 'clip', ids: [a.clipId as string] });
      return ok({ unlinked });
    },
  },
];
