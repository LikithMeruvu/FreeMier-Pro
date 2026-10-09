import { EditorError } from '../errors/index.js';

export interface WorkspaceLayout {
  readonly mode: 'edit' | 'color' | 'audio';
  readonly browser: 'project' | 'effects' | 'presets' | 'markers' | 'titles' | 'captions';
  readonly panels: {
    readonly library: boolean;
    readonly source: boolean;
    readonly inspector: boolean;
    readonly transitions: boolean;
  };
  readonly libraryWidth: number;
  readonly inspectorWidth: number;
  readonly timelineHeight: number | null;
  readonly sourceRatio: number;
  readonly timelineZoom: number;
  readonly snap: boolean;
  readonly grid: boolean;
}

export interface WorkspaceLayoutPatch {
  readonly mode?: WorkspaceLayout['mode'];
  readonly browser?: WorkspaceLayout['browser'];
  readonly panels?: Partial<WorkspaceLayout['panels']>;
  readonly libraryWidth?: number;
  readonly inspectorWidth?: number;
  readonly timelineHeight?: number | null;
  readonly sourceRatio?: number;
  readonly timelineZoom?: number;
  readonly snap?: boolean;
  readonly grid?: boolean;
}

export interface StoredWorkspaceLayout {
  readonly id: string;
  readonly name: string;
  readonly layout: WorkspaceLayout;
}

export interface StoredWorkspaceSettings {
  readonly version: 1;
  readonly revision: number;
  readonly current: WorkspaceLayout;
  readonly layouts: readonly StoredWorkspaceLayout[];
}

export interface WorkspaceSettingsSnapshot extends StoredWorkspaceSettings {
  readonly epoch: string;
  readonly readOnly: boolean;
  readonly persistenceError?: string;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

export const DEFAULT_WORKSPACE_LAYOUT: Readonly<WorkspaceLayout> = deepFreeze({
  mode: 'edit', browser: 'project',
  panels: { library: true, source: true, inspector: true, transitions: true },
  libraryWidth: 245, inspectorWidth: 304, timelineHeight: null,
  sourceRatio: 0.5, timelineZoom: 90, snap: true, grid: true,
});

const layoutKeys = ['mode', 'browser', 'panels', 'libraryWidth', 'inspectorWidth', 'timelineHeight', 'sourceRatio', 'timelineZoom', 'snap', 'grid'];
const panelKeys = ['library', 'source', 'inspector', 'transitions'];
const storedKeys = ['version', 'revision', 'current', 'layouts'];

function invalid(message: string): never { throw new EditorError('INVALID_ARGUMENT', message); }
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, requireAll = true): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid(`${label} contains an unknown own field`);
  }
  if (requireAll) for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${label} is missing required field: ${key}`);
}
function finiteRange(value: unknown, min: number, max: number, label: string, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(`${label} must be ${integer ? 'an integer' : 'a finite number'} from ${min} to ${max}`);
}

export function validateWorkspaceLayout(value: unknown): asserts value is WorkspaceLayout {
  if (!isRecord(value)) invalid('Workspace layout must be a plain object');
  exactKeys(value, layoutKeys, 'Workspace layout');
  if (value.mode !== 'edit' && value.mode !== 'color' && value.mode !== 'audio') invalid('Workspace mode is invalid');
  if (!['project', 'effects', 'presets', 'markers', 'titles', 'captions'].includes(value.browser as string)) invalid('Workspace browser is invalid');
  if (!isRecord(value.panels)) invalid('Workspace panels must be a plain object');
  exactKeys(value.panels, panelKeys, 'Workspace panels');
  for (const key of panelKeys) if (typeof value.panels[key] !== 'boolean') invalid(`Workspace panel ${key} must be boolean`);
  finiteRange(value.libraryWidth, 180, 420, 'Library width', true);
  finiteRange(value.inspectorWidth, 220, 520, 'Inspector width', true);
  if (value.timelineHeight !== null) finiteRange(value.timelineHeight, 180, 560, 'Timeline height', true);
  finiteRange(value.sourceRatio, 0.2, 0.8, 'Source ratio');
  finiteRange(value.timelineZoom, 20, 300, 'Timeline zoom');
  if (typeof value.snap !== 'boolean' || typeof value.grid !== 'boolean') invalid('Workspace snap and grid must be boolean');
}

export function patchWorkspaceLayout(current: WorkspaceLayout, patch: unknown): WorkspaceLayout {
  validateWorkspaceLayout(current);
  if (!isRecord(patch)) invalid('Workspace layout patch must be a plain object');
  exactKeys(patch, layoutKeys, 'Workspace layout patch', false);
  if (Object.hasOwn(patch, 'panels')) {
    if (!isRecord(patch.panels)) invalid('Workspace panels patch must be a plain object');
    exactKeys(patch.panels, panelKeys, 'Workspace panels patch', false);
  }
  const next = {
    ...current,
    ...patch,
    panels: Object.hasOwn(patch, 'panels') ? { ...current.panels, ...(patch.panels as Record<string, unknown>) } : { ...current.panels },
  };
  validateWorkspaceLayout(next);
  return next;
}

export function normalizeWorkspaceLayoutName(value: unknown): string {
  if (typeof value !== 'string') invalid('Workspace layout name must be text');
  const name = value.trim().normalize('NFC');
  if (name.length < 1 || name.length > 48 || /[\u0000-\u001f\u007f<>]/u.test(name)) invalid('Workspace layout name must be 1 to 48 display characters without control characters or markup brackets');
  return name;
}

export function validateStoredWorkspaceSettings(value: unknown): asserts value is StoredWorkspaceSettings {
  if (!isRecord(value)) invalid('Stored workspace settings must be a plain object');
  exactKeys(value, storedKeys, 'Stored workspace settings');
  if (value.version !== 1) invalid('Unsupported workspace settings version');
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) invalid('Workspace settings revision must be a nonnegative safe integer');
  validateWorkspaceLayout(value.current);
  if (!Array.isArray(value.layouts) || value.layouts.length > 24) invalid('Workspace layouts must be an array of at most 24 entries');
  const ids = new Set<string>(), names = new Set<string>();
  for (const entry of value.layouts) {
    if (!isRecord(entry)) invalid('Stored workspace layout must be a plain object');
    exactKeys(entry, ['id', 'name', 'layout'], 'Stored workspace layout');
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.id) || ids.has(entry.id)) invalid('Workspace layout IDs must be unique bounded opaque identifiers');
    const name = normalizeWorkspaceLayoutName(entry.name);
    if (name !== entry.name) invalid('Stored workspace layout names must already be trimmed and NFC-normalized');
    const folded = name.toLocaleLowerCase('und');
    if (names.has(folded)) invalid('Workspace layout names must be unique ignoring case');
    validateWorkspaceLayout(entry.layout);
    ids.add(entry.id); names.add(folded);
  }
}
