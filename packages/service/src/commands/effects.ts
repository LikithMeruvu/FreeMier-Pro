import { addEffect, findClip, removeEffect, updateEffect } from '@freemier/engine';
import { EditorError, EFFECT_CATALOG } from '@freemier/shared';
import { z } from 'zod';
import type { CommandDefinition } from './context.js';

const property = z.enum(['x', 'y', 'scale', 'rotation', 'opacity']);
const params = z.record(z.union([z.number().finite(), z.string(), z.boolean()]));
const clipId = z.string();
const ok = (data: Record<string, unknown>) => ({ ok: true, ...data });
export const EFFECTS_COMMANDS: CommandDefinition[] = [
  { name: 'effect_add', title: 'Add effect', description: 'Append an enabled effect from effect_catalog. Params are strictly validated; effects run in stored order. Video/audio effects require the matching track kind.', inputSchema: { clipId, type: z.string(), params: params.optional() }, handler: async (a, c) => ok({ effect: addEffect(c.store, a.clipId as string, a.type as string, a.params as Record<string, number | string | boolean> | undefined) }) },
  { name: 'effect_update', title: 'Update effect', description: 'Merge validated params and/or enable an effect. One undo step; no mutation on validation failure.', inputSchema: { clipId, effectId: z.string(), params: params.optional(), enabled: z.boolean().optional() }, handler: async (a, c) => ok({ effect: updateEffect(c.store, a.clipId as string, a.effectId as string, a.params as Record<string, number | string | boolean> | undefined, a.enabled as boolean | undefined) }) },
  { name: 'effect_remove', title: 'Remove effect', description: 'Remove one effect by id.', inputSchema: { clipId, effectId: z.string() }, handler: async (a, c) => ok({ clip: removeEffect(c.store, a.clipId as string, a.effectId as string) }) },
  { name: 'effect_list', title: 'Inspect ordered effects', description: 'Read a clip effect stack, including disabled entries.', inputSchema: { clipId }, handler: async (a, c) => { const found = findClip(c.store.project.timeline, a.clipId as string); if (!found) throw new EditorError('NOT_FOUND', 'Clip not found'); return ok({ effects: found.clip.effects }); } },
  { name: 'effect_catalog', title: 'Effect catalog', description: 'Read supported CPU export effects, bounded schemas and preview implementation requirements.', inputSchema: {}, handler: async () => ok({ effects: EFFECT_CATALOG }) }
];
