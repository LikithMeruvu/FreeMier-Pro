import type { ResolvedTransition, Transition } from '@freemier/shared';
import { EditorError, newId, resolveTransition, validateTransitions } from '@freemier/shared';
import type { EditorStore } from '../project/store.js';

export interface AddTransitionOptions {
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly type: Transition['type'];
  readonly durationFrames: number;
  readonly alignment?: Transition['alignment'];
}
export interface UpdateTransitionOptions {
  readonly durationFrames?: number;
  readonly alignment?: Transition['alignment'];
}
export interface TransitionQueryOptions { readonly trackId?: string; readonly clipId?: string }

function options(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field)))
    throw new EditorError('INVALID_ARGUMENT', 'Unknown or malformed transition options');
}
function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw new EditorError('INVALID_ARGUMENT', 'Expected a valid transition or endpoint ID');
}
function requireTransition(store: EditorStore, transitionId: string): Transition {
  assertId(transitionId);
  const transition = store.project.timeline.transitions?.find((entry) => entry.id === transitionId);
  if (!transition) throw new EditorError('NOT_FOUND', 'Transition not found', { transitionId });
  return transition;
}
function assertEditable(store: EditorStore, resolved: ResolvedTransition): void {
  const timeline = store.project.timeline, clipIds = new Set([resolved.left.id, resolved.right.id]);
  for (const pair of timeline.clipLinks ?? []) if (clipIds.has(pair.videoClipId) || clipIds.has(pair.audioClipId)) {
    clipIds.add(pair.videoClipId); clipIds.add(pair.audioClipId);
  }
  for (const track of timeline.tracks) if (track.locked && track.clips.some((clip) => clipIds.has(clip.id)))
    throw new EditorError('CONFLICT', 'Unlock the transition endpoint and linked partner tracks before editing', { trackId: track.id });
}

/** One owning-store mutation, preserving both endpoint clips and the sequence cut. */
export function addTransition(store: EditorStore, opts: AddTransitionOptions): Transition {
  options(opts, ['leftClipId', 'rightClipId', 'type', 'durationFrames', 'alignment']);
  const transition: Transition = { id: newId('trs'), leftClipId: opts.leftClipId, rightClipId: opts.rightClipId,
    type: opts.type, durationFrames: opts.durationFrames, alignment: opts.alignment === undefined ? 'center' : opts.alignment };
  assertEditable(store, resolveTransition(store.project.timeline, store.project.media, transition));
  store.mutate('timeline', [transition.id, transition.leftClipId, transition.rightClipId], (project) => ({ ...project,
    timeline: { ...project.timeline, transitions: [...project.timeline.transitions ?? [], transition] },
  }));
  return transition;
}

export function updateTransition(store: EditorStore, transitionId: string, opts: UpdateTransitionOptions): Transition {
  options(opts, ['durationFrames', 'alignment']);
  const before = requireTransition(store, transitionId), updated: Transition = { ...before,
    ...(opts.durationFrames === undefined ? {} : { durationFrames: opts.durationFrames }),
    ...(opts.alignment === undefined ? {} : { alignment: opts.alignment }),
  };
  assertEditable(store, resolveTransition(store.project.timeline, store.project.media, updated));
  if (updated.durationFrames === before.durationFrames && updated.alignment === before.alignment) return before;
  store.mutate('timeline', [transitionId, before.leftClipId, before.rightClipId], (project) => ({ ...project,
    timeline: { ...project.timeline, transitions: project.timeline.transitions!.map((entry) => entry.id === transitionId ? updated : entry) },
  }));
  return updated;
}

export function removeTransition(store: EditorStore, transitionId: string): boolean {
  const transition = requireTransition(store, transitionId);
  assertEditable(store, resolveTransition(store.project.timeline, store.project.media, transition));
  store.mutate('timeline', [transitionId, transition.leftClipId, transition.rightClipId], (project) => ({ ...project,
    timeline: { ...project.timeline, transitions: project.timeline.transitions!.filter((entry) => entry.id !== transitionId) },
  }));
  return true;
}

export function queryTransitions(store: EditorStore, opts: TransitionQueryOptions = {}): readonly ResolvedTransition[] {
  options(opts, ['trackId', 'clipId']);
  if (opts.trackId !== undefined) {
    assertId(opts.trackId);
    if (!store.project.timeline.tracks.some((track) => track.id === opts.trackId)) throw new EditorError('NOT_FOUND', 'Track not found', { trackId: opts.trackId });
  }
  if (opts.clipId !== undefined) {
    assertId(opts.clipId);
    if (!store.project.timeline.tracks.some((track) => track.clips.some((clip) => clip.id === opts.clipId))) throw new EditorError('NOT_FOUND', 'Clip not found', { clipId: opts.clipId });
  }
  return validateTransitions(store.project.timeline, store.project.media).filter((entry) =>
    (opts.trackId === undefined || entry.trackId === opts.trackId)
    && (opts.clipId === undefined || entry.left.id === opts.clipId || entry.right.id === opts.clipId));
}
