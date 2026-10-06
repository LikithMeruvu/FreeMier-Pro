import type { Timeline, Track, Clip } from '@freemier/shared';
import { captionDuration, EditorError, overlap } from '@freemier/shared';

/**
 * Pure timeline math. No I/O, no mutation — every function returns new values.
 *
 * The central invariant: clips on a track never overlap, and are always sorted
 * by start time. Every operation in this file preserves that invariant.
 */

/** Frame duration in seconds for a given fps. */
export const frameDuration = (fps: number): number => 1 / fps;

/** Round a time to the nearest frame boundary, avoiding float drift. */
export function quantize(time: number, fps: number): number {
  return Math.round(time * fps) / fps;
}

/** Sort clips by start time. Returns a new array. */
export function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/** End time of a clip on the timeline. */
export const clipEnd = (clip: Clip): number => clip.start + clip.duration;

/** Total duration of a track (end of its last clip). */
export function trackDuration(track: Track): number {
  return track.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/** Total duration of the timeline (longest track). */
export function timelineDuration(timeline: Timeline): number {
  const captionEnd = captionDuration(timeline.captions?.cues ?? [], timeline.fps);
  return Math.max(timeline.tracks.reduce((max, t) => Math.max(max, trackDuration(t)), 0), ...(timeline.titles ?? []).map((t) => t.end), captionEnd);
}

/**
 * Assert that no two clips on a track overlap, and that they are sorted.
 * Throws on violation — this is the engine's core invariant, enforced not assumed.
 */
export function assertNoOverlap(track: Track): void {
  const clips = sortClips(track.clips);
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1]!;
    const cur = clips[i]!;
    // Floating point tolerance: one microsecond is well below a frame.
    if (cur.start < clipEnd(prev) - 1e-6) {
      throw overlap(
        `Clips overlap on track "${track.name}"`,
        { trackId: track.id, prevId: prev.id, curId: cur.id, prevEnd: clipEnd(prev), curStart: cur.start },
      );
    }
  }
}

/** Find the clip covering a given timeline time, if any. */
export function clipAt(track: Track, time: number): Clip | null {
  for (const clip of track.clips) {
    if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) return clip;
  }
  return null;
}

/** Gaps (uncovered ranges) on a track, up to `until` seconds. */
export function gaps(track: Track, until: number): Array<{ start: number; end: number }> {
  const clips = sortClips(track.clips);
  const out: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.start > cursor + 1e-6) out.push({ start: cursor, end: clip.start });
    cursor = Math.max(cursor, clipEnd(clip));
  }
  if (cursor < until - 1e-6) out.push({ start: cursor, end: until });
  return out;
}

/**
 * Find the first time >= `desired` where a clip of `duration` fits without
 * overlapping existing clips. Used by add/insert operations.
 */
export function findFreeSlot(track: Track, desired: number, duration: number): number {
  const clips = sortClips(track.clips);
  let candidate = Math.max(0, desired);
  // Walk forward past any clip that would collide.
  for (let guard = 0; guard <= clips.length; guard++) {
    const collide = clips.find(
      (c) => candidate < clipEnd(c) - 1e-6 && candidate + duration > c.start + 1e-6,
    );
    if (!collide) return candidate;
    candidate = clipEnd(collide);
  }
  return candidate;
}

/** Clamp a value into [min, max]. */
export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/** Validate that a clip's source window is coherent. */
export function validateClipWindow(clip: Clip, assetDuration: number): void {
  if (clip.duration <= 0) {
    throw new EditorError('INVALID_ARGUMENT', 'Clip duration must be positive', { clipId: clip.id });
  }
  if (clip.sourceIn < 0) {
    throw new EditorError('INVALID_ARGUMENT', 'sourceIn must be >= 0', { clipId: clip.id });
  }
  if (clip.sourceOut > assetDuration + 1e-6) {
    throw new EditorError('INVALID_ARGUMENT', 'sourceOut exceeds source media duration', {
      clipId: clip.id,
      sourceOut: clip.sourceOut,
      assetDuration,
    });
  }
  if (clip.sourceOut <= clip.sourceIn) {
    throw new EditorError('INVALID_ARGUMENT', 'sourceOut must be greater than sourceIn', {
      clipId: clip.id,
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
    });
  }
}
