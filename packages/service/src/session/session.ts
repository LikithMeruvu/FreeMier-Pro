import { EditorStore } from '@freemier/engine';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext } from '../commands/context.js';
import { getWorkspaceSettingsOwner, type WorkspaceSettingsOwner } from '../settings/workspace.js';
import { getProjectProtectionOwner, type ProjectProtectionOwner } from '../recovery/protection.js';

export interface SessionOptions { workspace?: string; store?: EditorStore; workspaceSettings?: WorkspaceSettingsOwner; projectProtection?: ProjectProtectionOwner; onChange?: (event: { kind: string; ids: string[]; revision: number }) => void; }
/** Resolve the owning store and its workspace once, for every attached adapter. */
export function createSession(options: SessionOptions = {}) {
  const workspace = path.resolve(options.workspace ?? path.join(os.homedir(), '.freemier'));
  const store = options.store ?? EditorStore.create({ name: 'Untitled Project' });
  const workspaceSettings = options.workspaceSettings ?? getWorkspaceSettingsOwner(workspace);
  const projectProtection = options.projectProtection ?? getProjectProtectionOwner(store, workspace);
  const context: CommandContext = { store, workspace, workspaceSettings, projectProtection, notify: event => options.onChange?.({ ...event, revision: store.revision }) };
  return { store, workspace, workspaceSettings, projectProtection, context, dispose: () => projectProtection.dispose() };
}
