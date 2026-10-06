import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EditorError, validateText, validateTextStyle, TEXT_FONT_HASH, textRasterPayload, type CaptionCue, type TextStyle, type TitleOverlay } from '@freemier/shared';
import { runFfmpeg } from './run.js';
// Electron's CJS bundle maps import.meta.dirname to __dirname and copies fonts
// inside dist. Source/ESM packages retain their sibling font directory.
const fontCandidates = [path.join(import.meta.dirname, 'fonts', 'NotoSans-Regular.ttf'), path.join(import.meta.dirname, '..', 'fonts', 'NotoSans-Regular.ttf')];
export const FONT_HASH = TEXT_FONT_HASH;
async function fontBytes(): Promise<Buffer> {
  let bytes: Buffer | undefined;
  for (const candidate of fontCandidates) { try { bytes = await fs.readFile(candidate); break; } catch { /* next package-relative location */ } }
  if (!bytes) throw new EditorError('IO_ERROR', 'Bundled title font missing; reinstall the application');
  if (createHash('sha256').update(bytes).digest('hex') !== FONT_HASH) throw new EditorError('IO_ERROR', 'Bundled title font checksum mismatch');
  return bytes;
}
export async function fontList() {
  await fontBytes();
  return [{ id: 'noto-sans', name: 'Noto Sans Regular', license: 'OFL-1.1', sha256: FONT_HASH, bundled: true, coverage: 'Latin, Greek, Cyrillic; other scripts/emoji are not guaranteed' }];
}
export interface TextLayer { readonly file: string; readonly start: number; readonly end: number }
export function textRasterKey(text: string, style: TextStyle, width: number, height: number): string {
  return createHash('sha256').update(textRasterPayload(text, style, width, height)).digest('hex');
}
const inflight = new Map<string, Promise<string>>();
let rasterQueue: Promise<unknown> = Promise.resolve();
/** Canonical RGBA glyph pixels shared by browser preview and CPU export. */
export async function rasterText(text: string, style: TextStyle, width: number, height: number, cacheDirectory: string): Promise<string> {
  const key = path.resolve(cacheDirectory) + ':' + textRasterKey(text, style, width, height);
  if (inflight.has(key)) return inflight.get(key)!;
  const pending = rasterQueue.then(() => renderText(text, style, width, height, cacheDirectory));
  rasterQueue = pending.catch(() => {}); inflight.set(key, pending);
  try { return await pending; } finally { inflight.delete(key); }
}
async function renderText(text: string, style: TextStyle, width: number, height: number, cacheDirectory: string): Promise<string> {
  validateText(text); validateTextStyle(style);
  if (![width, height].every((n) => Number.isInteger(n) && n >= 2 && n <= 8192) || width * height > 33_554_432) throw new EditorError('INVALID_ARGUMENT', 'Text raster dimensions exceed supported bounds');
  const key = textRasterKey(text, style, width, height), directory = path.resolve(cacheDirectory), target = path.join(directory, `${key}.png`);
  await fontList(); await fs.mkdir(directory, { recursive: true });
  try { if ((await fs.stat(target)).size > 0) return target; } catch { /* uncached */ }
  const temporary = await fs.mkdtemp(path.join(directory, 'render-'));
  try {
    // Relative, generated names avoid *both* layers of FFmpeg filter path escaping.
    // User text is only UTF-8 file content, with expression expansion disabled.
    await fs.writeFile(path.join(temporary, 'font.ttf'), await fontBytes()); await fs.writeFile(path.join(temporary, 'text.txt'), text, 'utf8');
    const hx = { left: 0, center: .5, right: 1 }[style.align], vy = { top: 0, middle: .5, bottom: 1 }[style.verticalAlign];
    const color = (hex: string) => '0x' + hex.slice(1);
    const filter = `color=c=black@0:s=${width}x${height}:r=1,format=rgba,drawtext=fontfile=font.ttf:textfile=text.txt:expansion=none:fontsize=${style.fontSize}:fontcolor=${color(style.color)}:borderw=${style.outlineWidth}:bordercolor=${color(style.outlineColor)}:box=${style.backgroundOpacity > 0 ? 1 : 0}:boxcolor=${color(style.backgroundColor)}@${style.backgroundOpacity}:boxborderw=${style.padding}:line_spacing=${style.lineSpacing}:x=w*${style.x}-text_w*${hx}:y=h*${style.y}-text_h*${vy}${style.opacity < 1 ? ',colorchannelmixer=aa=' + style.opacity : ''}`;
    await runFfmpeg(['-y', '-hide_banner', '-nostdin', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-pix_fmt', 'rgba', '-loglevel', 'error', 'layer.png'], 'title raster', { cwd: temporary });
    await fs.rename(path.join(temporary, 'layer.png'), target);
    return target;
  } finally {
    if (!path.resolve(temporary).startsWith(directory + path.sep)) throw new EditorError('INTERNAL', 'Unsafe text cache cleanup');
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
export async function prepareTitleLayers(titles: readonly TitleOverlay[], width: number, height: number, cacheDirectory: string): Promise<TextLayer[]> {
  const layers: TextLayer[] = [];
  // Bounded native process concurrency avoids starving media playback.
  for (const title of titles) layers.push({ file: await rasterText(title.text, title.style, width, height, cacheDirectory), start: title.start, end: title.end });
  return layers;
}
export async function prepareCaptionLayers(cues: readonly CaptionCue[], style: TextStyle, width: number, height: number, cacheDirectory: string): Promise<TextLayer[]> {
  const layers: TextLayer[] = [];
  for (const cue of cues) layers.push({ file: await rasterText(cue.text, style, width, height, cacheDirectory), start: cue.startMs / 1000, end: cue.endMs / 1000 });
  return layers;
}
