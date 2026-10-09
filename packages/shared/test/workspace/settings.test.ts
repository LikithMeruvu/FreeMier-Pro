import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_LAYOUT, normalizeWorkspaceLayoutName, patchWorkspaceLayout, validateStoredWorkspaceSettings, validateWorkspaceLayout } from '../../src/workspace/settings.js';

const stored = () => ({ version: 1 as const, revision: 0, current: structuredClone(DEFAULT_WORKSPACE_LAYOUT), layouts: [] as { id: string; name: string; layout: typeof DEFAULT_WORKSPACE_LAYOUT }[] });

describe('workspace settings contracts', () => {
  it('provides an immutable canonical default and applies strict nested patches to fresh values', () => {
    expect(DEFAULT_WORKSPACE_LAYOUT).toEqual({ mode: 'edit', browser: 'project', panels: { library: true, source: true, inspector: true, transitions: true }, libraryWidth: 245, inspectorWidth: 304, timelineHeight: null, sourceRatio: .5, timelineZoom: 90, snap: true, grid: true });
    expect(Object.isFrozen(DEFAULT_WORKSPACE_LAYOUT.panels)).toBe(true);
    const changed = patchWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, { panels: { library: false }, timelineHeight: null });
    expect(changed.panels).toEqual({ library: false, source: true, inspector: true, transitions: true });
    expect(changed).not.toBe(DEFAULT_WORKSPACE_LAYOUT);
    expect(() => patchWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, { panels: { surprise: true } })).toThrow(/unknown/);
    expect(() => patchWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, { timelineHeight: undefined })).toThrow();
  });
  it('rejects malformed objects, unknown fields, invalid enums, nonfinite and out of range numbers', () => {
    for (const value of [null, [], 'layout', { ...DEFAULT_WORKSPACE_LAYOUT, extra: true }, { ...DEFAULT_WORKSPACE_LAYOUT, panels: [] }, { ...DEFAULT_WORKSPACE_LAYOUT, sourceRatio: NaN }, { ...DEFAULT_WORKSPACE_LAYOUT, timelineZoom: Infinity }, { ...DEFAULT_WORKSPACE_LAYOUT, timelineZoom: 19.9 }, { ...DEFAULT_WORKSPACE_LAYOUT, libraryWidth: 421 }, { ...DEFAULT_WORKSPACE_LAYOUT, mode: 'workspace' }]) expect(() => validateWorkspaceLayout(value)).toThrow();
    expect(() => validateWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, sourceRatio: .2 })).not.toThrow();
    expect(() => validateWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, sourceRatio: .8 })).not.toThrow();
    expect(() => validateWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, timelineZoom: 20.5 })).not.toThrow();
    expect(() => validateWorkspaceLayout(Object.assign(Object.create({ inherited: true }), DEFAULT_WORKSPACE_LAYOUT))).toThrow();
    const symbolKeyed = { ...DEFAULT_WORKSPACE_LAYOUT, [Symbol('extra')]: true };
    expect(() => validateWorkspaceLayout(symbolKeyed)).toThrow();
    const missing = { ...DEFAULT_WORKSPACE_LAYOUT } as Record<string, unknown>;
    delete missing.grid;
    expect(() => validateWorkspaceLayout(missing)).toThrow(/missing required field/);
    expect(() => validateWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, panels: { ...DEFAULT_WORKSPACE_LAYOUT.panels, source: 1 } })).toThrow();
  });
  it('normalizes names and validates stored version, revision, count, IDs, and case-insensitive name uniqueness', () => {
    expect(normalizeWorkspaceLayoutName('  Cafe\u0301  ')).toBe('Café');
    expect(() => normalizeWorkspaceLayoutName('<b>Title</b>')).toThrow();
    const data = stored();
    data.layouts.push({ id: 'layout_01', name: 'Café', layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT) });
    validateStoredWorkspaceSettings(data);
    for (const invalid of [
      { ...data, version: 2 }, { ...data, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...data, layouts: [...data.layouts, { id: 'next', name: 'café', layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT) }] },
      { ...data, layouts: [...data.layouts, { id: 'layout_01', name: 'Other', layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT) }] },
      { ...data, extra: 'no' },
      { ...data, current: { mode: 'edit' } },
      { ...data, layouts: Array.from({ length: 25 }, (_, i) => ({ id: `id${i}`, name: `Layout ${i}`, layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT) })) },
      { ...data, layouts: [{ id: 'bad id', name: 'Okay', layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT) }] },
      { ...data, layouts: [{ id: 'valid', name: '  Not canonical ', layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT) }] },
      { ...data, layouts: [{ id: 'valid', name: 'Okay', layout: { ...structuredClone(DEFAULT_WORKSPACE_LAYOUT), extra: 1 } }] },
    ]) expect(() => validateStoredWorkspaceSettings(invalid)).toThrow();
    const symbolKeyed = Object.assign({ ...stored() }, { [Symbol('extra')]: true });
    expect(() => validateStoredWorkspaceSettings(symbolKeyed)).toThrow();
    expect(() => validateStoredWorkspaceSettings({})).toThrow(/missing required field/);
  });
});
