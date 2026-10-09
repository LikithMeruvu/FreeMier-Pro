import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EditorStore, addClip, addMediaAsset, addTrack, addTransition, updateClip } from '@freemier/engine';
import { blendTransitionPixel, resolveTransition, type Project, type Transition } from '@freemier/shared';
import { buildExportArgs, exportProject } from '../../src/export/export.js';
import { probeMedia } from '../../src/import/media.js';
import { preflightTransitionStreams } from '../../src/rendering/transitions.js';
import { runFfmpeg } from '../../src/providers/ffmpeg/run.js';

const exec = promisify(execFile), W = 64, H = 48, FPS = 10;
let dir: string, red: string, blue: string, gray: string, toneA: string, toneB: string, short: string, shortAudio: string, temporal: string, delayedAudio: string, shiftedVideo: string, offGridVideo: string, mixedRateVideo: string;
const ff = (args: string[]) => exec('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
beforeAll(async () => {
  await fs.mkdir('.tmp', { recursive: true }); dir = await fs.mkdtemp(path.resolve('.tmp/transitions-'));
  [red, blue, gray, toneA, toneB, short, shortAudio, temporal, delayedAudio, shiftedVideo, offGridVideo, mixedRateVideo] = ['red.mkv', 'blue.mkv', 'gray.mkv', 'a.wav', 'b.wav', 'short.mkv', 'short-audio.mkv', 'temporal.mkv', 'delayed-audio.mkv', 'shifted-video.mkv', 'off-grid-video.mkv', 'mixed-rate-video.mkv'].map(name => path.join(dir, name));
  for (const [file, color] of [[red, 'red'], [blue, 'blue'], [gray, '0x808080']] as const)
    await ff(['-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:r=${FPS}:d=6`, '-c:v', 'ffv1', file]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000:duration=6', toneA]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=6', toneB]);
  // Container duration deliberately exceeds its actual video stream.
  await ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=${FPS}:d=2`, '-f', 'lavfi', '-i', 'sine=duration=6', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', short]);
  await ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=${FPS}:d=6`, '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', shortAudio]);
  await ff(['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=${FPS}:d=6,geq=r='40+30*T':g='20*T':b='10*T'`, '-c:v', 'ffv1', temporal]);
  await ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=${FPS}:d=6`, '-f', 'lavfi', '-i', 'sine=frequency=400:duration=5', '-filter_complex', '[1:a]asetpts=PTS+1/TB[delayed]', '-map', '0:v', '-map', '[delayed]', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', delayedAudio]);
  await ff(['-i', temporal, '-vf', 'setpts=PTS+5/TB', '-c:v', 'ffv1', shiftedVideo]);
  await ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=${FPS}:d=6`, '-f', 'lavfi', '-i', 'sine=duration=6', '-filter_complex', '[0:v]settb=1/1000,setpts=PTS+30[delayed]', '-map', '[delayed]', '-map', '1:a', '-c:v', 'ffv1', '-enc_time_base:v', '1/1000', '-fps_mode:v', 'passthrough', '-c:a', 'pcm_s16le', offGridVideo]);
  await ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=25:d=6`, '-c:v', 'ffv1', mixedRateVideo]);
});
afterAll(async () => {
  expect(path.resolve(dir).startsWith(path.resolve('.tmp') + path.sep)).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

async function setup(type: Transition['type'] = 'dissolve', alignment: Transition['alignment'] = 'center', durationFrames = 10, source = red) {
  const store = EditorStore.create({ width: W, height: H, fps: FPS });
  const track = store.project.timeline.tracks.find(item => item.kind === (type === 'dissolve' ? 'video' : 'audio'))!;
  const leftAsset = addMediaAsset(store, await probeMedia(type === 'dissolve' || source !== red ? source : toneA));
  const rightAsset = addMediaAsset(store, await probeMedia(type === 'dissolve' ? blue : toneB));
  const left = addClip(store, { trackId: track.id, assetId: leftAsset.id, sourceIn: 1, start: 0, duration: 2 });
  const right = addClip(store, { trackId: track.id, assetId: rightAsset.id, sourceIn: 1.5, start: 2, duration: 2 });
  const transition: Transition = { id: 'native-transition', type, leftClipId: left.id, rightClipId: right.id, alignment, durationFrames };
  const project = (): Project => ({ ...store.project, timeline: { ...store.project.timeline, transitions: [transition] } });
  return { store, left, right, track, transition, project };
}
let serial = 0;
async function render(project: Project) {
  const file = path.join(dir, `render-${serial++}.mp4`);
  await exportProject(project, { outputPath: file, crf: 0, preset: 'ultrafast' }); return file;
}
async function pixels(file: string) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
const pixel = (frames: Buffer, index: number, x = W / 2, y = H / 2) => [...frames.subarray((index * W * H + y * W + x) * 3, (index * W * H + y * W + x) * 3 + 3)];

describe('native duration-preserving transitions', () => {
  it('gives audio clips independent input ownership while reusing video endpoints', () => {
    const store = EditorStore.create({ width: W, height: H, fps: FPS });
    const asset = addMediaAsset(store, {
      id: 'synthetic-av', path: 'synthetic-av.mp4', copied: false, name: 'Synthetic AV', kind: 'video',
      duration: 6, width: W, height: H, fps: FPS, hasAudio: true, sampleRate: 48000,
      videoCodec: 'h264', audioCodec: 'aac', probedAt: 0,
    });
    const pairs = new Map<string, ReturnType<typeof addClip>[]>();
    for (const track of store.project.timeline.tracks) {
      pairs.set(track.kind, [
        addClip(store, { trackId: track.id, assetId: asset.id, start: 0, sourceIn: 1, duration: 2 }),
        addClip(store, { trackId: track.id, assetId: asset.id, start: 2, sourceIn: 3, duration: 2 }),
      ]);
    }
    for (const [kind, clips] of pairs) addTransition(store, { leftClipId: clips[0]!.id, rightClipId: clips[1]!.id, type: kind === 'video' ? 'dissolve' : 'audio_crossfade', durationFrames: 10 });
    const { args } = buildExportArgs(store.project, { outputPath: 'unused.mp4' });
    expect(args.filter(argument => argument === '-i')).toHaveLength(3);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    const videoInputs = [...graph.matchAll(/\[(\d+):v\]/g)].map(match => Number(match[1]));
    const audioInputs = [...graph.matchAll(/\[(\d+):a\]/g)].map(match => Number(match[1]));
    // Ordinary video clips and dissolve endpoints retain one video input;
    // each audio window owns a decoder independent of every other trim.
    expect(videoInputs).toHaveLength(4); expect(audioInputs).toHaveLength(2);
    expect(new Set(videoInputs).size).toBe(1); expect(new Set(audioInputs).size).toBe(2);
    for (const input of audioInputs) expect(videoInputs).not.toContain(input);
  });

  it.each(['center', 'start', 'end'] as const)('decodes %s odd-frame dissolve at the derived interval without shifting the cut', async alignment => {
    const fixture = await setup('dissolve', alignment, 9), project = fixture.project();
    const resolved = resolveTransition(project.timeline, project.media, fixture.transition);
    const frames = await pixels(await render(project));
    expect(frames.length / (W * H * 3)).toBe(40);
    const a = pixel(frames, resolved.startFrame - 1), b = pixel(frames, resolved.endFrame);
    expect(a[0]).toBeGreaterThan(245); expect(a[2]).toBeLessThan(8);
    expect(b[0]).toBeLessThan(8); expect(b[2]).toBeGreaterThan(245);
    for (const index of [resolved.startFrame, resolved.startFrame + 4, resolved.endFrame - 1]) {
      const weight = (index - resolved.startFrame) / 9, actual = pixel(frames, index);
      expect(Math.abs(actual[0]! - 253 * (1 - weight))).toBeLessThan(7);
      expect(Math.abs(actual[2]! - 254 * weight)).toBeLessThan(7);
    }
  });

  it('premultiplies unequal alpha once over an underlay and retains static transforms/effects', async () => {
    const fixture = await setup(), { store, left, right } = fixture;
    // Put a gray underlay below the transition track, despite its later creation.
    const underlay = addTrack(store, 'video'), asset = addMediaAsset(store, await probeMedia(gray));
    addClip(store, { trackId: underlay.id, assetId: asset.id, start: 0, duration: 4 });
    store.mutate('track', [underlay.id], project => ({ ...project, timeline: { ...project.timeline, tracks: project.timeline.tracks.map(track => ({ ...track, order: track.id === underlay.id ? 0 : track.order + 1 })) } }));
    updateClip(store, left.id, { transform: { ...left.transform, opacity: { value: .25, keyframes: [] }, x: { value: .1, keyframes: [] }, scale: { value: .5, keyframes: [] }, rotation: { value: 90, keyframes: [] } } });
    updateClip(store, right.id, { transform: { ...right.transform, opacity: { value: .75, keyframes: [] }, x: { value: .1, keyframes: [] }, scale: { value: .5, keyframes: [] }, rotation: { value: 90, keyframes: [] } }, effects: [{ id: 'gray', type: 'grayscale', params: {}, enabled: true }] });
    const frames = await pixels(await render(fixture.project()));
    const actual = pixel(frames, 20), rgba = blendTransitionPixel([253, 0, 0, 255 * .25], [18, 18, 18, 255 * .75], .5);
    const expected = rgba.slice(0, 3).map(value => value * rgba[3] / 255 + 128 * (1 - rgba[3] / 255));
    actual.forEach((value, channel) => expect(Math.abs(value - expected[channel]!)).toBeLessThan(6));
    pixel(frames, 20, 2, 2).forEach(value => expect(Math.abs(value - 128)).toBeLessThan(4));
    // A rotated half-size 64x48 layer is 24x32, including pixels outside
    // the original 32x24 box. Compare the nominal frame and transition start.
    for (const index of [10, 15]) {
      const top = pixel(frames, index, 38, 10), bottom = pixel(frames, index, 38, 37);
      expect(top[0]! - top[1]!).toBeGreaterThan(45);
      expect(bottom[0]! - bottom[1]!).toBeGreaterThan(45);
    }
    expect(frames.length / (W * H * 3)).toBe(40);
  });

  it('places a higher video track above the blended layer', async () => {
    const fixture = await setup(), top = addTrack(fixture.store, 'video');
    const asset = addMediaAsset(fixture.store, await probeMedia(gray));
    addClip(fixture.store, { trackId: top.id, assetId: asset.id, start: 0, duration: 4 });
    pixel(await pixels(await render(fixture.project())), 20).forEach(value => expect(Math.abs(value - 128)).toBeLessThan(4));
  });

  it.each(['center', 'start', 'end'] as const)('measures complementary %s crossfade tone gains with the original sequence duration', async alignment => {
    const fixture = await setup('audio_crossfade', alignment), project = fixture.project();
    const resolved = resolveTransition(project.timeline, project.media, fixture.transition), file = await render(project);
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const amplitude = (center: number, frequency: number) => {
      const first = Math.round((center - .025) * 48000), count = 2400;
      let real = 0, imaginary = 0;
      for (let i = 0; i < count; i++) { const phase = 2 * Math.PI * frequency * (first + i) / 48000, sample = stdout.readFloatLE((first + i) * 4); real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase); }
      return 2 * Math.hypot(real, imaginary) / count;
    };
    const before = amplitude(resolved.start - .1, 400), after = amplitude(resolved.end + .1, 1000);
    for (const progress of [.25, .5, .75]) {
      const time = resolved.start + progress * (resolved.end - resolved.start);
      expect(Math.abs(amplitude(time, 400) / before - (1 - progress))).toBeLessThan(.035);
      expect(Math.abs(amplitude(time, 1000) / after - progress)).toBeLessThan(.035);
    }
    expect(stdout.length / 4 / 48000).toBeGreaterThanOrEqual(4);
    expect(stdout.length / 4 / 48000).toBeLessThan(4.03);
    expect((await pixels(file)).length / (W * H * 3)).toBe(40);
  });

  it('rejects invented video handles despite a longer container duration', async () => {
    const fixture = await setup('dissolve', 'center', 10, short);
    expect(() => buildExportArgs(fixture.project(), { outputPath: 'pure-only.mp4' })).not.toThrow();
    await expect(render(fixture.project())).rejects.toMatchObject({ code: 'UNSUPPORTED', details: expect.objectContaining({ stream: 'video' }) });
  });

  it('rejects invented audio handles despite a longer video/container duration', async () => {
    const fixture = await setup('audio_crossfade', 'center', 10, shortAudio);
    expect(() => buildExportArgs(fixture.project(), { outputPath: 'pure-only.mp4' })).not.toThrow();
    await expect(render(fixture.project())).rejects.toMatchObject({ code: 'UNSUPPORTED', details: expect.objectContaining({ stream: 'audio' }) });
  });

  it('reads a temporally changing left source at its actual nonzero source offset', async () => {
    const fixture = await setup('dissolve', 'center', 10, temporal), output = await pixels(await render(fixture.project())), source = await pixels(temporal);
    const index = 20, weight = .5;
    // Sequence t=2 maps to left source t=1+(2-0)=3, including its outgoing handle.
    const sourcePixel = pixel(source, 30, 20, 20), actual = pixel(output, index, 20, 20);
    const expected = sourcePixel.map((value, channel) => value * (1 - weight) + (channel === 2 ? 254 : 0) * weight);
    actual.forEach((value, channel) => expect(Math.abs(value - expected[channel]!)).toBeLessThan(7));
    expect(pixel(source, 30, 20, 20)).not.toEqual(pixel(source, 5, 20, 20));
  });

  it('keeps delayed audio on the container clock and refuses missing early samples', async () => {
    const fixture = await setup('audio_crossfade', 'center', 10, delayedAudio);
    await expect(preflightTransitionStreams(fixture.project())).resolves.toBeUndefined();
    updateClip(fixture.store, fixture.left.id, { sourceIn: .5, sourceOut: 2.5 });
    await expect(preflightTransitionStreams(fixture.project())).rejects.toMatchObject({ code: 'UNSUPPORTED', details: expect.objectContaining({ stream: 'audio', requiredSourceIn: .5, verifiedSourceOut: .5 }) });
  });

  it('normalizes a uniformly shifted container origin without changing rendered source mapping', async () => {
    const normal = await setup('dissolve', 'center', 10, temporal), shifted = await setup('dissolve', 'center', 10, shiftedVideo);
    const normalFrames = await pixels(await render(normal.project())), shiftedFrames = await pixels(await render(shifted.project()));
    expect(shiftedFrames.length).toBe(normalFrames.length);
    for (const index of [10, 15, 20, 24]) expect(pixel(shiftedFrames, index)).toEqual(pixel(normalFrames, index));
  });

  it('refuses mismatched source rates and verifies decoded geometry even when metadata claims a matching rate', async () => {
    const fixture = await setup('dissolve', 'center', 10, mixedRateVideo), project = fixture.project();
    expect(() => buildExportArgs(project, { outputPath: 'unused.mp4' })).toThrow(/frame rate/i);
    const changedSource: Project = { ...project, media: project.media.map(asset => asset.id === fixture.left.assetId ? { ...asset, fps: FPS } : asset) };
    await expect(preflightTransitionStreams(changedSource)).rejects.toMatchObject({ code: 'UNSUPPORTED', details: expect.objectContaining({ reason: 'frame_geometry' }) });
  });

  it('refuses a matching-rate video whose container-clock frame timestamps are off the sequence grid', async () => {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_format', '-show_entries', 'frame=best_effort_timestamp_time:format=start_time', '-of', 'json', offGridVideo], { windowsHide: true });
    const decoded = JSON.parse(stdout) as { frames: Array<{ best_effort_timestamp_time: string }>; format: { start_time: string } };
    const first = Number(decoded.frames[0]!.best_effort_timestamp_time) - Number(decoded.format.start_time);
    // Encoder time base and passthrough preserve the deliberately authored
    // 30ms offset instead of rounding it onto the encoder's default 100ms grid.
    expect(first).toBeCloseTo(.03, 5);
    const fixture = await setup('dissolve', 'center', 10, offGridVideo);
    await expect(preflightTransitionStreams(fixture.project())).rejects.toMatchObject({ code: 'UNSUPPORTED', details: expect.objectContaining({ reason: 'frame_geometry' }) });
  });

  it('preserves compressed AAC source crossfade gains with combined/audio-only graphs and AAC/PCM outputs', async () => {
    const store = EditorStore.create({ width: 96, height: 64, fps: FPS });
    const videoTrack = store.project.timeline.tracks.find(track => track.kind === 'video')!;
    const audioTrack = store.project.timeline.tracks.find(track => track.kind === 'audio')!;
    const endpoints = [];
    for (const [index, color, frequency] of [[0, 'red', 400], [1, 'blue', 800]] as const) {
      const source = path.join(dir, `compressed-${color}.mp4`);
      await ff(['-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=${FPS}:d=6`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=6`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
      const asset = addMediaAsset(store, await probeMedia(source));
      endpoints.push({
        video: addClip(store, { trackId: videoTrack.id, assetId: asset.id, sourceIn: 2, start: index * 2, duration: 2 }),
        audio: addClip(store, { trackId: audioTrack.id, assetId: asset.id, sourceIn: 2, start: index * 2, duration: 2 }),
      });
    }
    addTransition(store, { leftClipId: endpoints[0]!.video.id, rightClipId: endpoints[1]!.video.id, type: 'dissolve', durationFrames: 10 });
    addTransition(store, { leftClipId: endpoints[0]!.audio.id, rightClipId: endpoints[1]!.audio.id, type: 'audio_crossfade', durationFrames: 10 });
    const combined = store.project;
    const audioOnly: Project = { ...combined, timeline: { ...combined.timeline,
      tracks: combined.timeline.tracks.map(track => track.kind === 'video' ? { ...track, clips: [] } : track),
      transitions: combined.timeline.transitions!.filter(transition => transition.type === 'audio_crossfade'),
    } };
    const toneStats = (pcm: Buffer, frequency: number, time: number, window = .1) => {
      const first = Math.round((time - window / 2) * 48000), count = Math.round(window * 48000);
      let real = 0, imaginary = 0, squares = 0;
      for (let i = 0; i < count; i++) {
        const sample = pcm.readFloatLE((first + i) * 4), phase = 2 * Math.PI * frequency * (first + i) / 48000;
        real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase); squares += sample * sample;
      }
      return { amplitude: 2 * Math.hypot(real, imaginary) / count, rms: Math.sqrt(squares / count) };
    };
    type Measurement = { time: number; left: number; right: number; left20ms: number; right20ms: number; rms20ms: number };
    const results: Array<{ graph: string; codec: string; duration?: number; frames?: number; fullLeft?: number; fullRight?: number; measurements?: Measurement[]; error?: string }> = [];
    // Render every variant before asserting so a failure reports the complete
    // codec/graph matrix rather than hiding evidence behind its first mismatch.
    for (const [graph, project] of [['combined', combined], ['audio-only', audioOnly]] as const) {
      for (const codec of ['aac', 'pcm_s16le'] as const) {
        const output = path.join(dir, `${graph}-${codec}.${codec === 'aac' ? 'mp4' : 'mkv'}`);
        const result: typeof results[number] = { graph, codec };
        try {
          if (codec === 'aac') await exportProject(project, { outputPath: output, preset: 'ultrafast', crf: 12 });
          else {
            await preflightTransitionStreams(project);
            const { args } = buildExportArgs(project, { outputPath: output, preset: 'ultrafast', crf: 12 });
            args[args.indexOf('-c:a') + 1] = codec;
            args.splice(args.indexOf('-b:a'), 2);
            await runFfmpeg(args, 'PCM crossfade regression');
          }
          const { stdout: pcm } = await exec('ffmpeg', ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
          const fullLeft = toneStats(pcm, 400, 1).amplitude, fullRight = toneStats(pcm, 800, 3).amplitude;
          result.duration = pcm.length / 4 / 48000;
          result.frames = (await pixels(output)).length / (96 * 64 * 3);
          result.fullLeft = fullLeft; result.fullRight = fullRight;
          result.measurements = [1.75, 2, 2.25].map(time => ({ time,
            left: toneStats(pcm, 400, time).amplitude / fullLeft, right: toneStats(pcm, 800, time).amplitude / fullRight,
            left20ms: toneStats(pcm, 400, time, .02).amplitude / fullLeft, right20ms: toneStats(pcm, 800, time, .02).amplitude / fullRight,
            rms20ms: toneStats(pcm, 400, time, .02).rms,
          }));
        } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
        results.push(result);
      }
    }
    const evidence = `Compressed AAC crossfade matrix: ${JSON.stringify(results)}`;
    for (const result of results) {
      expect(result.error, evidence).toBeUndefined();
      expect(result.frames, evidence).toBe(40);
      expect(result.duration, evidence).toBeGreaterThanOrEqual(4);
      expect(result.duration, evidence).toBeLessThan(4.03);
      expect(result.fullLeft, evidence).toBeGreaterThan(.1);
      expect(result.fullRight, evidence).toBeGreaterThan(.1);
      for (const row of result.measurements!) {
        const left = 2.5 - row.time, right = row.time - 1.5;
        expect(row.left, evidence).toBeCloseTo(left, 1);
        expect(row.right, evidence).toBeCloseTo(right, 1);
        expect(row.left20ms, evidence).toBeCloseTo(left, 1);
        expect(row.right20ms, evidence).toBeCloseTo(right, 1);
      }
    }
  }, 60000);

  it('preserves a start-aligned crossfade when one AAC asset supplies three shifted audio clips', async () => {
    const source = path.join(dir, 'three-audio-branches.mp4');
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]', '-map', '[v]', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const store = EditorStore.create({ width: 320, height: 180, fps: 30 });
    const asset = addMediaAsset(store, await probeMedia(source));
    const video = store.project.timeline.tracks.find(track => track.kind === 'video')!, audio = store.project.timeline.tracks.find(track => track.kind === 'audio')!;
    const left = addClip(store, { trackId: video.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 1 });
    const right = addClip(store, { trackId: video.id, assetId: asset.id, start: 1, sourceIn: 2, duration: 1 });
    const audioLeft = addClip(store, { trackId: audio.id, assetId: asset.id, start: 0, sourceIn: 0, duration: 1 });
    const audioRight = addClip(store, { trackId: audio.id, assetId: asset.id, start: 1, sourceIn: 2, duration: 1 });
    addClip(store, { trackId: audio.id, assetId: asset.id, start: 2, sourceIn: 0, duration: 2 });
    addTransition(store, { leftClipId: left.id, rightClipId: right.id, type: 'dissolve', durationFrames: 12, alignment: 'center' });
    addTransition(store, { leftClipId: audioLeft.id, rightClipId: audioRight.id, type: 'audio_crossfade', durationFrames: 18, alignment: 'start' });
    const project: Project = { ...store.project, timeline: { ...store.project.timeline, tracks: store.project.timeline.tracks.map(track => ({ ...track, clips: [...track.clips].reverse() })) } };
    const results: Array<{ codec: string; inputCount?: number; audioChains?: string[]; duration?: number; measurements?: Array<{ time: number; left: number; right: number; left20ms: number; right20ms: number; rms20ms: number }>; error?: string }> = [];
    for (const codec of ['aac', 'pcm_s16le'] as const) {
      const output = path.join(dir, `three-clips-${codec}.${codec === 'aac' ? 'mp4' : 'mkv'}`);
      const result: typeof results[number] = { codec };
      try {
        await preflightTransitionStreams(project);
        const { args } = buildExportArgs(project, { outputPath: output, preset: 'ultrafast', crf: 20 });
        if (codec !== 'aac') { args[args.indexOf('-c:a') + 1] = codec; args.splice(args.indexOf('-b:a'), 2); }
        result.inputCount = args.filter(argument => argument === '-i').length;
        result.audioChains = args[args.indexOf('-filter_complex') + 1]!.split(';').filter(chain => /\[\d+:a\]/.test(chain));
        await runFfmpeg(args, 'Three audio clips regression');
        const { stdout: pcm } = await exec('ffmpeg', ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        const tone = (time: number, frequency: number, window = .1) => {
          const start = Math.round(time * 48000), count = Math.round(window * 48000);
          let real = 0, imaginary = 0, squares = 0;
          for (let i = 0; i < count; i++) { const sample = pcm.readFloatLE((start + i) * 4), phase = 2 * Math.PI * frequency * i / 48000; real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase); squares += sample * sample; }
          return { amplitude: 2 * Math.hypot(real, imaginary) / count, rms: Math.sqrt(squares / count) };
        };
        result.duration = pcm.length / 4 / 48000;
        result.measurements = [1.05, 1.3, 1.55, 2.3, 3.7].map(time => ({ time,
          left: tone(time, 440).amplitude, right: tone(time, 880).amplitude,
          left20ms: tone(time, 440, .02).amplitude, right20ms: tone(time, 880, .02).amplitude, rms20ms: tone(time, 440, .02).rms,
        }));
      } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
      results.push(result);
    }
    const evidence = `Same-asset three-clip crossfade matrix: ${JSON.stringify(results)}`;
    for (const result of results) {
      expect(result.error, evidence).toBeUndefined();
      expect(result.inputCount, evidence).toBe(4);
      expect(result.duration, evidence).toBeGreaterThanOrEqual(4); expect(result.duration, evidence).toBeLessThan(4.03);
      const [start, midpoint, end, tailLeft, tailRight] = result.measurements!;
      expect(start!.left, evidence).toBeGreaterThan(start!.right * 2);
      expect(midpoint!.left, evidence).toBeGreaterThan(.015); expect(midpoint!.right, evidence).toBeGreaterThan(.015);
      expect(end!.right, evidence).toBeGreaterThan(end!.left * 2);
      expect(tailLeft!.left, evidence).toBeGreaterThan(.1);
      expect(tailRight!.right, evidence).toBeGreaterThan(.1);
    }
  }, 60000);
});
