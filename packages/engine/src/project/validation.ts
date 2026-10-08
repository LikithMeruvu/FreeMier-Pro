import type { Clip, MediaAsset, Project, Transform } from '@freemier/shared';
import {
  EASINGS,
  EditorError,
  EFFECT_CATALOG,
  PROJECT_SCHEMA_VERSION,
  TRANSFORM_LIMITS,
  validateCaptions,
  validateEffectParams, validateMarkers, validateTitles
} from '@freemier/shared';
import path from 'node:path';
import { validateEffectPresetLibrary } from '../presets/operations.js';

/** Validate external schema-1 snapshots without mutating, normalizing or probing media. */
export function validateProject(value: unknown, source = '<memory>'): Project {
  const fail = (field: string, reason: string): never => {
    throw new EditorError('INVALID_ARGUMENT', `Invalid project field ${field}: ${reason}`, { source, field });
  };
  const object = (v: unknown, field: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(field, 'must be an object');
    return v as Record<string, unknown>;
  };
  const array = (v: unknown, field: string): unknown[] => Array.isArray(v) ? v : fail(field, 'must be an array');
  const string = (v: unknown, field: string, nonempty = false): string => {
    if (typeof v !== 'string' || v.includes('\0') || (nonempty && !v.trim())) return fail(field, 'must be a valid string');
    return v;
  };
  const id = (v: unknown, field: string): string => {
    const s = string(v, field, true);
    if (s.length > 128 || /[\x00-\x1f\x7f]/.test(s)) return fail(field, 'must be a nonempty ID of at most 128 characters');
    return s;
  };
  const bool = (v: unknown, field: string): void => { if (typeof v !== 'boolean') fail(field, 'must be a boolean'); };
  const number = (v: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) return fail(field, 'must be a finite number within supported bounds');
    return v;
  };
  const unique = (v: string, seen: Set<string>, field: string): void => {
    if (seen.has(v)) fail(field, 'duplicate ID');
    seen.add(v);
  };
  const extension = (field: string, validate: () => void): void => {
    try { validate(); } catch (error) {
      if (!(error instanceof EditorError)) return fail(field, 'malformed data');
      throw new EditorError(error.code, `Invalid project field ${field}: ${error.message}`, { source, field });
    }
  };

  const p = object(value, 'project');
  id(p.id, 'id'); string(p.name, 'name');
  const version = number(p.version, 'version', 1, Number.MAX_SAFE_INTEGER, true);
  if (version > PROJECT_SCHEMA_VERSION) throw new EditorError('UNSUPPORTED', 'Project was written by a newer schema version', { source, field: 'version', found: version, supported: PROJECT_SCHEMA_VERSION });
  number(p.createdAt, 'createdAt', 0, Number.MAX_SAFE_INTEGER, true);
  number(p.updatedAt, 'updatedAt', 0, Number.MAX_SAFE_INTEGER, true);
  const timeline = object(p.timeline, 'timeline');
  id(timeline.id, 'timeline.id'); string(timeline.name, 'timeline.name');
  const fps = number(timeline.fps, 'timeline.fps', 1, 240);
  number(timeline.width, 'timeline.width', 1, Number.MAX_SAFE_INTEGER, true);
  number(timeline.height, 'timeline.height', 1, Number.MAX_SAFE_INTEGER, true);
  const media = new Map<string, MediaAsset>();
  for (const [i, raw] of array(p.media, 'media').entries()) {
    const f = `media[${i}]`, asset = object(raw, f), assetId = id(asset.id, `${f}.id`);
    // Asset IDs become copied-media filenames; keep them as one path component.
    if (/[\\/:]/.test(assetId)) fail(`${f}.id`, 'must be safe for a media filename');
    if (media.has(assetId)) fail(`${f}.id`, 'duplicate ID');
    const filename = string(asset.path, `${f}.path`, true);
    bool(asset.copied, `${f}.copied`); string(asset.name, `${f}.name`);
    if (!['video', 'audio', 'image'].includes(asset.kind as string)) fail(`${f}.kind`, 'unknown media kind');
    if (asset.copied && !path.posix.isAbsolute(filename) && !path.win32.isAbsolute(filename)
      && (filename.split(/[\\/]/).includes('..') || filename.includes(':'))) fail(`${f}.path`, 'relative copied media must remain inside its media directory');
    number(asset.duration, `${f}.duration`, Number.MIN_VALUE);
    const dimensionMin = asset.kind === 'audio' ? 0 : 1;
    number(asset.width, `${f}.width`, dimensionMin, Number.MAX_SAFE_INTEGER, true);
    number(asset.height, `${f}.height`, dimensionMin, Number.MAX_SAFE_INTEGER, true);
    number(asset.fps, `${f}.fps`); bool(asset.hasAudio, `${f}.hasAudio`);
    if (asset.sampleRate !== null) number(asset.sampleRate, `${f}.sampleRate`, 1, Number.MAX_SAFE_INTEGER, true);
    for (const key of ['videoCodec', 'audioCodec'] as const) if (asset[key] !== null) string(asset[key], `${f}.${key}`, true);
    number(asset.probedAt, `${f}.probedAt`, 0, Number.MAX_SAFE_INTEGER, true);
    media.set(assetId, raw as MediaAsset);
  }

  const trackIds = new Set<string>(), clipIds = new Set<string>();
  for (const [i, raw] of array(timeline.tracks, 'timeline.tracks').entries()) {
    const f = `timeline.tracks[${i}]`, track = object(raw, f);
    unique(id(track.id, `${f}.id`), trackIds, `${f}.id`);
    if (!['video', 'audio'].includes(track.kind as string)) fail(`${f}.kind`, 'unknown track kind');
    string(track.name, `${f}.name`); bool(track.muted, `${f}.muted`); bool(track.locked, `${f}.locked`);
    number(track.order, `${f}.order`, 0, Number.MAX_SAFE_INTEGER, true);
    const clips = array(track.clips, `${f}.clips`);
    for (const [j, rawClip] of clips.entries()) {
      const cf = `${f}.clips[${j}]`, clip = object(rawClip, cf);
      unique(id(clip.id, `${cf}.id`), clipIds, `${cf}.id`);
      const asset = media.get(id(clip.assetId, `${cf}.assetId`));
      if (!asset) fail(`${cf}.assetId`, 'missing asset in media library');
      const start = number(clip.start, `${cf}.start`), duration = number(clip.duration, `${cf}.duration`, Number.MIN_VALUE);
      number(start + duration, `${cf}.end`);
      const sourceIn = number(clip.sourceIn, `${cf}.sourceIn`), sourceOut = number(clip.sourceOut, `${cf}.sourceOut`, Number.MIN_VALUE);
      if (sourceOut <= sourceIn || Math.abs(sourceOut - sourceIn - duration) > 1e-6) fail(`${cf}.sourceOut`, 'source window must match unit-speed clip duration');
      // addClip rounds the remaining source to the nearest sequence frame.
      if (sourceIn >= asset!.duration || sourceOut > asset!.duration + .5 / fps + 1e-6) fail(`${cf}.sourceOut`, 'source window exceeds media duration');
      if (clip.label !== null) string(clip.label, `${cf}.label`);
      number(clip.volume, `${cf}.volume`, 0, 4);
      const transform = object(clip.transform, `${cf}.transform`);
      if (Object.keys(transform).some((key) => !Object.hasOwn(TRANSFORM_LIMITS, key))) fail(`${cf}.transform`, 'unknown transform property');
      for (const key of Object.keys(TRANSFORM_LIMITS) as (keyof Transform)[]) {
        const pf = `${cf}.transform.${key}`, curve = object(transform[key], pf), bounds = TRANSFORM_LIMITS[key];
        number(curve.value, `${pf}.value`, bounds.min, bounds.max);
        const keys = array(curve.keyframes, `${pf}.keyframes`), times = new Set<number>();
        if (keys.length > 256) fail(`${pf}.keyframes`, 'maximum 256 keys per curve');
        for (const [k, rawKey] of keys.entries()) {
          const kf = `${pf}.keyframes[${k}]`, frame = object(rawKey, kf), time = number(frame.time, `${kf}.time`);
          if (times.has(time)) fail(`${kf}.time`, 'duplicate keyframe time');
          times.add(time); number(frame.value, `${kf}.value`, bounds.min, bounds.max);
          if (!EASINGS.includes(frame.easing as typeof EASINGS[number])) fail(`${kf}.easing`, 'unknown easing');
        }
      }
      const effects = array(clip.effects, `${cf}.effects`), effectIds = new Set<string>();
      if (effects.length > 32) fail(`${cf}.effects`, 'maximum 32 effects per clip');
      for (const [k, rawEffect] of effects.entries()) {
        const ef = `${cf}.effects[${k}]`, effect = object(rawEffect, ef);
        unique(id(effect.id, `${ef}.id`), effectIds, `${ef}.id`);
        const type = string(effect.type, `${ef}.type`, true); bool(effect.enabled, `${ef}.enabled`);
        const params = object(effect.params, `${ef}.params`);
        for (const [key, val] of Object.entries(params)) {
          if (typeof val === 'number') number(val, `${ef}.params.${key}`, -Number.MAX_SAFE_INTEGER);
          else if (typeof val === 'string') string(val, `${ef}.params.${key}`);
          else if (typeof val !== 'boolean') fail(`${ef}.params.${key}`, 'effect parameters must be scalar values');
        }
        const descriptor = EFFECT_CATALOG.find((entry) => entry.type === type);
        if (descriptor) {
          if (Object.keys(params).some((key) => !Object.hasOwn(descriptor.params, key))) fail(`${ef}.params`, 'unknown effect parameter');
          extension(`${ef}.params`, () => { validateEffectParams(type, params); });
        }
      }
    }
    const ordered = [...clips as Clip[]].sort((a, b) => a.start - b.start);
    for (let j = 1; j < ordered.length; j++) if (ordered[j]!.start < ordered[j - 1]!.start + ordered[j - 1]!.duration - 1e-6) fail(`${f}.clips`, 'clips overlap on this track');
  }
  if (timeline.clipLinks !== undefined) {
    const links = new Set<string>(), members = new Set<string>();
    const tracks = timeline.tracks as unknown as import('@freemier/shared').Track[];
    for (const [i, raw] of array(timeline.clipLinks, 'timeline.clipLinks').entries()) {
      const f = `timeline.clipLinks[${i}]`, link = object(raw, f);
      unique(id(link.id, `${f}.id`), links, `${f}.id`);
      const videoId = id(link.videoClipId, `${f}.videoClipId`), audioId = id(link.audioClipId, `${f}.audioClipId`);
      unique(videoId, members, `${f}.videoClipId`); unique(audioId, members, `${f}.audioClipId`);
      const videoTrack = tracks.find((t) => t.clips.some((c) => c.id === videoId));
      const audioTrack = tracks.find((t) => t.clips.some((c) => c.id === audioId));
      if (!videoTrack || !audioTrack || videoTrack.kind !== 'video' || audioTrack.kind !== 'audio') fail(f, 'pair requires existing clips on video and audio tracks');
      const video = videoTrack!.clips.find((c) => c.id === videoId)!, audio = audioTrack!.clips.find((c) => c.id === audioId)!;
      const asset = media.get(video.assetId)!;
      if (video.assetId !== audio.assetId || asset.kind !== 'video' || !asset.hasAudio) fail(f, 'pair requires the same audio-bearing video asset');
      for (const key of ['start', 'duration', 'sourceIn', 'sourceOut'] as const) {
        if (Math.abs(video[key] - audio[key]) > 1e-6) fail(f, 'pair timing and source windows must match');
      }
    }
  }
  if (timeline.markers !== undefined) extension('timeline.markers', () => validateMarkers(timeline.markers, fps));
  if (timeline.titles !== undefined) extension('timeline.titles', () => validateTitles(timeline.titles, fps));
  if (timeline.captions !== undefined) extension('timeline.captions', () => validateCaptions(timeline.captions));
  if (p.effectPresets !== undefined) extension('effectPresets', () => validateEffectPresetLibrary(p.effectPresets));
  return value as Project;
}
