import { describe, it, expect } from 'vitest';
import { parseSrt, serializeSrt, formatSrtTime, MAX_SRT_CUES } from '../../src/captions/srt.js';
describe('plain SubRip interchange foundation', () => {
  it('reads BOM/CRLF, nonconsecutive indices, exact milliseconds and multiline Unicode', () => {
    const result = parseSrt('\uFEFF7\r\n00:00:00,501 --> 00:00:01,501\r\nRésumé Δ Ж\r\n100% %{pts} {\\an8} <b>literal</b>\r\n\r\n99\r\n01:02:03,004 --> 01:02:04,005\r\nNext\r\n');
    expect(result[0]).toEqual({ startMs: 501, endMs: 1501, text: 'Résumé Δ Ж\n100% %{pts} {\\an8} <b>literal</b>', sourceLine: 2 });
    expect(result[1]!.startMs).toBe(3723004); expect(result[1]!.endMs).toBe(3724005);
  });
  it('canonicalizes numbering and round-trips timing/text without quantizing onto frames', () => {
    const entries = [{ startMs: 1, endMs: 999, text: 'One\nTwo' }, { startMs: 86400000 - 1, endMs: 86400000, text: 'End' }];
    const output = serializeSrt(entries); expect(output).toContain('1\n00:00:00,001 --> 00:00:00,999'); expect(output).toContain('2\n23:59:59,999 --> 24:00:00,000');
    expect(parseSrt(output).map(({ sourceLine: _, ...cue }) => cue)).toEqual(entries); expect(serializeSrt([])).toBe(''); expect(parseSrt('\uFEFF\n')).toEqual([]);
  });
  it('preserves file order and overlap for an explicit subsequent track policy', () => {
    const entries = [{ startMs: 1000, endMs: 3000, text: 'Later first' }, { startMs: 0, endMs: 2000, text: 'Earlier second' }];
    expect(parseSrt(serializeSrt(entries)).map(({ sourceLine: _, ...cue }) => cue)).toEqual(entries);
  });
  it('reports source lines for malformed intervals and clock fields rather than returning partial cues', () => {
    for (const time of ['00:60:00,000', '00:00:60,000', '00:00:00.000', '00:00:00,00', '25:00:00,000']) {
      try { parseSrt('1\n00:00:00,000 --> 00:00:01,000\nValid\n\n9\n' + time + ' --> 26:00:00,000\nBad'); throw new Error('unexpected parse success'); } catch (error) { expect((error as { details: { line: number } }).details.line).toBe(6); }
    }
    for (const content of ['0\n00:00:00,000 --> 00:00:01,000\nText', '1\n00:00:01,000 --> 00:00:00,000\nText', '1\n00:00:00,000 --> 00:00:01,000', '1\n00:00:00,000 --> 00:00:01,000 X1:20\nText']) expect(() => parseSrt(content)).toThrow();
  });
  it('refuses unsafe times, control characters, blank separators and excessive input/counts', () => {
    for (const n of [NaN, Infinity, -.1, 1.5, 86400001]) expect(() => formatSrtTime(n)).toThrow();
    for (const text of ['One\n\nTwo', '\0', 'x'.repeat(4097)]) expect(() => serializeSrt([{ startMs: 0, endMs: 1000, text }])).toThrow();
    expect(() => parseSrt('x'.repeat(131073))).toThrow(); expect(() => serializeSrt(Array.from({ length: MAX_SRT_CUES + 1 }, () => ({ startMs: 0, endMs: 1000, text: 'Cue' })))).toThrow();
  });
});
