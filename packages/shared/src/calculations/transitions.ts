import { EditorError } from '../errors/index.js';
import type { Clip, MediaAsset, Timeline, Transition } from '../project/types.js';

/** Derived source and sequence window; never written into the project clips. */
export interface ClipRenderWindow {
  readonly start: number;
  readonly end: number;
  readonly sourceIn: number;
  readonly sourceOut: number;
  /** Add to window-relative time to recover the nominal clip-local origin. */
  readonly localTimeOffset: number;
}

export interface ResolvedTransition {
  readonly transition: Transition;
  readonly trackId: string;
  readonly left: Clip;
  readonly right: Clip;
  readonly cutFrame: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly durationFrames: number;
  readonly start: number;
  readonly end: number;
  readonly cut: number;
  readonly leftWindow: ClipRenderWindow;
  readonly rightWindow: ClipRenderWindow;
}

const EPSILON = 1e-6;
const conflict = (reason: string, details: Record<string, unknown> = {}): never => {
  throw new EditorError('CONFLICT', `${reason}; remove the transition before changing its endpoints`, details);
};
function id(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
    throw new EditorError('INVALID_ARGUMENT', `Invalid transition ${field}`);
}
function frame(time: number, fps: number, field: string): number {
  const rounded = Math.round(time * fps);
  if (!Number.isFinite(time) || time < 0 || !Number.isSafeInteger(rounded) || Math.abs(time - rounded / fps) > EPSILON)
    return conflict(`Transition endpoint ${field} must be aligned to the sequence frame grid`);
  return rounded;
}
function nominalWindow(clip: Clip): ClipRenderWindow {
  return { start: clip.start, end: clip.start + clip.duration, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, localTimeOffset: 0 };
}

/** Resolve one supported transition without filesystem access or project normalization. */
export function resolveTransition(timeline: Timeline, media: readonly MediaAsset[], transition: Transition): ResolvedTransition {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) throw new EditorError('INVALID_ARGUMENT', 'Transition must be an object');
  id(transition.id, 'id'); id(transition.leftClipId, 'leftClipId'); id(transition.rightClipId, 'rightClipId');
  if (!['dissolve', 'audio_crossfade'].includes(transition.type)) throw new EditorError('UNSUPPORTED', 'Only dissolve and audio_crossfade transitions are supported');
  if (!['center', 'start', 'end'].includes(transition.alignment)) throw new EditorError('INVALID_ARGUMENT', 'Unknown transition alignment');
  if (!Number.isSafeInteger(transition.durationFrames) || transition.durationFrames < 2) throw new EditorError('INVALID_ARGUMENT', 'Transition durationFrames must be a safe integer of at least 2');
  const fps = timeline.fps;
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new EditorError('INVALID_ARGUMENT', 'Invalid sequence frame rate');
  const leftTrack = timeline.tracks.find((track) => track.clips.some((clip) => clip.id === transition.leftClipId));
  const rightTrack = timeline.tracks.find((track) => track.clips.some((clip) => clip.id === transition.rightClipId));
  if (!leftTrack || !rightTrack) return conflict('Transition requires both existing endpoint clips', { transitionId: transition.id });
  if (leftTrack.id !== rightTrack.id) return conflict('Transition endpoints must share one track');
  const ordered = [...leftTrack.clips].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = ordered.findIndex((clip) => clip.id === transition.leftClipId), left = ordered[index]!, right = ordered[index + 1];
  if (!right || right.id !== transition.rightClipId) return conflict('Transition endpoints must be chronological neighbors');
  const leftAsset = media.find((asset) => asset.id === left.assetId), rightAsset = media.find((asset) => asset.id === right.assetId);
  if (!leftAsset || !rightAsset) return conflict('Transition endpoints require existing media assets');
  if (transition.type === 'dissolve' ? leftTrack.kind !== 'video' || leftAsset.kind === 'audio' || rightAsset.kind === 'audio'
    : leftTrack.kind !== 'audio' || !leftAsset.hasAudio || !rightAsset.hasAudio)
    throw new EditorError('UNSUPPORTED', 'Transition type requires compatible media on a matching track');
  if (transition.type === 'dissolve') for (const asset of [leftAsset, rightAsset]) {
    if (asset.kind === 'video' && (!Number.isFinite(asset.fps) || Math.abs(asset.fps - fps) > EPSILON))
      throw new EditorError('UNSUPPORTED', 'Mixed frame-rate video dissolves are unsupported; video source frame rates must match the sequence', { assetId: asset.id, sourceFps: asset.fps, sequenceFps: fps });
  }
  for (const clip of [left, right]) {
    for (const field of ['start', 'duration', 'sourceIn', 'sourceOut'] as const) frame(clip[field], fps, field);
    if (Object.values(clip.transform).some((property) => property.keyframes.length > 0)
      || clip.effects.some((effect) => effect.enabled && ['video_fade', 'audio_fade'].includes(effect.type)))
      throw new EditorError('UNSUPPORTED', 'Transitions currently require static transforms without enabled clip fades; remove the transition before animating its endpoints', { clipId: clip.id });
  }
  const cutFrame = frame(right.start, fps, 'cut'), leftEndFrame = frame(left.start + left.duration, fps, 'left end');
  if (cutFrame !== leftEndFrame) return conflict('Transition endpoints must meet at an adjacent cut');
  const durationFrames = transition.durationFrames;
  if (durationFrames > Math.min(frame(left.duration, fps, 'left duration'), frame(right.duration, fps, 'right duration')))
    return conflict('Transition duration exceeds an endpoint clip duration');
  const before = transition.alignment === 'start' ? 0 : transition.alignment === 'end' ? durationFrames : Math.floor(durationFrames / 2);
  const after = durationFrames - before, startFrame = cutFrame - before, endFrame = cutFrame + after;
  const cut = cutFrame / fps, start = startFrame / fps, end = endFrame / fps;
  const leftWindow: ClipRenderWindow = { ...nominalWindow(left), end, sourceOut: left.sourceOut + after / fps };
  const rightWindow: ClipRenderWindow = { ...nominalWindow(right), start, sourceIn: right.sourceIn - before / fps, localTimeOffset: before === 0 ? 0 : -before / fps };
  if (leftWindow.sourceIn < -EPSILON || rightWindow.sourceIn < -EPSILON
    || leftWindow.sourceOut > leftAsset.duration + EPSILON || rightWindow.sourceOut > rightAsset.duration + EPSILON)
    return conflict('Transition requires sufficient real source handles', { transitionId: transition.id });
  return { transition, trackId: leftTrack.id, left, right, cutFrame, startFrame, endFrame, durationFrames, start, end, cut, leftWindow, rightWindow };
}

