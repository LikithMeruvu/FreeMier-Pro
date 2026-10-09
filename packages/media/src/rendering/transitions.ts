import type { Clip, Project } from '@freemier/shared';
import { EditorError, clipRenderWindow, resolveTransition } from '@freemier/shared';
import path from 'node:path';
import { runFfprobe } from '../providers/ffmpeg/run.js';
import { effectFilters } from './effects.js';

const f = (value: number) => Number(value.toFixed(8)).toString();

/** Both endpoints are full-size straight-alpha layers before premultiplication. */
export function appendDissolveLayer(filters: string[], options: {
  label: string; left: Clip; right: Clip; leftInput: number; rightInput: number;
  start: number; end: number; width: number; height: number; fps: number;
}): string {
  const { label, start, end, width, height, fps } = options;
  const duration = end - start;
  for (const side of ['left', 'right'] as const) {
    const clip = options[side], input = options[`${side}Input`], t = clip.transform;
    const chain = [
      `trim=start=${f(clip.sourceIn + start - clip.start)}:end=${f(clip.sourceIn + end - clip.start)}`,
      'setpts=PTS-STARTPTS', `fps=${f(fps)}`, 'settb=AVTB',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`, 'format=gbrap',
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      ...effectFilters(clip.effects, 'video'),
    ];
    if (Math.abs(t.scale.value - 1) > 1e-6) chain.push(`scale=iw*${f(t.scale.value)}:ih*${f(t.scale.value)}`);
    if (t.rotation.value !== 0) {
      const angle = f(t.rotation.value * Math.PI / 180);
      chain.push(`rotate=${angle}:ow=ceil(rotw(${angle})):oh=ceil(roth(${angle})):c=none`);
    }
    chain.push('format=rgba', `colorchannelmixer=aa=${f(t.opacity.value)}`);
    filters.push(`[${input}:v]${chain.join(',')}[${label}${side}source]`);
    filters.push(`color=c=black@0:s=${width}x${height}:r=${f(fps)}:d=${f(duration)},format=rgba,settb=AVTB[${label}${side}blank]`);
    filters.push(`[${label}${side}blank][${label}${side}source]overlay=x=(W-w)/2+${f(t.x.value)}*W:y=(H-h)/2+${f(t.y.value)}*H:format=auto:shortest=1,format=gbrap16le,premultiply=inplace=1:planes=7[${label}${side}]`);
  }
  const weight = `clip(T/${f(duration)},0,1)`;
  filters.push(`[${label}left][${label}right]blend=all_expr='A*(1-${weight})+B*${weight}':shortest=1,unpremultiply=inplace=1:planes=7,setpts=PTS+${f(start)}/TB[${label}]`);
  return label;
}

interface FrameProbe {
  streams?: Array<{ start_time?: string; sample_rate?: string; time_base?: string }>;
  format?: { start_time?: string };
  frames?: Array<{ best_effort_timestamp_time?: string; duration_time?: string; pkt_duration_time?: string; nb_samples?: number }>;
}

/** Decode timestamps, rather than borrowing handles from container duration. */
export async function preflightTransitionStreams(project: Project, mediaDirectory?: string): Promise<void> {
  const checked = new Map<string, Promise<FrameProbe>>();
  const metadata = new Map<string, Promise<FrameProbe>>();
  for (const transition of project.timeline.transitions ?? []) {
    const resolved = resolveTransition(project.timeline, project.media, transition);
    if (project.timeline.tracks.find(track => track.id === resolved.trackId)!.muted) continue;
    for (const clip of [resolved.left, resolved.right]) {
      const asset = project.media.find(media => media.id === clip.assetId)!;
      if (asset.kind === 'image') continue;
      const window = clipRenderWindow(project.timeline, project.media, clip.id);
      if (asset.copied && !path.isAbsolute(asset.path) && !mediaDirectory) throw new EditorError('INVALID_ARGUMENT', 'Copied media requires a mediaDirectory for export', { assetId: asset.id });
      const file = asset.copied && !path.isAbsolute(asset.path) ? path.resolve(mediaDirectory!, asset.path) : asset.path;
      const video = transition.type === 'dissolve';
      const streamKey = `${file}\0${video ? 'v' : 'a'}`;
      let info = metadata.get(streamKey);
      if (!info) {
        info = runFfprobe(['-v', 'error', '-select_streams', video ? 'v:0' : 'a:0', '-show_streams', '-show_format', '-show_entries', 'stream=sample_rate,time_base:format=start_time', '-of', 'json', file], { timeout: 60000 }) as Promise<FrameProbe>;
        metadata.set(streamKey, info);
      }
      const sourceInfo = await info, stream = sourceInfo.streams?.[0];
      // FFmpeg input seeking and browser currentTime share the container clock.
      // Subtracting a delayed stream's own start would invent missing early samples.
      const origin = Number(sourceInfo.format?.start_time ?? 0), sampleRate = Number(stream?.sample_rate);
      const key = `${streamKey}\0${window.sourceIn}\0${window.sourceOut}`;
      let probing = checked.get(key);
      if (!probing) {
        probing = runFfprobe(['-v', 'error', '-select_streams', video ? 'v:0' : 'a:0', '-read_intervals', `${f(origin + window.sourceIn)}%${f(origin + window.sourceOut + 1 / project.timeline.fps)}`, '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time,nb_samples', '-of', 'json', file], { timeout: 60000 }) as Promise<FrameProbe>;
        checked.set(key, probing);
      }
      const probe = await probing;
      let coverage = window.sourceIn;
      // Container timestamps are quantized to their native time base (Matroska
      // commonly uses 1ms even for 44.1kHz PCM). Allow that measured quantum,
      // rather than mistaking rounding between consecutive frames for a gap.
      const [tickNumerator, tickDenominator] = (stream?.time_base ?? '0/1').split('/').map(Number);
      const tick = tickNumerator! / tickDenominator!;
      const timestampTolerance = Number.isFinite(tick) && tick > 0 ? Math.min(tick, .001) : 0;
      const tolerance = Math.min(.001, Math.max(timestampTolerance, video ? 1e-6 : .5 / sampleRate));
      for (const frame of probe.frames ?? []) {
        const start = Number(frame.best_effort_timestamp_time) - origin;
        const duration = video ? Number(frame.duration_time ?? frame.pkt_duration_time) : Number(frame.nb_samples) / sampleRate;
        if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || start + duration <= window.sourceIn) continue;
        if (video && (Math.abs(start - Math.round(start * project.timeline.fps) / project.timeline.fps) > tolerance
          || Math.abs(duration - 1 / project.timeline.fps) > tolerance))
          throw new EditorError('UNSUPPORTED', 'Transition video requires constant frames aligned to the sequence frame grid', { transitionId: transition.id, clipId: clip.id, stream: 'video', reason: 'frame_geometry', frameStart: start, frameDuration: duration, sequenceFps: project.timeline.fps });
        if (start > coverage + tolerance) break;
        coverage = Math.max(coverage, start + duration);
        if (coverage + tolerance >= window.sourceOut) break;
      }
      if (!stream || coverage + tolerance < window.sourceOut) throw new EditorError('UNSUPPORTED', 'Cannot verify continuous source stream coverage for transition handles', { transitionId: transition.id, clipId: clip.id, stream: video ? 'video' : 'audio', requiredSourceIn: window.sourceIn, requiredSourceOut: window.sourceOut, verifiedSourceOut: coverage });
    }
  }
}
