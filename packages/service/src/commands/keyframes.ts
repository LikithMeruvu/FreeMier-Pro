import { findClip, removeKeyframe, setKeyframe } from '@freemier/engine';
import { EASINGS, EditorError, type TransformProperty } from '@freemier/shared';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';

const property = z.enum(['x', 'y', 'scale', 'rotation', 'opacity']);
const params = z.record(z.union([z.number().finite(), z.string(), z.boolean()]));
const clipId = z.string();
const ok = (data: Record<string, unknown>) => ({ ok: true, ...data });
export const KEYFRAMES_COMMANDS: CommandDefinition[] = [
  { name: 'keyframe_set', title: 'Set transform keyframe', description: 'Upsert a frame-aligned clip-local transform keyframe. The preceding key owns easing into the next key; values clamp before/after the curve. One undo step.', inputSchema: { clipId, property, time: z.number().finite().min(0), value: z.number().finite(), easing: z.enum(EASINGS).optional() }, handler: async (a, c) => ok({ clip: setKeyframe(c.store, a.clipId as string, a.property as TransformProperty, a.time as number, a.value as number, a.easing as typeof EASINGS[number] | undefined) }) },
  { name: 'keyframe_remove', title: 'Remove transform keyframe', description: 'Remove a key at a frame-aligned local time. Removing the last key restores the static property value.', inputSchema: { clipId, property, time: z.number().finite().min(0) }, handler: async (a, c) => ok({ clip: removeKeyframe(c.store, a.clipId as string, a.property as TransformProperty, a.time as number) }) },
  { name: 'keyframe_list', title: 'Inspect transform curves', description: 'Read every transform curve, or one property, including static values and local-time keys.', inputSchema: { clipId, property: property.optional() }, handler: async (a, c) => { const found = findClip(c.store.project.timeline, a.clipId as string); if (!found) throw new EditorError('NOT_FOUND', 'Clip not found'); return ok({ transform: a.property ? { [a.property as string]: found.clip.transform[a.property as TransformProperty] } : found.clip.transform }); } }
];
