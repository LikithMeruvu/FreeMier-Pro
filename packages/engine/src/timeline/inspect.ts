import { type EditorStore } from '../project/store.js';
import {
  clipEnd,
  sortClips,
  timelineDuration
} from './queries.js';

export function inspectTimeline(store: EditorStore): Record<string, unknown> {
  const { timeline } = store.project;
  return {
    id: timeline.id,
    name: timeline.name,
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    duration: timelineDuration(timeline),
    trackCount: timeline.tracks.length,
    clipLinks: timeline.clipLinks ?? [],
    tracks: timeline.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      order: t.order,
      muted: t.muted,
      locked: t.locked,
      clipCount: t.clips.length,
      duration: t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0),
      clips: sortClips(t.clips).map((c) => ({
        id: c.id,
        assetId: c.assetId,
        start: c.start,
        duration: c.duration,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        label: c.label,
      })),
    })),
  };
}
