import { addTransition, updateTransition, removeTransition, queryTransitions } from '@freemier/engine';
import { EditorError } from '@freemier/shared';
import { z } from 'zod';
import type { CommandContext, CommandDefinition } from './context.js';
import { ok } from './helpers.js';

const revision = z.number().int().min(0).optional().describe('Refuse if the owning project revision changed; refresh before retrying');
const frames = z.number().int().min(2).describe('Total transition length in sequence frames, including both sides of the cut');
const alignment = z.enum(['center', 'start', 'end']).describe('center straddles the cut; start begins at the cut; end finishes at the cut');
function checkRevision(a: Record<string, unknown>, ctx: CommandContext): void {
  if (a.expectedRevision !== undefined && a.expectedRevision !== ctx.store.revision)
    throw new EditorError('CONFLICT', 'Project changed; refresh before editing transitions');
}

export const TRANSITION_CATALOG = {
  types: [
    { type: 'dissolve', title: 'Video dissolve', description: 'Linear premultiplied picture and alpha blend between adjacent clips on one video track.' },
    { type: 'audio_crossfade', title: 'Audio crossfade', description: 'Complementary linear volume gains between adjacent audio-bearing clips on one audio track.' },
  ],
  alignments: ['center', 'start', 'end'],
  timing: 'integer sequence frames; fixed cut and total timeline length; extra frames/samples come from real source handles',
  maxCount: 256,
  profile: 'same-track adjacent unit-speed clips; dissolves require matching constant video/sequence frame rates (images exempt); static transforms, opacity and supported static effects',
  validation: 'source bounds, frame alignment, interval overlap and linked member locks; edits breaking a transition require removing it first',
  nativePreflight: 'actual selected-stream coverage is checked before export; missing or unverifiable handles are refused',
  audioCompanion: 'author audio transitions explicitly; a video dissolve does not automatically create an audio crossfade',
  unsupported: ['mixed video frame rates in dissolves', 'variable or off-grid video timestamps in dissolves', 'participating transform keyframes', 'enabled clip audio/video fades', 'overlapping transition intervals on one track', 'speed changes', 'wipes', 'third-party transition plugins', 'invented or frozen source handles'],
};

export const TRANSITION_COMMANDS: CommandDefinition[] = [
  {
    name: 'transition_add', title: 'Add transition',
    description: 'Add an undoable video dissolve or linear audio crossfade between chronological adjacent clips on the same unlocked track. Uses real extra source handles without moving the cut or changing project length. Linked partner locks also apply. Participant keyframes and enabled fades are currently refused.',
    inputSchema: { leftClipId: z.string().describe('Clip before the cut'), rightClipId: z.string().describe('Next clip after the cut on the same track'), type: z.enum(['dissolve', 'audio_crossfade']), durationFrames: frames, alignment: alignment.optional(), expectedRevision: revision },
    handler: async (a, ctx) => {
      checkRevision(a, ctx);
      const transition = addTransition(ctx.store, { leftClipId: a.leftClipId as string, rightClipId: a.rightClipId as string, type: a.type as 'dissolve' | 'audio_crossfade', durationFrames: a.durationFrames as number, alignment: a.alignment as 'center' | 'start' | 'end' | undefined });
      ctx.notify({ kind: 'timeline', ids: [transition.id] });
      return ok({ transition, revision: ctx.store.revision });
    },
  },
  {
    name: 'transition_update', title: 'Update transition timing',
    description: 'Change a transition length in frames or alignment around its fixed cut in one undoable edit. Rechecks real source handles and interval overlap before changing history. All participant and linked partner tracks must be unlocked.',
    inputSchema: { transitionId: z.string(), durationFrames: frames.optional(), alignment: alignment.optional(), expectedRevision: revision },
    handler: async (a, ctx) => {
      checkRevision(a, ctx);
      const transition = updateTransition(ctx.store, a.transitionId as string, { durationFrames: a.durationFrames as number | undefined, alignment: a.alignment as 'center' | 'start' | 'end' | undefined });
      ctx.notify({ kind: 'timeline', ids: [transition.id] });
      return ok({ transition, revision: ctx.store.revision });
    },
  },
  {
    name: 'transition_remove', title: 'Remove transition',
    description: 'Remove a transition in one undoable edit and restore the original hard cut. Both clips keep their positions, durations and source ranges. Participant and linked partner locks are respected; source files are untouched.',
    inputSchema: { transitionId: z.string(), expectedRevision: revision },
    handler: async (a, ctx) => { checkRevision(a, ctx); removeTransition(ctx.store, a.transitionId as string); ctx.notify({ kind: 'timeline', ids: [a.transitionId as string] }); return ok({ removed: true, revision: ctx.store.revision }); },
  },
  {
    name: 'transition_list', title: 'Inspect transitions',
    description: 'Read authored transitions, optionally filtered by track or participant clip. Returns the owning project revision without changing history. Length is stored in sequence frames; interval timing is derived from the fixed cut and alignment.',
    inputSchema: { trackId: z.string().optional(), clipId: z.string().optional() },
    handler: async (a, ctx) => ok({ transitions: queryTransitions(ctx.store, { trackId: a.trackId as string | undefined, clipId: a.clipId as string | undefined }), revision: ctx.store.revision }),
  },
  {
    name: 'transition_catalog', title: 'Discover supported transitions',
    description: 'Read the supported video dissolve and audio crossfade profiles, timing units, alignments, source-handle requirements and explicit unsupported features. Availability describes these bounded built-ins and does not imply arbitrary vendor/plugin compatibility.',
    inputSchema: {}, handler: async () => ok({ catalog: TRANSITION_CATALOG }),
  },
];
