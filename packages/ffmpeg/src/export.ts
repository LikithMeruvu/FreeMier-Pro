import type { Project, Timeline, Clip, MediaAsset, Track } from '@freemier/shared';
import { EditorError, evaluateTransform, validateTransformValue, effectDescriptor } from '@freemier/shared';
import { animatedTransformFilter, effectFilters } from './effects.js';
import { runFfmpeg } from './run.js';
import { clipEnd, timelineDuration } from '@freemier/engine';
import path from 'node:path';

/**
 * Timeline -> FFmpeg export.
 *
 * Strategy: render a black canvas of the timeline's exact duration, then
 * overlay each video clip at its time range; mix each audio clip with a delay.
 * Gaps become black frames and silence, which is the correct semantic.
 *
 * This is deliberately a *filter graph* build, not a frame-by-frame render:
 * FFmpeg does the work, we only describe it. That keeps export fast and avoids
 * pulling decoded frames through JavaScript.
 */

export interface ExportOptions {
  outputPath: string;
  /** Directory containing copied media. Required for relative copied assets. */
  mediaDirectory?: string;
  /** h264 (default), h265, or prores. */
  codec?: 'h264' | 'h265' | 'prores';
  /** Constant Rate Factor. Lower is better quality. Default 20. */
  crf?: number;
  /** Encoder preset. Default 'medium'. */
  preset?: string;
  /** Override output size. Defaults to the timeline's size. */
  width?: number;
  height?: number;
  /** Called with 0..1 progress when FFmpeg reports it. */
  onProgress?: (fraction: number) => void;
}

export interface ExportResult {
  outputPath: string;
  durationSeconds: number;
  clipCount: number;
  args: string[];
}

interface ClipRef {
  clip: Clip;
  asset: MediaAsset;
  track: Track;
  /** Index of the asset in the -i input list. */
  inputIndex: number;
}

/** Round to 6dp so filter strings stay readable and stable. */
const f = (n: number): string => (Math.round(n * 1e6) / 1e6).toString();

/**
 * Build the FFmpeg argument list for a project export.
 * Exported separately from execution so it can be unit-tested without FFmpeg.
 */
