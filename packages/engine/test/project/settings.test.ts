import { describe, expect, it } from 'vitest';
import { EditorError } from '@freemier/shared';
import { EditorStore, createEmptyProject } from '../../src/project/store.js';
import { updateProjectSettings } from '../../src/project/settings.js';
import { addTrack, reorderTrack } from '../../src/timeline/tracks.js';

describe('project settings and track order', () => {
  it('updates settings atomically and restores authored content with one undo', () => {
    const store = new EditorStore(createEmptyProject({ width: 640, height: 360 }));
    const original = store.project;
    updateProjectSettings(store, { name: 'Edited', width: 1280, height: 720 });
    expect(store.project.name).toBe('Edited');
    expect(store.project.timeline.width).toBe(1280);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.project).toEqual(original);
  });

  it('refuses fps changes for authored timeline timing without state or history changes', () => {
    const store = new EditorStore(createEmptyProject());
    store.mutate('timeline', ['timed'], (p) => ({ ...p, timeline: { ...p.timeline, markers: [{ id: 'mark1', time: 1, label: 'Cue', color: '#ffffff', notes: '' }] } }));
    const before = store.state;
    expect(() => updateProjectSettings(store, { fps: 24 })).toThrow(EditorError);
    expect(store.state).toBe(before);
  });

  it('reorders tracks in one undo and refuses locked neighbors', () => {
    const store = new EditorStore(createEmptyProject());
    const third = addTrack(store, 'video', 'V2');
    const before = store.project.timeline.tracks.map((track) => [track.id, track.order]);
    reorderTrack(store, third.id, 'down');
    expect(store.project.timeline.tracks.find((track) => track.id === third.id)!.order).toBe(1);
    store.undo();
    expect(store.project.timeline.tracks.map((track) => [track.id, track.order])).toEqual(before);
  });

  it('keeps unrelated equal-order video compositing stable while reordering audio tracks', () => {
    const store = new EditorStore(createEmptyProject());
    const video = store.project.timeline.tracks.find((track) => track.kind === 'video')!;
    const audio = store.project.timeline.tracks.find((track) => track.kind === 'audio')!;
    const secondVideo = addTrack(store, 'video', 'V2');
    const secondAudio = addTrack(store, 'audio', 'A2');
    store.load({ ...store.project, timeline: { ...store.project.timeline, tracks: store.project.timeline.tracks.map((track) => ({ ...track, order: track.id === video.id || track.id === secondVideo.id ? 1 : 0, locked: track.id === video.id || track.id === secondVideo.id })) } });
    const exportedVideoOrder = () => [...store.project.timeline.tracks].sort((a, b) => a.order - b.order).filter((track) => track.kind === 'video').map((track) => track.id);
    const before = exportedVideoOrder();
    expect(before).toEqual([video.id, secondVideo.id]);
    reorderTrack(store, secondAudio.id, 'down');
    expect(exportedVideoOrder()).toEqual(before);
    expect(store.project.timeline.tracks.find((track) => track.id === audio.id)!.order).not.toBe(store.project.timeline.tracks.find((track) => track.id === secondAudio.id)!.order);
  });
});
