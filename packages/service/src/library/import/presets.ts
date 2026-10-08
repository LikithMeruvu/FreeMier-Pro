import { EditorError, PRESET_MAX_BYTES } from '@freemier/shared';
import { promises as fs } from 'node:fs';

export async function readPresetSource(args: Record<string, unknown>): Promise<string> {
  if ((args.content === undefined) === (args.path === undefined)) throw new EditorError('INVALID_ARGUMENT', 'Supply exactly one of content or path');
  if (args.content !== undefined) return args.content as string;
  const file = args.path as string;
  try {
    const initial = await fs.stat(file);
    if (!initial.isFile() || initial.size > PRESET_MAX_BYTES) throw new EditorError('INVALID_ARGUMENT', 'Preset must be a regular file of at most 64 KiB');
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > PRESET_MAX_BYTES) throw new EditorError('INVALID_ARGUMENT', 'Preset must be a regular file of at most 64 KiB');
      const buffer = Buffer.alloc(PRESET_MAX_BYTES + 1); let size = 0;
      while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
      if (size > PRESET_MAX_BYTES) throw new EditorError('INVALID_ARGUMENT', 'Preset exceeds 64 KiB');
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw new EditorError('INVALID_ARGUMENT', 'Preset file must use valid UTF-8'); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof EditorError) throw error;
    throw new EditorError('IO_ERROR', 'Unable to read effect preset file');
  }
}
