import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EditorStore, addClip, addLinkedClip, addMediaAsset, updateMediaMetadata,
} from '@freemier/engine';
import { exportProject, getFfmpegConfig, hashMediaSource, importMedia, probeMedia } from '@freemier/media';
import type { MediaAsset } from '@freemier/shared';
import type { CommandContext } from '../../src/commands/context.js';
import { MEDIA_LIBRARY_COMMANDS } from '../../src/commands/media-library.js';
import { MEDIA_COMMANDS } from '../../src/commands/media.js';
import { LiveBridge } from '../../src/connection/bridge.js';
import { relinkMedia } from '../../src/library/relink.js';

const exec = promisify(execFile);
let directory: string, original: string, short: string, audio: string;
let workspaceNumber = 0;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freemier-service-relink-'));
  original = path.join(directory, 'original AV.mp4'); short = path.join(directory, 'short AV.mp4'); audio = path.join(directory, 'audio.wav');
  const binary = getFfmpegConfig().ffmpegPath;
  const av = async (file: string, duration: string) => exec(binary, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', duration,
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ], { windowsHide: true, maxBuffer: 4 * 1024 ** 2 });
  await av(original, '1'); await av(short, '0.4');
  await exec(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '1', audio],
    { windowsHide: true, maxBuffer: 4 * 1024 ** 2 });
});

