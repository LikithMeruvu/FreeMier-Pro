import { describe, expect, it } from 'vitest';
import type { Clip, MediaAsset, Timeline, Transition } from '../../src/project/types.js';
import { defaultTransform } from '../../src/project/types.js';
import { blendTransitionPixel, clipRenderWindow, resolveTransition, transitionProgress, transitionWeights, validateTransitions } from '../../src/calculations/transitions.js';

const media: readonly MediaAsset[] = [{ id: 'asset', path: '/source.mp4', copied: false, name: 'Source', kind: 'video',
  duration: 10, width: 640, height: 360, fps: 25, hasAudio: true, sampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', probedAt: 0 }];
function clip(id: string, start: number): Clip {
  return { id, assetId: 'asset', start, duration: 2, sourceIn: 1, sourceOut: 3, transform: defaultTransform(), effects: [], label: null, volume: 1 };
}
function timeline(): Timeline {
  return { id: 'timeline', name: 'Main', fps: 25, width: 640, height: 360,
    tracks: [{ id: 'track', name: 'V1', kind: 'video', clips: [clip('left', 0), clip('right', 2), clip('third', 4)], muted: false, locked: false, order: 0 }] };
}
function transition(overrides: Partial<Transition> = {}): Transition {
  return { id: 'transition', leftClipId: 'left', rightClipId: 'right', type: 'dissolve', durationFrames: 5, alignment: 'center', ...overrides };
}

describe('shared frame and source-window transition calculations', () => {
  it.each([
    ['center', 48, 53, 3.12, .92, -.08], ['start', 50, 55, 3.2, 1, 0], ['end', 45, 50, 3, .8, -.2],
  ] as const)('derives odd-frame %s alignment exactly without mutating clip timing', (alignment, startFrame, endFrame, leftOut, rightIn, localOffset) => {
    const sequence = timeline(), before = structuredClone(sequence);
    const resolved = resolveTransition(sequence, media, transition({ alignment }));
    expect(resolved).toMatchObject({ cutFrame: 50, startFrame, endFrame, durationFrames: 5, cut: 2, start: startFrame / 25, end: endFrame / 25 });
    expect(resolved.left).toBe(sequence.tracks[0]!.clips[0]); expect(resolved.right).toBe(sequence.tracks[0]!.clips[1]);
    expect(resolved.leftWindow).toEqual({ start: 0, end: endFrame / 25, sourceIn: 1, sourceOut: leftOut, localTimeOffset: 0 });
    expect(resolved.rightWindow).toEqual({ start: startFrame / 25, end: 4, sourceIn: rightIn, sourceOut: 3, localTimeOffset: localOffset });
    expect(sequence).toEqual(before);
    const sample = (resolved.start + resolved.end) / 2;
    expect(resolved.rightWindow.sourceIn + sample - resolved.rightWindow.start).toBeCloseTo(1 + sample - 2);
    expect(sample - resolved.rightWindow.start + resolved.rightWindow.localTimeOffset).toBeCloseTo(sample - 2);
  });
  it('uses fractional sequence fps without round-trip frame drift and complementary linear gains', () => {
    const fps = 30000 / 1001, sequence = timeline(), clips = [clip('left', 0), clip('right', 60 / fps)];
    const adjusted = clips.map((item) => ({ ...item, duration: 60 / fps, sourceIn: 30 / fps, sourceOut: 90 / fps }));
    const resolved = resolveTransition({ ...sequence, fps, tracks: [{ ...sequence.tracks[0]!, clips: adjusted }] }, [{ ...media[0]!, fps }], transition({ durationFrames: 7 }));
    expect(resolved).toMatchObject({ cutFrame: 60, startFrame: 57, endFrame: 64, durationFrames: 7 });
    expect(transitionWeights(resolved, resolved.start)).toEqual({ left: 1, right: 0 });
    expect(transitionWeights(resolved, resolved.end)).toEqual({ left: 0, right: 1 });
    expect(transitionProgress(resolved, resolved.start - 10)).toBe(0); expect(transitionProgress(resolved, resolved.end + 10)).toBe(1);
    expect(transitionProgress(resolved, (resolved.start + resolved.end) / 2)).toBeCloseTo(.5);
    expect(() => transitionProgress(resolved, NaN)).toThrow(/finite/);
  });
  it('merges incoming and outgoing source windows without extending sequence duration or rewriting legacy data', () => {
    const sequence = timeline();
    expect(clipRenderWindow(sequence, media, 'right')).toEqual({ start: 2, end: 4, sourceIn: 1, sourceOut: 3, localTimeOffset: 0 });
    expect(sequence.transitions).toBeUndefined();
    const extended: Timeline = { ...sequence, transitions: [transition({ durationFrames: 10 }), transition({ id: 'outgoing', leftClipId: 'right', rightClipId: 'third', durationFrames: 10 })] };
    expect(clipRenderWindow(extended, media, 'right')).toEqual({ start: 1.8, end: 4.2, sourceIn: .8, sourceOut: 3.2, localTimeOffset: expect.closeTo(-.2) });
    expect(extended.tracks[0]!.clips[2]!.start + extended.tracks[0]!.clips[2]!.duration).toBe(6);
    expect(() => clipRenderWindow(extended, media, 'absent')).toThrow(/not found/);
  });
  it('refuses insufficient real source handles, unordered/gapped endpoints and fractional clip geometry', () => {
    const sequence = timeline();
    for (const modify of [
      (p: any) => p.tracks[0].clips[1].sourceIn = 0,
      (p: any) => { p.tracks[0].clips[0].sourceIn = 8; p.tracks[0].clips[0].sourceOut = 10; },
      (p: any) => p.tracks[0].clips[1].start = 2.04,
      (p: any) => p.tracks[0].clips[1].start = 2.001,
      (p: any) => p.tracks[0].clips[1].sourceIn = 1.001,
    ]) { const invalid = structuredClone(sequence); modify(invalid); expect(() => resolveTransition(invalid, media, transition())).toThrow(); }
    expect(() => resolveTransition(sequence, media, transition({ leftClipId: 'right', rightClipId: 'left' }))).toThrow(/neighbors/);
    expect(() => resolveTransition(sequence, media, transition({ rightClipId: 'third' }))).toThrow(/neighbors/);
    expect(() => resolveTransition(sequence, media, transition({ durationFrames: 51 }))).toThrow(/duration exceeds/);
    expect(() => resolveTransition(sequence, [{ ...media[0]!, duration: 3.1 }], transition())).toThrow(/source handles/);
  });
  it('refuses overlapping intervals on one track and accepts coincident intervals on separate tracks', () => {
    const base = timeline(), sequence: Timeline = { ...base, tracks: base.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip, sourceIn: 2, sourceOut: 4 })) })) };
    const first = transition({ alignment: 'start', durationFrames: 50 });
    const second = transition({ id: 'second', leftClipId: 'right', rightClipId: 'third', alignment: 'end', durationFrames: 50 });
    expect(() => validateTransitions({ ...sequence, transitions: [first, second] }, media)).toThrow(/cannot overlap/);
    const otherTrack = { ...sequence.tracks[0]!, id: 'other', order: 1, clips: [clip('otherLeft', 0), clip('otherRight', 2)] };
    expect(validateTransitions({ ...sequence, tracks: [...sequence.tracks, otherTrack], transitions: [first,
      transition({ id: 'otherTransition', leftClipId: 'otherLeft', rightClipId: 'otherRight' })] }, media)).toHaveLength(2);
    // Centered maximal intervals meet at a half-open boundary and remain disjoint.
    expect(validateTransitions({ ...sequence, transitions: [{ ...first, alignment: 'center' }, { ...second, alignment: 'center' }] }, media)).toHaveLength(2);
  });
  it('mixes premultiplied RGB and alpha once, including unequal alpha and transparent colored endpoints', () => {
    expect(blendTransitionPixel([255, 0, 0, 255], [0, 0, 255, 255], .5)).toEqual([127.5, 0, 127.5, 255]);
    const pixel = blendTransitionPixel([255, 0, 0, 64], [0, 0, 255, 192], .5);
    expect(pixel).toEqual([63.75, 0, 191.25, 128]);
    expect(blendTransitionPixel([255, 0, 0, 0], [0, 255, 0, 0], .5)).toEqual([0, 0, 0, 0]);
    expect(blendTransitionPixel([255, 0, 0, 0], [0, 0, 255, 255], .5)).toEqual([0, 0, 255, 127.5]);
    expect(blendTransitionPixel([5, 10, 20, 100], [30, 40, 50, 200], 0)).toEqual([5, 10, 20, 100]);
    for (const progress of [-1, 2, NaN]) expect(() => blendTransitionPixel([0, 0, 0, 255], [0, 0, 0, 255], progress)).toThrow();
  });
  it('refuses mismatched video FPS while exempting images and independent audio from video sources', () => {
    const sequence = { ...timeline(), fps: 30 };
    expect(() => resolveTransition(sequence, media, transition())).toThrow(/Mixed frame-rate video dissolves are unsupported/);
    const images: readonly MediaAsset[] = [{ ...media[0]!, kind: 'image', fps: 0, hasAudio: false, sampleRate: null, audioCodec: null }];
    expect(resolveTransition(sequence, images, transition()).durationFrames).toBe(5);
    const audioSequence: Timeline = { ...sequence, tracks: sequence.tracks.map((track) => ({ ...track, kind: 'audio' })) };
    expect(resolveTransition(audioSequence, media, transition({ type: 'audio_crossfade' })).durationFrames).toBe(5);
  });
});
