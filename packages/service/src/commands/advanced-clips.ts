import { duplicateClip, rollClips, slipClip } from '@freemier/engine';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';

const property = z.enum(['x', 'y', 'scale', 'rotation', 'opacity']);
const params = z.record(z.union([z.number().finite(), z.string(), z.boolean()]));
const clipId = z.string();
const ok = (data: Record<string, unknown>) => ({ ok: true, ...data });
export const ADVANCED_CLIPS_COMMANDS: CommandDefinition[] = [
  { name: 'clip_slip', title: 'Slip source window', description: 'Shift the source in/out together without changing timeline position or duration. Delta is frame aligned and source bounded.', inputSchema: { clipId, delta: z.number().finite() }, handler: async (a, c) => ok({ clip: slipClip(c.store, a.clipId as string, a.delta as number) }) },
  { name: 'clip_roll', title: 'Roll adjacent edit', description: 'Move the shared boundary of adjacent clips, keeping their outer timeline endpoints fixed. Atomic and source bounded. Animated right-hand clips require clearing curves/fades first.', inputSchema: { leftClipId: z.string(), rightClipId: z.string(), at: z.number().finite().min(0) }, handler: async (a, c) => { const [left, right] = rollClips(c.store, a.leftClipId as string, a.rightClipId as string, a.at as number); return ok({ left, right }); } },
  { name: 'clip_duplicate', title: 'Duplicate clip', description: 'Deep-copy a clip, transforms and effects into an unoccupied range. Default position is immediately after the original.', inputSchema: { clipId, start: z.number().finite().min(0).optional(), trackId: z.string().optional() }, handler: async (a, c) => ok({ clip: duplicateClip(c.store, a.clipId as string, a.start as number | undefined, a.trackId as string | undefined) }) }
];