afterAll(async () => {
  if (directory) {
    expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function context(copied = false, legacy = false): Promise<{ ctx: CommandContext; asset: MediaAsset; notifications: unknown[] }> {
  const workspace = path.join(directory, `workspace-${++workspaceNumber}`); await fs.mkdir(workspace);
  const imported = await importMedia(original, copied ? { copyTo: path.join(workspace, 'media') } : {});
  const { sourceIdentity, ...withoutIdentity } = imported;
  const asset = legacy ? withoutIdentity : imported;
  const sourceStore = EditorStore.create({ fps: 25, width: 160, height: 90 }); addMediaAsset(sourceStore, asset);
  const store = new EditorStore(sourceStore.project), notifications: unknown[] = [];
  return { ctx: { store, workspace, notify: (event) => notifications.push(event) }, asset, notifications };
}

async function candidateCopy(name: string): Promise<string> {
  const candidate = path.join(directory, `${name}-${++workspaceNumber}.mp4`); await fs.copyFile(original, candidate); return candidate;
}

async function refuseUnchanged(ctx: CommandContext, options: Parameters<typeof relinkMedia>[1], message?: RegExp): Promise<void> {
  const state = ctx.store.state, undo = ctx.store.canUndo, redo = ctx.store.canRedo, events: unknown[] = [];
  const unsubscribe = ctx.store.subscribe((event) => events.push(event));
  try {
    const pending = relinkMedia(ctx, options);
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
    if (message) await expect(pending).rejects.toThrow(message);
    expect(ctx.store.state).toBe(state); expect(ctx.store.canUndo).toBe(undo); expect(ctx.store.canRedo).toBe(redo); expect(events).toEqual([]);
  } finally { unsubscribe(); }
}

describe('verified native media relink transactions', () => {
  it('refuses malformed library or source identity at the native export boundary before touching an existing output', async () => {
    const { ctx, asset } = await context();
    addClip(ctx.store, { assetId: asset.id, trackId: ctx.store.project.timeline.tracks.find((track) => track.kind === 'video')!.id, start: 0, duration: .5 });
    const outputPath = path.join(ctx.workspace, 'keep.mp4');
    const existing = await fs.readFile(original); await fs.writeFile(outputPath, existing);
    const invalidSnapshots = [
      { ...ctx.store.project, mediaLibrary: { version: 1, bins: [], entries: [{ assetId: 'missing', binId: null, description: '', tags: [], rating: 0 }] } },
      { ...ctx.store.project, media: [{ ...asset, sourceIdentity: { sha256: 'bad', size: -1 } }] },
    ];
    for (const snapshot of invalidSnapshots) {
      await expect(exportProject(snapshot as any, { outputPath })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(await fs.readFile(outputPath)).toEqual(existing);
    }
  });
  it('copies to a fresh exclusive filename, retains old bytes, emits once and restores exact copied location by undo', async () => {
    const { ctx, asset } = await context(true), candidate = await candidateCopy('copied replacement');
    addLinkedClip(ctx.store, { assetId: asset.id, videoTrackId: ctx.store.project.timeline.tracks[1]!.id,
      audioTrackId: ctx.store.project.timeline.tracks[0]!.id, start: 0, duration: .8 });
    const before = ctx.store.project, revision = ctx.store.revision, events: unknown[] = [];
    const oldFile = path.join(ctx.workspace, 'media', asset.path), oldBytes = await fs.readFile(oldFile);
    const oldFiles = await fs.readdir(path.join(ctx.workspace, 'media'));
    ctx.store.subscribe((event) => events.push(event));
    const replacement = await relinkMedia(ctx, { assetId: asset.id, path: candidate, expectedRevision: revision });
    expect(replacement.copied).toBe(true); expect(path.isAbsolute(replacement.path)).toBe(false); expect(replacement.path).not.toBe(asset.path);
    expect(replacement.id).toBe(asset.id); expect(replacement.sourceIdentity).toEqual(asset.sourceIdentity);
    expect(ctx.store.project.timeline).toBe(before.timeline); expect(ctx.store.revision).toBe(revision + 1); expect(events).toHaveLength(1);
    const newFile = path.join(ctx.workspace, 'media', replacement.path);
    expect(await fs.readFile(newFile)).toEqual(oldBytes); expect(await fs.readFile(oldFile)).toEqual(oldBytes);
    expect((await fs.readdir(path.join(ctx.workspace, 'media'))).sort()).toEqual([...oldFiles, replacement.path].sort());
    expect(ctx.store.undo()).toBe(true); expect(ctx.store.project).toBe(before);
    expect(await fs.readFile(newFile)).toEqual(oldBytes); expect(await fs.readFile(oldFile)).toEqual(oldBytes);
    expect(ctx.store.redo()).toBe(true); expect(ctx.store.project.media[0]!.path).toBe(replacement.path);
  });

  it('requires exact saved identity for referenced media despite explicit unverified consent and switches matching moved bytes once', async () => {
    const { ctx, asset } = await context(), candidate = await candidateCopy('moved source');
    const wrong = await candidateCopy('same name wrong bytes'), bytes = await fs.readFile(wrong); bytes[bytes.length - 1]! ^= 1; await fs.writeFile(wrong, bytes);
    expect((await fs.stat(wrong)).size).toBe(asset.sourceIdentity!.size);
    await refuseUnchanged(ctx, { assetId: asset.id, path: wrong, acceptUnverified: true }, /bytes do not match/i);
    await refuseUnchanged(ctx, { assetId: asset.id, path: candidate, expectedRevision: ctx.store.revision + 1 }, /project changed/i);
    const before = ctx.store.project;
    const updated = await relinkMedia(ctx, { assetId: asset.id, path: candidate, expectedRevision: ctx.store.revision });
    expect(updated).toEqual({ ...asset, path: candidate }); expect(ctx.store.project.media[0]).toBe(updated);
    expect(ctx.store.undo()).toBe(true); expect(ctx.store.project).toBe(before);
  });

  it('requires explicit legacy consent and refuses incompatible kind or media too short for edited source windows', async () => {
    const { ctx, asset } = await context(false, true), candidate = await candidateCopy('legacy moved');
    addClip(ctx.store, { assetId: asset.id, trackId: ctx.store.project.timeline.tracks[1]!.id, sourceIn: .4, duration: .52 });
    expect(ctx.store.project.timeline.tracks[1]!.clips[0]!.sourceOut).toBeGreaterThan((await probeMedia(short)).duration);
    await refuseUnchanged(ctx, { assetId: asset.id, path: candidate }, /no saved file identity/i);
    await refuseUnchanged(ctx, { assetId: asset.id, path: audio, acceptUnverified: true }, /properties differ/i);
    await refuseUnchanged(ctx, { assetId: asset.id, path: short, acceptUnverified: true }, /duration|source range/i);
    const before = ctx.store.project;
    const relinked = await relinkMedia(ctx, { assetId: asset.id, path: candidate, acceptUnverified: true });
    expect(relinked.sourceIdentity).toEqual(await hashMediaSource(candidate)); expect(ctx.store.project.timeline).toBe(before.timeline);
    expect(ctx.store.undo()).toBe(true); expect(ctx.store.project).toBe(before); expect(ctx.store.project.media[0]!.sourceIdentity).toBeUndefined();
  });

  it.each(['edit', 'undo ABA'] as const)('refuses a concurrent %s during asynchronous hashing without relink history or staged copy residue', async (mode) => {
    const { ctx, asset } = await context(true), candidate = await candidateCopy('concurrent');
    const files = await fs.readdir(path.join(ctx.workspace, 'media')), start = ctx.store.state, events: unknown[] = [];
    ctx.store.subscribe((event) => events.push(event));
    // hashMediaSource awaits stat before opening its real byte stream, so an
    // immediate store edit deterministically intervenes without timing sleeps.
    const pending = relinkMedia(ctx, { assetId: asset.id, path: candidate, expectedRevision: ctx.store.revision });
    updateMediaMetadata(ctx.store, asset.id, { rating: 1 });
    if (mode === 'undo ABA') { expect(ctx.store.undo()).toBe(true); expect(ctx.store.state).toBe(start); }
    const expected = ctx.store.state, undo = ctx.store.canUndo, redo = ctx.store.canRedo;
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ctx.store.state).toBe(expected); expect(ctx.store.canUndo).toBe(undo); expect(ctx.store.canRedo).toBe(redo);
    expect(events).toHaveLength(mode === 'edit' ? 1 : 2);
    expect(await fs.readdir(path.join(ctx.workspace, 'media'))).toEqual(files);
    expect(ctx.store.project.media[0]!.path).toBe(asset.path);
    if (mode === 'undo ABA') { expect(ctx.store.redo()).toBe(true); expect(ctx.store.project.mediaLibrary!.entries[0]!.rating).toBe(1); }
  });

  it('observes native missing, changed, unverified and verified files without editing state or history', async () => {
    const { ctx, asset, notifications } = await context(), observedPath = await candidateCopy('observed');
    const sourceAsset = { ...asset, path: observedPath };
    const { sourceIdentity, ...legacyAsset } = { ...asset, id: 'legacy', path: observedPath };
    addMediaAsset(ctx.store, legacyAsset);
    // Build the observation snapshot before taking the no-mutation baseline.
    ctx.store.load({ ...ctx.store.project, media: [sourceAsset, legacyAsset] });
    const command = MEDIA_LIBRARY_COMMANDS.find((entry) => entry.name === 'media_availability')!;
    const state = ctx.store.state, events: unknown[] = []; ctx.store.subscribe((event) => events.push(event));
    const inspect = async (verify: boolean) => await command.handler({ verify }, ctx) as any;
    expect((await inspect(true)).observations.map((row: any) => row.status)).toEqual(['available', 'unverified']);
    expect((await inspect(false)).observations.map((row: any) => row.status)).toEqual(['unverified', 'unverified']);
    const bytes = await fs.readFile(observedPath); bytes[bytes.length - 1]! ^= 1; await fs.writeFile(observedPath, bytes);
    expect((await inspect(true)).observations[0].status).toBe('changed');
    await fs.unlink(observedPath);
    const missing = await inspect(true); expect(missing).toMatchObject({ revision: state.revision, stale: false });
    expect(missing.observations.map((row: any) => row.status)).toEqual(['missing', 'missing']);
    expect(ctx.store.state).toBe(state); expect(ctx.store.canUndo).toBe(false); expect(ctx.store.canRedo).toBe(false);
    expect(events).toEqual([]); expect(notifications).toEqual([]);
  });

  it.each(['edit', 'undo ABA'] as const)('cleans an exclusive copied import after a concurrent %s without registration, extra history or notifications', async (mode) => {
    const { ctx, asset, notifications } = await context(true), mediaDirectory = path.join(ctx.workspace, 'media');
    const files = await fs.readdir(mediaDirectory), oldFile = path.join(mediaDirectory, asset.path), oldBytes = await fs.readFile(oldFile);
    const start = ctx.store.state, events: unknown[] = []; ctx.store.subscribe((event) => events.push(event));
    const command = MEDIA_COMMANDS.find((entry) => entry.name === 'media_import')!;
    const pending = command.handler({ path: original, copyIntoProject: true }, ctx);
    updateMediaMetadata(ctx.store, asset.id, { description: 'Concurrent edit' });
    if (mode === 'undo ABA') { expect(ctx.store.undo()).toBe(true); expect(ctx.store.state).toBe(start); }
    const expected = ctx.store.state, undo = ctx.store.canUndo, redo = ctx.store.canRedo;
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ctx.store.state).toBe(expected); expect(ctx.store.canUndo).toBe(undo); expect(ctx.store.canRedo).toBe(redo);
    expect(ctx.store.project.media).toHaveLength(1); expect(events).toHaveLength(mode === 'edit' ? 1 : 2);
    expect(await fs.readdir(mediaDirectory)).toEqual(files); expect(await fs.readFile(oldFile)).toEqual(oldBytes); expect(notifications).toEqual([]);
    if (mode === 'undo ABA') { expect(ctx.store.redo()).toBe(true); expect(ctx.store.project.mediaLibrary!.entries[0]!.description).toBe('Concurrent edit'); }
  });

  it('retains an external replacement at a staged pathname when copied import or relink fails', async () => {
    for (const operation of ['import', 'relink'] as const) {
      const { ctx, asset, notifications } = await context(true), mediaDirectory = await fs.realpath(path.join(ctx.workspace, 'media'));
      const oldFile = path.join(mediaDirectory, asset.path), oldBytes = await fs.readFile(oldFile), replacementBytes = await fs.readFile(short);
      const state = ctx.store.state, events: unknown[] = []; ctx.store.subscribe((event) => events.push(event));
      const realLstat = fs.lstat.bind(fs);
      let replacedPath: string | undefined, ownedPath: string | undefined;
      // Preserve real filesystem I/O and native probing. Intervene once just
      // after the transaction captures its fresh file's original identity.
      // Renaming keeps that inode alive, so replacement inode reuse cannot
      // disguise ownership on either supported filesystem platform.
      const spy = vi.spyOn(fs, 'lstat').mockImplementation((async (file: any, ...args: any[]) => {
        const info = await (realLstat as any)(file, ...args);
        if (!replacedPath && typeof file === 'string' && path.dirname(file) === mediaDirectory && file !== oldFile) {
          replacedPath = file; ownedPath = `${file}.owned-original`;
          await fs.rename(file, ownedPath); await fs.copyFile(short, file);
          const external = await realLstat(file);
          expect(external.ino).not.toBe(info.ino);
        }
        return info;
      }) as typeof fs.lstat);
      try {
        const pending = operation === 'relink'
          ? relinkMedia(ctx, { assetId: asset.id, path: original, expectedRevision: ctx.store.revision })
          : MEDIA_COMMANDS.find((entry) => entry.name === 'media_import')!.handler({ path: original, copyIntoProject: true }, ctx);
        await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(replacedPath).toBeDefined(); expect(ownedPath).toBeDefined();
        expect(await fs.readFile(replacedPath!)).toEqual(replacementBytes);
        expect(await fs.readFile(ownedPath!)).toEqual(oldBytes); expect(await fs.readFile(oldFile)).toEqual(oldBytes);
        expect(ctx.store.state).toBe(state); expect(ctx.store.canUndo).toBe(false); expect(ctx.store.canRedo).toBe(false);
        expect(events).toEqual([]); expect(notifications).toEqual([]);
        expect((await fs.readdir(mediaDirectory)).sort()).toEqual([asset.path, path.basename(replacedPath!), path.basename(ownedPath!)].sort());
      } finally { spy.mockRestore(); }
    }
  });

  it('recovers real bridge thumbnail/waveform failures, invalidates successful caches after location changes, and follows undo', async () => {
    const { ctx, asset } = await context(), oldPath = path.join(ctx.workspace, 'missing source.mp4'), candidate = await candidateCopy('bridge replacement');
    ctx.store.load({ ...ctx.store.project, media: [{ ...asset, path: oldPath }] });
    const bridge = new LiveBridge({ store: ctx.store, workspace: ctx.workspace, port: 0 });
    const base = `http://127.0.0.1:${await bridge.start()}`;
    const request = async (route: string) => {
      const response = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id }) });
      return { status: response.status, body: await response.json() as any };
    };
    const available = async () => {
      const waveform = await request('waveform'); expect(waveform.status).toBe(200); expect(waveform.body.ok).toBe(true);
      expect(waveform.body.peaks.length).toBeGreaterThan(0); expect(waveform.body.peaks.some((peak: number) => peak > .1)).toBe(true);
      const thumbnail = await request('thumbnail'); expect(thumbnail.status).toBe(200); expect(thumbnail.body.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
      expect(Buffer.from(thumbnail.body.dataUrl.split(',')[1], 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    };
    const unavailable = async () => { for (const route of ['waveform', 'thumbnail']) { const result = await request(route); expect(result.status).toBe(400); expect(result.body.ok).toBe(false); } };
    try {
      await unavailable(); await fs.copyFile(original, oldPath); await available();
      await fs.unlink(oldPath);
      const before = ctx.store.project, stateBefore = await (await fetch(`${base}/state`)).json() as any;
      const updated = await relinkMedia(ctx, { assetId: asset.id, path: candidate, expectedRevision: ctx.store.revision });
      await available();
      const changed = await (await fetch(`${base}/state`)).json() as any;
      expect(changed.eventSequence).toBe(stateBefore.eventSequence + 1); expect(changed.project.media[0].path).toBe(updated.path);
      expect(Buffer.from(await (await fetch(`${base}/media/${asset.id}`)).arrayBuffer())).toEqual(await fs.readFile(candidate));
      expect(ctx.store.undo()).toBe(true); expect(ctx.store.project).toBe(before);
      await unavailable(); expect((await fetch(`${base}/media/${asset.id}`)).status).toBe(404);
      await fs.copyFile(original, oldPath); await available();
      expect(ctx.store.redo()).toBe(true); await available();
    } finally { await bridge.stop(); }
  });
});