export function buildExportArgs(
  project: Project,
  opts: ExportOptions,
): { args: string[]; duration: number; clipCount: number } {
  const timeline = project.timeline;
  const duration = timelineDuration(timeline);
  if (duration <= 0) {
    throw new EditorError('INVALID_ARGUMENT', 'Cannot export an empty timeline', {
      projectId: project.id,
    });
  }

  const width = opts.width ?? timeline.width;
  const height = opts.height ?? timeline.height;
  const fps = timeline.fps;

  // Collect the assets actually used, in a stable order, and index them.
  const usedAssets = new Map<string, number>();
  const inputs: string[] = [];
  const clipRefs: ClipRef[] = [];
  let inputIndex = 0;

  for (const track of [...timeline.tracks].sort((a, b) => a.order - b.order)) {
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      for (const effect of clip.effects) if (effect.enabled) {
        const descriptor = effectDescriptor(effect.type);
        if (descriptor.media !== track.kind) throw new EditorError('UNSUPPORTED', 'Enabled effect does not match its track media type', { clipId: clip.id, type: effect.type });
      }
      evaluateTransform(clip.transform, 0);
      for (const [name, curve] of Object.entries(clip.transform)) {
        validateTransformValue(name as keyof Clip['transform'], curve.value);
        for (const key of curve.keyframes) validateTransformValue(name as keyof Clip['transform'], key.value);
      }
      const asset = project.media.find((m) => m.id === clip.assetId);
      if (!asset) {
        throw new EditorError('NOT_FOUND', `Clip references a missing asset: ${clip.assetId}`, {
          clipId: clip.id,
          assetId: clip.assetId,
        });
      }
      let idx = usedAssets.get(asset.id);
      if (idx === undefined) {
        if (asset.copied && !path.isAbsolute(asset.path) && !opts.mediaDirectory) {
          throw new EditorError('INVALID_ARGUMENT', 'Copied media requires a mediaDirectory for export', { assetId: asset.id });
        }
        const source = asset.copied && !path.isAbsolute(asset.path)
          ? path.resolve(opts.mediaDirectory!, asset.path)
          : asset.path;
        idx = inputIndex++;
        usedAssets.set(asset.id, idx);
        if (asset.kind === 'image') {
          // Images need a loop + explicit duration or they contribute one frame.
          inputs.push('-loop', '1', '-t', f(Math.max(clipEnd(clip), clip.duration)), '-i', source);
        } else {
          inputs.push('-i', source);
        }
      }
      clipRefs.push({ clip, asset, track, inputIndex: idx });
    }
  }

  if (clipRefs.length === 0) {
    throw new EditorError('INVALID_ARGUMENT', 'Cannot export a timeline with no clips', {
      projectId: project.id,
    });
  }

  const filters: string[] = [];

  // Base canvas: exact duration, correct size, correct frame rate.
  filters.push(
    `color=c=black:s=${width}x${height}:r=${f(fps)}:d=${f(duration)},format=yuv420p[base0]`,
  );

  let canvas = 'base0';
  let vLabel = 0;
  let aLabel = 0;
  const audioLabels: string[] = [];
  const videoClips = clipRefs.filter((r) => r.asset.kind !== 'audio' && r.track.kind !== 'audio');
  const audioClips = clipRefs.filter((r) => r.asset.hasAudio && r.track.kind !== 'video' && !r.track.muted);

  for (const ref of videoClips) {
    if (ref.track.muted) continue;
    const { clip, asset } = ref;
    const start = clip.start;
    const end = clipEnd(clip);

    const src = `${ref.inputIndex}:v`;
    const chain: string[] = [
      `trim=start=${f(clip.sourceIn)}:end=${f(clip.sourceOut)}`,
      'setpts=PTS-STARTPTS',
      `fps=${f(fps)}`,
    ];

    // Fit inside the canvas, then letterbox to exact output size.
    chain.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      'format=gbrap',
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    );
    chain.push(...effectFilters(clip.effects, 'video'));

    // Per-clip transform, expressed in normalized units.
    const t = clip.transform;
    const animated = Object.values(t).some((p) => p.keyframes.length > 0);
    const scale = t.scale.value;
    if (animated) chain.push('format=gbrap', animatedTransformFilter(t));
    if (!animated && Math.abs(scale - 1) > 1e-6 && scale > 0) {
      chain.push(`scale=iw*${f(scale)}:ih*${f(scale)}`);
    }
    if (!animated && t.rotation.value !== 0) {
      chain.push(`rotate=${f((t.rotation.value * Math.PI) / 180)}:c=none`);
    }
    // Shift PTS so the clip lands at its timeline position.
    chain.push(`setpts=PTS+${f(start)}/TB`);

    const out = `v${vLabel}`;
    filters.push(`[${src}]${chain.join(',')}[${out}${vLabel}pre]`);

    // Overlay at the transformed position, only during the clip's window.
    const offsetX = animated ? '0' : `(W-w)/2+${f(t.x.value)}*W`;
    const offsetY = animated ? '0' : `(H-h)/2+${f(t.y.value)}*H`;
    const opacity = animated ? 1 : t.opacity.value;

    const overlayIn = `${out}${vLabel}pre`;
    const nextCanvas = `base${vLabel + 1}`;
    let overlayChain = `overlay=x=${offsetX}:y=${offsetY}:eof_action=pass:enable='gte(t,${f(start)})*lt(t,${f(end)})'`;

    if (opacity < 1 - 1e-6) {
      // Fade the clip layer via its alpha before compositing.
      filters.push(`[${overlayIn}]format=rgba,colorchannelmixer=aa=${f(opacity)}[v${vLabel}alpha]`);
      filters.push(`[${canvas}][v${vLabel}alpha]${overlayChain}[${nextCanvas}]`);
    } else {
      filters.push(`[${canvas}][${overlayIn}]${overlayChain}[${nextCanvas}]`);
    }
    canvas = nextCanvas;
    vLabel++;
  }

  for (const ref of audioClips) {
    const { clip } = ref;
    const delayMs = Math.round(clip.start * 1000);
    const label = `a${aLabel}`;
    const chain = [
      `atrim=start=${f(clip.sourceIn)}:end=${f(clip.sourceOut)}`,
      // Sample counting avoids unset/nonmonotonic PTS from decoded audio.
      'asetpts=N/SR/TB',
      ...effectFilters(clip.effects, 'audio'),
      `volume=${f(clip.volume)}`,
    ];
    if (delayMs > 0) chain.push(`adelay=${delayMs}|${delayMs}`);
    chain.push('asetpts=N/SR/TB');
    filters.push(`[${ref.inputIndex}:a]${chain.join(',')}[${label}]`);
    audioLabels.push(label);
    aLabel++;
  }

  const args: string[] = ['-y', '-hide_banner', '-nostdin', ...inputs];

  const outputArgs: string[] = [];
  const codec = opts.codec ?? 'h264';
  const crf = opts.crf ?? 20;
  if (codec === 'h264') {
    outputArgs.push('-c:v', 'libx264', '-preset', opts.preset ?? 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p');
  } else if (codec === 'h265') {
    outputArgs.push('-c:v', 'libx265', '-preset', opts.preset ?? 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
  } else {
    outputArgs.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le');
  }

  if (audioLabels.length > 0) {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${f(duration)},atrim=duration=${f(duration)},asetpts=N/SR/TB[aout]`,
    );
    outputArgs.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    // No audio anywhere: emit silent stereo so the container is consistent.
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${f(duration)}[aout]`);
    outputArgs.push('-c:a', 'aac', '-b:a', '192k');
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${canvas}]`,
    '-map', '[aout]',
    '-t', f(duration),
    ...outputArgs,
    '-progress', 'pipe:1',
    '-loglevel', 'error',
    opts.outputPath,
  );

  return { args, duration, clipCount: clipRefs.length };
}

/**
 * Export a project to a video file.
 * Streams FFmpeg's progress output so callers can drive a progress bar.
 */
export async function exportProject(project: Project, opts: ExportOptions): Promise<ExportResult> {
  const { args, duration, clipCount } = buildExportArgs(project, opts);

  if (opts.onProgress) {
    // Re-run with progress parsing: execute, then map out_time_ms to a fraction.
    const { spawn } = await import('node:child_process');
    const { getFfmpegConfig } = await import('./run.js');
    const cfg = getFfmpegConfig();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cfg.ffmpegPath, args, { windowsHide: true });
      let stderr = '';
      let stdout = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        let idx: number;
        while ((idx = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, idx).trim();
          stdout = stdout.slice(idx + 1);
          const m = /^out_time_ms=(\d+)$/.exec(line);
          if (m) {
            const seconds = Number(m[1]) / 1_000_000;
            opts.onProgress?.(Math.min(1, Math.max(0, seconds / duration)));
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => {
        reject(new EditorError('IO_ERROR', 'Failed to launch FFmpeg', { cause: err.message }));
      });
      child.on('close', (code) => {
        if (code === 0) {
          opts.onProgress?.(1);
          resolve();
        } else {
          reject(new EditorError('EXPORT_ERROR', `FFmpeg exited with code ${code}`, {
            stderrTail: stderr.trim().split(/\r?\n/).slice(-15).join('\n'),
          }));
        }
      });
    });
  } else {
    await runFfmpeg(args, 'ffmpeg export');
  }

  return { outputPath: opts.outputPath, durationSeconds: duration, clipCount, args };
}

/** Human-readable graph, for debugging export problems. */
export function describeExport(project: Project, opts: ExportOptions): string {
  const { args, duration, clipCount } = buildExportArgs(project, opts);
  return [
    `duration: ${duration.toFixed(3)}s`,
    `clips: ${clipCount}`,
    `args:`,
    ...args.map((a) => `  ${a}`),
  ].join('\n');
}
