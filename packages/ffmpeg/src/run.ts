import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EditorError } from '@freemier/shared';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * FFmpeg subprocess wrapper.
 *
 * Rules learned the hard way:
 *  - ALWAYS pass arguments as an array via execFile. Never build a shell string.
 *    On Windows, shell strings break on spaces, quotes, and drive letters.
 *  - Set maxBuffer high: ffprobe JSON and raw PCM easily exceed the 1 MB default.
 *  - Surface the tail of stderr on failure — FFmpeg's error text is the only
 *    useful diagnostic and it appears at the END of the output.
 */

export interface FfmpegConfig {
  ffmpegPath: string;
  ffprobePath: string;
}

const DEFAULT_CONFIG: FfmpegConfig = {
  ffmpegPath: process.env.FREEMIER_FFMPEG ?? 'ffmpeg',
  ffprobePath: process.env.FREEMIER_FFPROBE ?? 'ffprobe',
};

let config: FfmpegConfig = { ...DEFAULT_CONFIG };

/** Override binary paths (useful for tests and bundled builds). */
export function configureFfmpeg(next: Partial<FfmpegConfig>): void {
  config = { ...config, ...next };
}

export function getFfmpegConfig(): FfmpegConfig {
  return { ...config };
}

/** Extract the last few lines of stderr — where FFmpeg puts the real reason. */
function stderrTail(stderr: string, lines = 12): string {
  return stderr.trim().split(/\r?\n/).slice(-lines).join('\n');
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run ffmpeg with an argument array. Throws a structured EditorError on failure. */
export async function runFfmpeg(args: string[], label = 'ffmpeg', options: { cwd?: string } = {}): Promise<RunResult> {
  try {
    const binary = options.cwd && !path.isAbsolute(config.ffmpegPath) && /[\\/]/.test(config.ffmpegPath) ? path.resolve(config.ffmpegPath) : config.ffmpegPath;
    const { stdout, stderr } = await execFileAsync(binary, args, {
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      cwd: options.cwd,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string };
    if (e.code === 'ENOENT') {
      throw new EditorError('IO_ERROR', `${label} not found on PATH. Install FFmpeg or set FREEMIER_FFMPEG.`, {
        binary: config.ffmpegPath,
      });
    }
    throw new EditorError('EXPORT_ERROR', `${label} failed`, {
      args,
      stderr: stderrTail(e.stderr ?? ''),
      message: e.message,
    });
  }
}

/** Run ffprobe and return parsed JSON. */
export async function runFfprobe(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(config.ffprobePath, args, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      throw new EditorError('IO_ERROR', 'ffprobe not found on PATH. Install FFmpeg or set FREEMIER_FFPROBE.', {
        binary: config.ffprobePath,
      });
    }
    throw new EditorError('PROBE_ERROR', 'ffprobe failed', {
      args,
      stderr: stderrTail(e.stderr ?? ''),
      message: e.message,
    });
  }
}

/** Verify both binaries are callable. Returns their version banner. */
export async function checkFfmpeg(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const [{ stdout: a }, { stdout: b }] = await Promise.all([
    execFileAsync(config.ffmpegPath, ['-version'], { windowsHide: true, encoding: 'utf8' }),
    execFileAsync(config.ffprobePath, ['-version'], { windowsHide: true, encoding: 'utf8' }),
  ]);
  return { ffmpeg: a.split('\n')[0] ?? '', ffprobe: b.split('\n')[0] ?? '' };
}
