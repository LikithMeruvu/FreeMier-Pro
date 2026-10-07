import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorStore, inspectEffectPreset, importEffectPreset, applyEffectPreset, removeEffectPreset, captureEffectPreset, getEffectPreset, addMediaAsset, addClip, addEffect, updateTrack, saveProject, loadProject, validateProject } from '../src/index.js';

const document = () => ({ format: 'freemier-effect-preset', version: 1, name: 'Neutral monochrome', description: 'Remove color, then adjust contrast. <script> is plain text.', author: 'Independent fixture', tags: ['monochrome'], media: 'video', effects: [{ type: 'grayscale', enabled: true, params: {} }, { type: 'color_adjust', enabled: false, params: { contrast: 1.2 } }] });
const content = () => JSON.stringify(document());
function setup() {
  const store = EditorStore.create({ fps: 10 });
  const asset = addMediaAsset(store, { id: 'fixture', name: 'Video', path: 'independent.mp4', copied: false, kind: 'video', duration: 10, width: 96, height: 64, fps: 10, hasAudio: true, sampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', probedAt: 0 });
  const clip = addClip(store, { trackId: 'trk_video_1', assetId: asset.id, duration: 2 });
  const audio = addClip(store, { trackId: 'trk_audio_1', assetId: asset.id, duration: 2 });
  return { store, clip, audio };
}
describe('portable effect presets', () => {
  it('normalizes defaults and identity independently of whitespace/object-key order', () => {
    const p = document(), a = inspectEffectPreset(content()), b = inspectEffectPreset('\uFEFF' + JSON.stringify({ effects: p.effects, media: p.media, tags: p.tags, author: p.author, description: p.description, name: p.name, version: p.version, format: p.format }, null, 2));
    expect(a.id).toBe(b.id); expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.document.effects[1]!.params).toEqual({ brightness: 0, contrast: 1.2, saturation: 1, gamma: 1 });
    expect(a.descriptionSource).toBe('declared-author-text'); expect(a.effects[1]!.descriptor.params.gamma).toMatchObject({ min: .1, max: 10 });
    expect(a.executableCode).toBe(false); expect(a.dependencies).toEqual([]);
  });
  it('inspection never mutates, duplicate content imports are no-ops, and removal undoes without altering applied effects', () => {
    const { store, clip } = setup(), before = store.state; inspectEffectPreset(content()); expect(store.state).toBe(before);
    const preset = importEffectPreset(store, content()), imported = store.state; let events = 0; store.subscribe(() => events++);
    expect(importEffectPreset(store, content())).toBe(preset); expect(store.state).toBe(imported); expect(events).toBe(0);
    const applied = applyEffectPreset(store, preset.id, clip.id); removeEffectPreset(store, preset.id);
    expect(store.project.timeline.tracks.find((t) => t.kind === 'video')!.clips[0]!.effects).toEqual(applied.effects);
    expect(() => getEffectPreset(store, preset.id)).toThrow(/not found/); store.undo(); expect(getEffectPreset(store, preset.id)).toEqual(preset);
  });
  it('append/replace apply once with fresh IDs, preserve flags/order, and undo/redo exact snapshots', () => {
    const { store, clip } = setup(); addEffect(store, clip.id, 'sepia', { amount: .3 });
    const preset = importEffectPreset(store, content()), before = store.state; let events = 0; store.subscribe(() => events++);
    const applied = applyEffectPreset(store, preset.id, clip.id); expect(store.revision).toBe(before.revision + 1); expect(events).toBe(1);
    expect(applied.effects.map((e) => e.type)).toEqual(['sepia', 'grayscale', 'color_adjust']); expect(applied.effects[2]!.enabled).toBe(false);
    const after = store.state; store.undo(); expect(store.state).toBe(before); store.redo(); expect(store.state).toBe(after);
    const replaced = applyEffectPreset(store, preset.id, clip.id, 'replace'); expect(replaced.effects.map((e) => e.type)).toEqual(['grayscale', 'color_adjust']); expect(replaced.effects[0]!.id).not.toBe(applied.effects[1]!.id);
  });
  it('refuses locked, wrong-media, oversized and invalid-duration complete stacks before state/history/events change', () => {
    const { store, clip, audio } = setup(), preset = importEffectPreset(store, content());
    function refused(action: () => unknown) { const before = store.state, undo = store.canUndo, redo = store.canRedo; let events = 0; const unsub = store.subscribe(() => events++); expect(action).toThrow(); expect(store.state).toBe(before); expect([store.canUndo, store.canRedo, events]).toEqual([undo, redo, 0]); unsub(); }
    refused(() => applyEffectPreset(store, preset.id, audio.id));
    updateTrack(store, 'trk_video_1', { locked: true }); refused(() => applyEffectPreset(store, preset.id, clip.id)); updateTrack(store, 'trk_video_1', { locked: false });
    const p = document(); p.effects.push({ type: 'video_fade', enabled: true, params: { start: 1, duration: 2 } } as never); const fade = importEffectPreset(store, JSON.stringify(p));
    refused(() => applyEffectPreset(store, fade.id, clip.id));
    for (let i = 0; i < 31; i++) addEffect(store, clip.id, 'grayscale'); refused(() => applyEffectPreset(store, preset.id, clip.id));
  });
  it.each([
    ['vendor format', { format: 'prfpset' }], ['future version', { version: 2 }], ['unknown key', { script: 'execute()' }], ['empty name', { name: ' ' }], ['long description', { description: 'a'.repeat(4097) }], ['duplicate tags', { tags: ['x', 'x'] }], ['wrong media', { media: 'audio' }], ['empty stack', { effects: [] }], ['unknown effect', { effects: [{ type: 'tracking', enabled: true, params: {} }] }], ['null param', { effects: [{ type: 'blur', enabled: true, params: { radius: null } }] }], ['out of bounds', { effects: [{ type: 'blur', enabled: true, params: { radius: 100 } }] }], ['prototype param', { effects: [{ type: 'blur', enabled: true, params: JSON.parse('{"__proto__":1}') }] }], ['missing enabled', { effects: [{ type: 'blur', params: {} }] }], ['null entry', { effects: [null] }],
  ])('rejects %s without importing', (_label, patch) => {
    const { store } = setup(), before = store.state; expect(() => importEffectPreset(store, JSON.stringify({ ...document(), ...patch }))).toThrow(); expect(store.state).toBe(before);
  });
  it('rejects malformed/oversized input and caps the library', () => {
    const { store } = setup(); expect(() => importEffectPreset(store, '{')).toThrow(); expect(() => inspectEffectPreset('a'.repeat(65537))).toThrow(/64 KiB/);
    for (let i = 0; i < 64; i++) importEffectPreset(store, JSON.stringify({ ...document(), name: 'Preset ' + i }));
    const before = store.state; expect(() => importEffectPreset(store, content())).toThrow(/64/); expect(store.state).toBe(before);
  });
  it('captures portable settings without clip IDs or source paths', () => {
    const { store, clip } = setup(); addEffect(store, clip.id, 'sepia');
    const p = captureEffectPreset(store, clip.id, { name: 'Warm', description: 'Golden image', author: '', tags: [] });
    expect(p.effects).toEqual([{ type: 'sepia', params: { amount: 1 }, enabled: true }]); expect(JSON.stringify(p)).not.toContain('independent.mp4'); expect(JSON.stringify(p)).not.toContain(clip.id);
  });
  it('persists schema-1 libraries and refuses payload/hash tampering without replacing store', async () => {
    const { store } = setup(); importEffectPreset(store, content());
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-presets-'));
    try {
      const target = path.join(directory, 'Edit.freemier'); await saveProject(store.project, target); const loaded = await loadProject(target); expect(loaded.effectPresets).toEqual(store.project.effectPresets); expect(loaded.version).toBe(1);
      const bad = structuredClone(loaded); (bad.effectPresets![0]!.document as { description: string }).description = 'Tampered';
      const before = store.state; expect(() => store.load(bad)).toThrow(/effectPresets/); expect(store.state).toBe(before);
      expect(() => validateProject({ ...loaded, effectPresets: [...loaded.effectPresets!, ...loaded.effectPresets!] })).toThrow();
    } finally { expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
