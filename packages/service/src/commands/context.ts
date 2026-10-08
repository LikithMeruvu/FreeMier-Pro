import type { EditorStore } from '@freemier/engine';
import { z } from 'zod';

export interface CommandContext {
  store: EditorStore;
  /** Broadcast a change so the GUI can update live. */
  notify: (event: { kind: string; ids: string[] }) => void;
  /** Directory used for project files, exports, and caches. */
  workspace: string;
}

export interface CommandDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: CommandContext) => Promise<unknown>;
}
