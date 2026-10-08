import { promises as fs } from 'node:fs';
import path from 'node:path';
import { probeMedia } from '../import/media.js';
import { runFfmpeg } from '../providers/ffmpeg/run.js';

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
