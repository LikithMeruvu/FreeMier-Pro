import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { probeMock } = vi.hoisted(() => ({ probeMock: vi.fn() }));
vi.mock('../../src/providers/ffmpeg/run.js', () => ({ runFfprobe: probeMock }));

import { importMedia } from '../../src/import/media.js';

let directory: string | undefined;
afterEach(async () => {
  vi.resetAllMocks();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function tempDir(): Promise<string> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-import-identity-'));
  return directory;
}
const validProbe = { streams: [{ codec_type: 'video', duration: '1', width: 16, height: 16, r_frame_rate: '25/1' }], format: { duration: '1' } };

describe('copied media import failures', () => {
  it('removes the exclusive destination when probing fails', async () => {
    const dir = await tempDir(), source = path.join(dir, 'bad.mp4'), copyTo = path.join(dir, 'media');
    await fs.writeFile(source, 'invalid media bytes');
    probeMock.mockRejectedValueOnce(new Error('probe failed'));
    await expect(importMedia(source, { id: 'media_probe_fail', copyTo })).rejects.toThrow('probe failed');
    await expect(fs.readdir(copyTo)).resolves.toEqual([]);
  });

  it('rejects and cleans up a copied file that changes during probing', async () => {
    const dir = await tempDir(), source = path.join(dir, 'source.mp4'), copyTo = path.join(dir, 'media');
    await fs.writeFile(source, 'source bytes');
    probeMock.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1)!, 'changed during probe');
      return validProbe;
    });
    await expect(importMedia(source, { id: 'media_probe_change', copyTo })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(fs.readdir(copyTo)).resolves.toEqual([]);
  });
});