/** Validate the complete optional extension, including conflicts between entries. */
export function validateTransitions(timeline: Timeline, media: readonly MediaAsset[]): readonly ResolvedTransition[] {
  if (timeline.transitions === undefined) return [];
  if (!Array.isArray(timeline.transitions) || timeline.transitions.length > 256) throw new EditorError('INVALID_ARGUMENT', 'Timeline transitions must be an array of at most 256 entries');
  const ids = new Set<string>(), pairs = new Set<string>();
  const resolved = timeline.transitions.map((transition) => {
    const item = resolveTransition(timeline, media, transition), pair = JSON.stringify([transition.leftClipId, transition.rightClipId]);
    if (ids.has(transition.id) || pairs.has(pair)) throw new EditorError('INVALID_ARGUMENT', 'Duplicate transition ID or endpoint pair');
    ids.add(transition.id); pairs.add(pair); return item;
  });
  const tracks = new Map<string, ResolvedTransition[]>();
  for (const item of resolved) { const entries = tracks.get(item.trackId) ?? []; entries.push(item); tracks.set(item.trackId, entries); }
  for (const entries of tracks.values()) {
    entries.sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < entries.length; i++) if (entries[i]!.startFrame < entries[i - 1]!.endFrame)
      return conflict('Transition intervals cannot overlap on the same track');
  }
  return resolved;
}

export function transitionProgress(resolved: ResolvedTransition, time: number): number {
  if (!Number.isFinite(time)) throw new EditorError('INVALID_ARGUMENT', 'Transition time must be finite');
  return Math.max(0, Math.min(1, (time - resolved.start) / (resolved.end - resolved.start)));
}

export function transitionWeights(resolved: ResolvedTransition, time: number): { left: number; right: number } {
  const right = transitionProgress(resolved, time); return { left: 1 - right, right };
}

/** Merge disjoint incoming/outgoing handles while preserving the clip's source mapping. */
export function clipRenderWindow(timeline: Timeline, media: readonly MediaAsset[], clipId: string): ClipRenderWindow {
  const clip = timeline.tracks.flatMap((track) => track.clips).find((entry) => entry.id === clipId);
  if (!clip) throw new EditorError('NOT_FOUND', 'Clip not found', { clipId });
  let window = nominalWindow(clip);
  for (const resolved of validateTransitions(timeline, media)) {
    const extra = resolved.left.id === clipId ? resolved.leftWindow : resolved.right.id === clipId ? resolved.rightWindow : null;
    if (extra) window = { start: Math.min(window.start, extra.start), end: Math.max(window.end, extra.end),
      sourceIn: Math.min(window.sourceIn, extra.sourceIn), sourceOut: Math.max(window.sourceOut, extra.sourceOut),
      localTimeOffset: Math.min(window.start, extra.start) - clip.start };
  }
  return window;
}

export type RgbaPixel = readonly [number, number, number, number];

/** Mix straight RGBA bytes through premultiplied RGB, ready for one layer composite. */
export function blendTransitionPixel(leftRGBA: RgbaPixel, rightRGBA: RgbaPixel, progress: number): [number, number, number, number] {
  for (const pixel of [leftRGBA, rightRGBA]) if (!Array.isArray(pixel) || pixel.length !== 4 || pixel.some((value) => !Number.isFinite(value) || value < 0 || value > 255))
    throw new EditorError('INVALID_ARGUMENT', 'Transition pixels must contain four RGBA byte values');
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new EditorError('INVALID_ARGUMENT', 'Transition progress must be between 0 and 1');
  const leftAlpha = leftRGBA[3] / 255, rightAlpha = rightRGBA[3] / 255, alpha = (1 - progress) * leftAlpha + progress * rightAlpha;
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (index: 0 | 1 | 2) => ((1 - progress) * leftAlpha * leftRGBA[index] + progress * rightAlpha * rightRGBA[index]) / alpha;
  return [channel(0), channel(1), channel(2), alpha * 255];
}
