import { randomUUID } from 'node:crypto';

/**
 * Deterministic-friendly ID generation.
 * Uses crypto.randomUUID for uniqueness without coordination.
 */

/** Generate a new opaque ID with a short type prefix for debuggability. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export const newProjectId = (): string => newId('prj');
export const newTimelineId = (): string => newId('tl');
export const newTrackId = (): string => newId('trk');
export const newClipId = (): string => newId('clp');
export const newMediaId = (): string => newId('med');
export const newEffectId = (): string => newId('eff');
