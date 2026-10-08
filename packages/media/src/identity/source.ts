import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EditorError } from '@freemier/shared';

export interface SourceIdentity { sha256: string; size: number }
export type AvailabilityStatus = 'available' | 'missing' | 'changed' | 'unverified' | 'inaccessible';
export interface AvailabilityObservation { status: AvailabilityStatus; path: string; identity?: SourceIdentity; reason?: string }
export interface CandidateOptions { maxDepth?: number; maxEntries?: number; maxHashBytes?: number }
export interface MediaCandidate { path: string; identity?: SourceIdentity; match: 'exact' | 'unverified' }
export interface CandidateResult { candidates: MediaCandidate[]; truncated: boolean; visitedEntries: number; hashedBytes: number }

const MAX_ROOTS = 8, MAX_DEPTH = 8, MAX_ENTRIES = 2000, MAX_HASH_BYTES = 1024 ** 3, MAX_CANDIDATES = 64;

function ioError(message: string, file: string, cause: unknown): EditorError {
  return new EditorError('IO_ERROR', message, { path: file, cause: cause instanceof Error ? cause.message : String(cause) });
}
function sameStat(a: Awaited<ReturnType<typeof stat>>, b: Awaited<ReturnType<typeof stat>>): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
}

/** Streams a stable file into SHA-256 and refuses files that change while read. */
async function hashSource(file: string, maxBytes = Number.MAX_SAFE_INTEGER, noFollow = false): Promise<SourceIdentity> {
  let before: Awaited<ReturnType<typeof stat>>;
  try { before = await stat(file); } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
    throw ioError(missing ? 'Media file not found' : 'Cannot read media source', file, error);
  }
  if (!before.isFile()) throw new EditorError('INVALID_ARGUMENT', 'Media source must be a regular file', { path: file });
  const hash = createHash('sha256');
  let count = 0;
  let handle;
  try {
    const flags = noFollow ? fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) : 'r';
    handle = await open(file, flags);
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: Math.max(1, Math.min(64 * 1024, maxBytes)) })) {
      if (chunk.length > maxBytes - count) throw new EditorError('INVALID_ARGUMENT', 'Media source exceeds the permitted hash budget', { path: file, maxBytes });
      hash.update(chunk); count += chunk.length;
    }
  } catch (error) { if (error instanceof EditorError) throw error; throw ioError('Cannot hash media source', file, error); }
  finally { await handle?.close().catch(() => undefined); }
  let after: Awaited<ReturnType<typeof stat>>;
  try { after = await stat(file); } catch (error) { throw ioError('Media source changed while hashing', file, error); }
  if (!sameStat(before, after) || count !== before.size) throw new EditorError('CONFLICT', 'Media source changed while hashing', { path: file });
  return { sha256: hash.digest('hex'), size: count };
}

export function hashMediaSource(file: string): Promise<SourceIdentity> { return hashSource(file); }

/** Read-only location observation. Hash verification is opt-in. */
export async function inspectMediaSource(file: string, expected?: SourceIdentity, verify = false): Promise<AvailabilityObservation> {
  let info;
  try { info = await stat(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible', path: file, reason: code ?? String(error) };
  }
  if (!info.isFile()) return { status: 'inaccessible', path: file, reason: 'Not a regular file' };
  if (!expected) return { status: 'unverified', path: file };
  if (info.size !== expected.size) return { status: 'changed', path: file, reason: 'File size differs from saved identity' };
  if (!verify) return { status: 'unverified', path: file, reason: 'Size matches; content hash was not checked' };
  try {
    const identity = await hashMediaSource(file);
    return identity.sha256 === expected.sha256 && identity.size === expected.size
      ? { status: 'available', path: file, identity }
      : { status: 'changed', path: file, identity, reason: 'Content differs from saved identity' };
  } catch (error) {
    return { status: error instanceof EditorError && error.code === 'CONFLICT' ? 'changed' : 'inaccessible', path: file, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Searches only explicit roots. Exact candidates require a saved SHA-256 identity. */
export async function findMediaCandidates(expected: SourceIdentity | undefined, roots: string[], opts: CandidateOptions = {}): Promise<CandidateResult> {
  if (!expected) throw new EditorError('UNSUPPORTED', 'Candidate search requires a saved source identity; legacy media must be located explicitly and accepted as unverified');
  if (!Array.isArray(roots) || roots.length > MAX_ROOTS) throw new EditorError('INVALID_ARGUMENT', `At most ${MAX_ROOTS} explicit search roots are allowed`);
  const maxDepth = opts.maxDepth ?? 3, maxEntries = opts.maxEntries ?? 500, maxHashBytes = opts.maxHashBytes ?? 128 * 1024 ** 2;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_DEPTH || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES || !Number.isSafeInteger(maxHashBytes) || maxHashBytes < 0 || maxHashBytes > MAX_HASH_BYTES)
    throw new EditorError('INVALID_ARGUMENT', 'Search limits exceed supported bounds', { maxDepth, maxEntries, maxHashBytes });
  const result: CandidateResult = { candidates: [], truncated: false, visitedEntries: 0, hashedBytes: 0 };
  const visitedDirs = new Set<string>();
  const walk = async (dir: string, depth: number, rootCanonical: string): Promise<void> => {
    let directory;
    try {
      const ls = await lstat(dir);
      if (!ls.isDirectory() || ls.isSymbolicLink()) return;
      const canonical = await realpath(dir);
      const relativeDir = path.relative(rootCanonical, canonical);
      if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) return;
      if (visitedDirs.has(canonical)) return;
      visitedDirs.add(canonical);
      directory = await opendir(dir);
    } catch { return; }
    try {
      const iterator = directory[Symbol.asyncIterator]();
      while (result.visitedEntries < maxEntries) {
        const next = await iterator.next();
        if (next.done) break;
        const entry = next.value;
        result.visitedEntries++;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth) await walk(full, depth + 1, rootCanonical);
          else result.truncated = true;
        } else if (entry.isFile()) {
          let size: number;
          try {
            const details = await lstat(full);
            if (!details.isFile() || details.isSymbolicLink()) continue;
            const canonical = await realpath(full), relativeFile = path.relative(rootCanonical, canonical);
            if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) continue;
            size = details.size;
          } catch { continue; }
          if (size !== expected.size) continue;
          if (size > maxHashBytes - result.hashedBytes) { result.truncated = true; continue; }
          result.hashedBytes += size;
          let identity: SourceIdentity;
          try { identity = await hashSource(full, size, true); } catch (error) {
            if (error instanceof EditorError && error.code === 'INVALID_ARGUMENT') result.truncated = true;
            continue;
          }
          if (identity.sha256 === expected.sha256 && result.candidates.length < MAX_CANDIDATES) result.candidates.push({ path: full, identity, match: 'exact' });
          else if (identity.sha256 === expected.sha256) result.truncated = true;
        }
      }
      if (result.visitedEntries >= maxEntries) result.truncated = true;
    } finally { await directory.close().catch(() => undefined); }
  };
  for (const root of roots) {
    if (result.visitedEntries >= maxEntries) { result.truncated = true; break; }
    // lstat before realpath prevents a symlink root from expanding the search.
    try {
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      await walk(root, 0, await realpath(root));
    } catch { continue; }
  }
  result.candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}
