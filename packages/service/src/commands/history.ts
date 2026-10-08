import type { CommandDefinition } from './context.js';
import { ok } from './helpers.js';

export const HISTORY_COMMANDS: CommandDefinition[] = [
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
  }
];
