import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMediaCandidates, hashMediaSource, importMedia, inspectMediaSource } from '../../src/index.js';

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-media-identity-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => { for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe('source identity providers', () => {
  it('retains an externally replaced staged pathname when its owner callback fails', async () => {
    const dir = await tempDir(), source = path.join(dir, 'source.bin'), copyTo = path.join(dir, 'copies');
    await fs.writeFile(source, 'owned source bytes');
    let destination = '';
    await expect(importMedia(source, { copyTo, onCopyCreated(file) {
      destination = file;
      renameSync(file, file + '.retained');
      writeFileSync(file, 'externally replaced bytes');
      throw new Error('registration aborted');
    } })).rejects.toThrow('registration aborted');
    expect(await fs.readFile(destination, 'utf8')).toBe('externally replaced bytes');
    expect(await fs.readFile(destination + '.retained', 'utf8')).toBe('owned source bytes');
  });
  it('hashes actual bytes and reports missing, unchanged, and replaced sources', async () => {
    const dir = await tempDir(), file = path.join(dir, 'shot.mov');
    await fs.writeFile(file, 'original bytes');
    const identity = await hashMediaSource(file);
    expect(identity).toMatchObject({ size: 14, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await inspectMediaSource(file, identity, true)).toMatchObject({ status: 'available', identity });
    await fs.writeFile(file, 'replacement!!!');
    expect(await inspectMediaSource(file, identity, true)).toMatchObject({ status: 'changed' });
    expect(await inspectMediaSource(path.join(dir, 'missing.mov'), identity)).toMatchObject({ status: 'missing' });
    expect(await inspectMediaSource(file)).toMatchObject({ status: 'unverified' });
  });

  it('finds exact duplicate bytes and rejects same-name wrong bytes', async () => {
    const dir = await tempDir(), root = path.join(dir, 'root'), nested = path.join(root, 'nested');
    await fs.mkdir(nested, { recursive: true });
    const source = path.join(dir, 'source.mp4');
    await fs.writeFile(source, 'same content');
    const identity = await hashMediaSource(source);
    await fs.writeFile(path.join(root, 'clip.mp4'), 'wrong content');
    await fs.writeFile(path.join(nested, 'copy.mp4'), 'same content');
    const found = await findMediaCandidates(identity, [root]);
    expect(found.candidates.map((c) => c.path)).toEqual([path.join(nested, 'copy.mp4')]);
    expect(found.candidates[0]).toMatchObject({ match: 'exact', identity });
  });

  it('requires identity for candidate search and honestly reports scan limits', async () => {
    const dir = await tempDir(), root = path.join(dir, 'root');
    await fs.mkdir(root);
    const source = path.join(dir, 'source.bin'); await fs.writeFile(source, 'candidate');
    await fs.writeFile(path.join(root, 'match.bin'), 'candidate');
    await fs.writeFile(path.join(root, 'other.bin'), 'different');
    const identity = await hashMediaSource(source);
    await expect(findMediaCandidates(undefined, [root])).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await findMediaCandidates(identity, [root], { maxEntries: 1 })).toMatchObject({ truncated: true, visitedEntries: 1 });
    expect(await findMediaCandidates(identity, [root], { maxHashBytes: 1 })).toMatchObject({ truncated: true, hashedBytes: 0, candidates: [] });
  });

  it('skips symlinks when the platform permits creating them', async () => {
    const dir = await tempDir(), root = path.join(dir, 'root'), outside = path.join(dir, 'outside');
    await fs.mkdir(root); await fs.writeFile(outside, 'linked content');
    const identity = await hashMediaSource(outside);
    try { await fs.symlink(outside, path.join(root, 'linked')); }
    catch { return; }
    expect((await findMediaCandidates(identity, [root])).candidates).toEqual([]);
    await expect(findMediaCandidates(identity, [path.join(root, 'linked')])).resolves.toMatchObject({ candidates: [] });
    expect(await inspectMediaSource(path.join(root, 'linked'), identity, true)).toMatchObject({ status: 'available', identity });
  });

  it('persists the identity of the actual bytes imported from a native media fixture', async () => {
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/media/clipA.mp4');
    const bytes = await fs.readFile(fixture);
    const referenced = await importMedia(fixture);
    expect(referenced.sourceIdentity).toEqual({ sha256: (await hashMediaSource(fixture)).sha256, size: bytes.length });
    const dir = await tempDir(), copied = await importMedia(fixture, { copyTo: dir });
    expect(copied.sourceIdentity).toEqual(referenced.sourceIdentity);
    expect(await fs.readFile(path.join(dir, path.basename(copied.path)))).toEqual(bytes);
  });
});
