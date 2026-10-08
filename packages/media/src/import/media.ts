import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Id, MediaAsset } from '@freemier/shared';
import { EditorError, newMediaId } from '@freemier/shared';
import { runFfprobe } from '../providers/ffmpeg/run.js';
import { hashMediaSource } from '../identity/source.js';

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

export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numRaw, denRaw] = value.split('/');
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function streamFps(stream: ProbeStream): number {
  const avg = parseFrameRate(stream.avg_frame_rate);
  if (avg > 0) return avg;
  return parseFrameRate(stream.r_frame_rate);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.gif']);

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.opus']);

export const IMAGE_DEFAULT_DURATION = 5;

export interface ProbeOptions {
  /** Override the id assigned to the asset. */
  id?: Id;
  /** Override the path recorded on the asset. */
  recordPath?: string;
}

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
  /** Transaction owner records its exclusive file for cleanup if registration fails. */
  onCopyCreated?: (file: string, identity: { dev: number; ino: number }) => void;
}

export async function importMedia(filePath: string, opts: ImportOptions = {}): Promise<MediaAsset> {
  if (opts.copyTo) {
    const sourceIdentity = await hashMediaSource(filePath);
    await fs.mkdir(opts.copyTo, { recursive: true });
    const id = opts.id ?? newMediaId();
    const filename = `${id}${path.extname(filePath)}`;
    const destination = path.join(opts.copyTo, filename);
    // Files from different directories can have the same name. Each import owns
    // its copy, so it cannot silently bind to a previously imported file.
    await fs.copyFile(filePath, destination, constants.COPYFILE_EXCL);
    const createdStat = await fs.lstat(destination);
    try {
      opts.onCopyCreated?.(destination, { dev: createdStat.dev, ino: createdStat.ino });
      const [copiedIdentity, sourceAfterCopy] = await Promise.all([hashMediaSource(destination), hashMediaSource(filePath)]);
      if (copiedIdentity.sha256 !== sourceIdentity.sha256 || copiedIdentity.size !== sourceIdentity.size ||
          sourceAfterCopy.sha256 !== sourceIdentity.sha256 || sourceAfterCopy.size !== sourceIdentity.size)
        throw new EditorError('CONFLICT', 'Media source changed while it was being imported', { path: filePath, destination });
      const asset = await probeMedia(destination, { ...opts, id, recordPath: filename });
      const destinationAfterProbe = await hashMediaSource(destination);
      if (destinationAfterProbe.sha256 !== copiedIdentity.sha256 || destinationAfterProbe.size !== copiedIdentity.size)
        throw new EditorError('CONFLICT', 'Imported media changed while it was being probed', { path: destination });
      return { ...asset, name: path.basename(filePath), path: filename, copied: true, sourceIdentity: copiedIdentity };
    } catch (error) {
      // The destination was created with COPYFILE_EXCL. Remove it on failure
      // only while it still has the same filesystem identity as that copy.
      try {
        const current = await fs.lstat(destination);
        if (current.isFile() && current.ino === createdStat.ino && current.dev === createdStat.dev) await fs.unlink(destination);
      } catch { /* Leave uncertain or externally replaced files untouched. */ }
      throw error;
    }
  }
  const sourceIdentity = await hashMediaSource(filePath);
  const asset = await probeMedia(filePath, opts);
  const sourceAfterProbe = await hashMediaSource(filePath);
  if (sourceIdentity.sha256 !== sourceAfterProbe.sha256 || sourceIdentity.size !== sourceAfterProbe.size)
    throw new EditorError('CONFLICT', 'Media source changed while it was being imported', { path: filePath });
  return { ...asset, sourceIdentity };
}
