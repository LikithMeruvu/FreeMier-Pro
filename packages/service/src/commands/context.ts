import type { EditorStore } from '@freemier/engine';
import { z } from 'zod';
import type { WorkspaceSettingsOwner } from '../settings/workspace.js';

export interface CommandContext {
  store: EditorStore;
  /** Broadcast a change so the GUI can update live. */
  notify: (event: { kind: string; ids: string[] }) => void;
  /** Directory used for project files, exports, and caches. */
  workspace: string;
  /** Shared service-owned preferences, independent of the editable project. */
  workspaceSettings?: WorkspaceSettingsOwner;
}

export interface CommandDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: CommandContext) => Promise<unknown>;
}
