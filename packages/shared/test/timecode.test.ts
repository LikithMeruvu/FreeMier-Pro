import { describe, expect, it } from 'vitest';
import { frameTimecode, parseFrameTimecode } from '../src/timecode.js';
describe('non-drop frame timecode', () => {
  it('formats and reads integer-rate frame fields', () => {
    expect(frameTimecode(59 / 30, 30)).toBe('00:00:01:29');
    expect(parseFrameTimecode('00:00:01:29', 30)).toBe(59 / 30);
    expect(frameTimecode(1 / 120, 120)).toBe('00:00:00:01');
    expect(parseFrameTimecode('00:00:00:119', 120)).toBe(119 / 120);
  });
  it('uses total nominal frame counts for fractional-rate hours', () => {
    expect(parseFrameTimecode('01:00:00:00', 23.976)).toBe(86400 / 23.976);
    expect(frameTimecode(86400 / 23.976, 23.976)).toBe('01:00:00:00');
    expect(frameTimecode(60, 29.97)).toBe('00:00:59:28');
    expect(parseFrameTimecode('00:01:00:00', 29.97)).toBe(1800 / 29.97);
  });
  it('retains exact frame counts over representative fractional-rate boundaries', () => {
    for (const fps of [23.976, 29.97, 59.94]) for (const frame of [0, 1, 23, 1799, 1800, 86401, 1000000]) {
      expect(Math.round(parseFrameTimecode(frameTimecode(frame / fps, fps), fps) * fps)).toBe(frame);
    }
  });
  it('rejects out-of-range clock fields, malformed text and drop-frame separators', () => {
    for (const value of ['00:60:00:00', '00:00:60:00', '00:00:00:30', '-1:00:00:00', '00:00:00;00', ':::', '00:00:01.5:00']) expect(() => parseFrameTimecode(value, 30)).toThrow();
  });
  it('refuses invalid rates and nonfinite/negative seconds', () => {
    for (const fps of [0, -1, NaN, Infinity, 241]) expect(() => frameTimecode(0, fps)).toThrow();
    for (const time of [NaN, Infinity, -.01]) expect(() => frameTimecode(time, 30)).toThrow();
  });
});
