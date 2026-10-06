import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { MediaAsset, Id } from '@freemier/shared';
import { EditorError, newMediaId } from '@freemier/shared';
import { runFfprobe, runFfmpeg } from './run.js';

/**
 * Media probing and import.
 *
 * Everything here works from ffprobe/ffmpeg output only — no native bindings.
 */

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}

interface ProbeFormat {
  duration?: string;
  format_name?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

/** Parse ffmpeg's "30000/1001" rational frame-rate notation. */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numRaw, denRaw] = value.split('/');
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** Choose the best frame rate from a stream, preferring avg over r_frame_rate. */
function streamFps(stream: ProbeStream): number {
  const avg = parseFrameRate(stream.avg_frame_rate);
  if (avg > 0) return avg;
  return parseFrameRate(stream.r_frame_rate);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.opus']);

/** Nominal duration assigned to still images, which have no intrinsic length. */
export const IMAGE_DEFAULT_DURATION = 5;

export interface ProbeOptions {
  /** Override the id assigned to the asset. */
  id?: Id;
  /** Override the path recorded on the asset. */
  recordPath?: string;
}

/**
 * Probe a media file into a MediaAsset.
 *
 * Handles the awkward cases that break naive implementations:
 *  - audio-only files (no video stream, or width/height 0)
 *  - video-only files (no audio stream)
 *  - images (no duration at all)
 *  - variable frame rate (avg_frame_rate differs from r_frame_rate)
 */
export async function probeMedia(filePath: string, opts: ProbeOptions = {}): Promise<MediaAsset> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    throw new EditorError('IO_ERROR', `Media file not found: ${filePath}`, {
      path: filePath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (!stat.isFile()) {
    throw new EditorError('INVALID_ARGUMENT', `Not a file: ${filePath}`, { path: filePath });
  }

  const ext = path.extname(filePath).toLowerCase();
  const json = (await runFfprobe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ])) as ProbeResult;

  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const isImage = IMAGE_EXTENSIONS.has(ext) || (!video?.duration && !json.format?.duration && !!video);
  const isAudioOnly = !video && !!audio;

  let kind: MediaAsset['kind'];
  if (AUDIO_EXTENSIONS.has(ext) || isAudioOnly) kind = 'audio';
  else if (isImage) kind = 'image';
  else kind = 'video';

  const formatDuration = Number(json.format?.duration ?? 0);
  const streamDuration = Number(video?.duration ?? audio?.duration ?? 0);
  let duration = Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : streamDuration;

  if (kind === 'image' || !Number.isFinite(duration) || duration <= 0) {
    duration = kind === 'image' ? IMAGE_DEFAULT_DURATION : 0;
  }
  if (duration <= 0) {
    throw new EditorError('PROBE_ERROR', 'Could not determine media duration', {
      path: filePath,
      formatDuration,
      streamDuration,
    });
  }

  const fps = video ? streamFps(video) : 0;

  return {
    id: opts.id ?? newMediaId(),
    path: opts.recordPath ?? filePath,
    copied: false,
    name: path.basename(filePath),
    kind,
    duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: fps > 0 ? fps : 30,
    hasAudio: Boolean(audio),
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    probedAt: Date.now(),
  };
}

export interface ImportOptions extends ProbeOptions {
  /** Directory to copy the media into. When omitted the file is referenced in place. */
  copyTo?: string;
}

/** Import media: optionally copy it into the project, then probe it. */
export async function importMedia(filePath: string, opts: ImportOptions = {}): Promise<MediaAsset> {
  if (opts.copyTo) {
    await fs.mkdir(opts.copyTo, { recursive: true });
    const id = opts.id ?? newMediaId();
    const filename = `${id}${path.extname(filePath)}`;
    const destination = path.join(opts.copyTo, filename);
    // Files from different directories can have the same name. Each import owns
    // its copy, so it cannot silently bind to a previously imported file.
    await fs.copyFile(filePath, destination, constants.COPYFILE_EXCL);
    const asset = await probeMedia(destination, { ...opts, id, recordPath: filename });
    return { ...asset, name: path.basename(filePath), path: filename, copied: true };
  }
  return probeMedia(filePath, opts);
}

/**
 * Extract a single frame as a JPEG/PNG thumbnail.
 * `atSeconds` is clamped into the media's duration so a request past the end
 * still yields an image rather than failing.
 */
export async function extractThumbnail(
  filePath: string,
  outPath: string,
  atSeconds = 0,
  size = 320,
  /** Known duration; when omitted the file is probed so the seek can be clamped. */
  knownDuration?: number,
): Promise<string> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Seeking at or past EOF yields no frames, so ffmpeg fails. Clamp inside the
  // media so a request for "the last frame" always produces an image.
  let duration = knownDuration;
  if (duration === undefined) {
    try {
      duration = (await probeMedia(filePath)).duration;
    } catch {
      duration = 0;
    }
  }
  const upperBound = duration > 0 ? Math.max(0, duration - 0.05) : Number.POSITIVE_INFINITY;
  const at = Math.min(Math.max(0, atSeconds), upperBound);

  // Fall back to the first frame when the clamped seek still produces nothing.
  try {
    await runFfmpeg([
      '-y',
      '-ss', at.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=${size}:-2:flags=lanczos`,
      '-q:v', '3',
      outPath,
    ], 'ffmpeg thumbnail');
    return outPath;
  } catch (err) {
    if (at <= 0) throw err;
    await runFfmpeg([
      '-y', '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=${size}:-2:flags=lanczos`,
      '-q:v', '3',
      outPath,
    ], 'ffmpeg thumbnail (fallback)');
    return outPath;
  }
}

/**
 * Extract normalized audio peaks for waveform rendering.
 *
 * Decodes to mono 16-bit PCM at a low sample rate, then buckets the absolute
 * amplitude. Returns `buckets` values in [0, 1] — exactly what a canvas
 * waveform needs, and small enough to ship over IPC.
 */
export async function extractWaveform(
  filePath: string,
  buckets = 800,
  sampleRate = 8000,
): Promise<number[]> {
  if (buckets <= 0) throw new EditorError('INVALID_ARGUMENT', 'buckets must be positive', { buckets });

  const { stdout } = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
    // Raw PCM must be captured as a Buffer, not a UTF-8 string.
    import('node:child_process').then(({ execFile }) => {
      execFile(
        (process.env.FREEMIER_FFMPEG ?? 'ffmpeg'),
        [
          '-v', 'error',
          '-i', filePath,
          '-ac', '1',
          '-ar', String(sampleRate),
          '-f', 's16le',
          '-',
        ],
        { maxBuffer: 512 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
        (err, stdoutBuf) => {
          if (err) {
            reject(new EditorError('PROBE_ERROR', 'Waveform extraction failed', {
              path: filePath,
              cause: err.message,
            }));
            return;
          }
          resolve({ stdout: stdoutBuf as Buffer });
        },
      );
    }).catch(reject);
  });

  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  if (samples.length === 0) return new Array(buckets).fill(0);

  const perBucket = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * perBucket;
    const end = Math.min(samples.length, start + perBucket);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i] ?? 0);
      if (v > peak) peak = v;
    }
    peaks.push(peak / 32768);
  }
  return peaks;
}
