import { EditorError } from '@freemier/shared';

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
