import type { Clip, ClipLink, Project, Timeline } from '@freemier/shared';
import { EditorError, newClipId } from '@freemier/shared';
import { addClip, findClip, type AddClipOptions } from '../clips/operations.js';
import { EditorStore } from '../project/store.js';
import { validateProject } from '../project/validation.js';
import { clipEnd, findFreeSlot, quantize } from '../timeline/queries.js';

export interface LinkedClipPair { link: ClipLink; videoClip: Clip; audioClip: Clip }
export type AddLinkedClipOptions = Omit<AddClipOptions, 'trackId'> & {
  videoTrackId: string; audioTrackId: string; strict?: boolean;
};

export function linkedPairFor(timeline: Timeline, clipId: string): ClipLink | null {
  return timeline.clipLinks?.find((link) => link.videoClipId === clipId || link.audioClipId === clipId) ?? null;
}

function pairResult(project: Project, link: ClipLink): LinkedClipPair {
  return { link, videoClip: findClip(project.timeline, link.videoClipId)!.clip, audioClip: findClip(project.timeline, link.audioClipId)!.clip };
}

export function assertPairEditable(store: EditorStore, link: ClipLink): void {
  for (const id of [link.videoClipId, link.audioClipId]) {
    const found = findClip(store.project.timeline, id);
    if (!found) throw new EditorError('NOT_FOUND', 'Linked clip not found', { clipId: id });
    if (found.track.locked) throw new EditorError('CONFLICT', 'Linked member track is locked', { trackId: found.track.id });
  }
}

export function assertLinkedDestination(store: EditorStore, link: ClipLink, clipId: string, trackId?: string): void {
  if (!trackId) return;
  const track = store.project.timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditorError('NOT_FOUND', 'Track not found', { trackId });
  if (track.kind !== (clipId === link.videoClipId ? 'video' : 'audio')) throw new EditorError('INVALID_ARGUMENT', 'Linked pair requires a destination track of the same media kind', { trackId, clipId });
}

/** Temporary engine state is never exposed; the owning store receives one validated snapshot. */
export function linkedTransaction<T>(store: EditorStore, ids: string[], edit: (stage: EditorStore, links: ClipLink[]) => T): T {
  const project = structuredClone(store.project), links = [...project.timeline.clipLinks ?? []];
  const { clipLinks: _links, ...timeline } = project.timeline;
  const stage = new EditorStore({ ...project, timeline });
  const result = edit(stage, links);
  const next: Project = { ...stage.project, timeline: { ...stage.project.timeline, clipLinks: links } };
  // Edits may ripple other groups. Refuse unsupported propagation before committing any member.
  for (const link of links) {
    const video = findClip(next.timeline, link.videoClipId)?.clip, audio = findClip(next.timeline, link.audioClipId)?.clip;
    if (video && audio && (['start', 'duration', 'sourceIn', 'sourceOut'] as const).some((key) => Math.abs(video[key] - audio[key]) > 1e-6)) {
      throw new EditorError('UNSUPPORTED', 'Ripple propagation must preserve aligned linked pairs on mirrored tracks', { linkId: link.id });
    }
  }
  validateProject(next);
  const touched = new Set(ids);
  for (const track of next.timeline.tracks) {
    const before = store.project.timeline.tracks.find((t) => t.id === track.id);
    if (JSON.stringify(before?.clips) !== JSON.stringify(track.clips)) {
      if (before?.locked) throw new EditorError('CONFLICT', 'Ripple affects a locked track', { trackId: track.id });
      touched.add(track.id);
      for (const clip of [...before?.clips ?? [], ...track.clips]) touched.add(clip.id);
    }
  }
  store.mutate('clip', [...touched], () => next);
  return result;
}

export function addLinkedClip(store: EditorStore, opts: AddLinkedClipOptions): LinkedClipPair {
  const videoTrack = store.project.timeline.tracks.find((t) => t.id === opts.videoTrackId);
  const audioTrack = store.project.timeline.tracks.find((t) => t.id === opts.audioTrackId);
  if (!videoTrack || !audioTrack) throw new EditorError('NOT_FOUND', 'Linked placement track not found');
  if (videoTrack.kind !== 'video' || audioTrack.kind !== 'audio') throw new EditorError('INVALID_ARGUMENT', 'Linked placement requires video and audio tracks');
  return linkedTransaction(store, [opts.videoTrackId, opts.audioTrackId], (stage, links) => {
    const fps = stage.project.timeline.fps;
    let start = quantize(opts.start ?? Math.max(...[videoTrack, audioTrack].map((t) => t.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0))), fps);
    // Obtain the actual frame-quantized length with the existing source/range checks.
    const probe = new EditorStore({ ...stage.project, timeline: { ...stage.project.timeline, tracks: stage.project.timeline.tracks.map((t) => ({ ...t, clips: [] })) } });
    const sample = addClip(probe, { ...opts, trackId: opts.videoTrackId, start, strict: true, ripple: false });
    if (!opts.strict && !opts.ripple) {
      for (;;) {
        const next = Math.max(findFreeSlot(videoTrack, start, sample.duration), findFreeSlot(audioTrack, start, sample.duration));
        if (Math.abs(next - start) < 1e-6) break;
        start = next;
      }
    }
    const videoClip = addClip(stage, { ...opts, trackId: opts.videoTrackId, start, strict: true });
    const audioClip = addClip(stage, { ...opts, trackId: opts.audioTrackId, start, strict: true });
    const link: ClipLink = { id: `lnk_${newClipId()}`, videoClipId: videoClip.id, audioClipId: audioClip.id };
    links.push(link);
    return { link, videoClip, audioClip };
  });
}

export function linkClips(store: EditorStore, videoClipId: string, audioClipId: string): LinkedClipPair {
  if (linkedPairFor(store.project.timeline, videoClipId) || linkedPairFor(store.project.timeline, audioClipId)) throw new EditorError('CONFLICT', 'Clip already belongs to a linked pair');
  const link: ClipLink = { id: `lnk_${newClipId()}`, videoClipId, audioClipId };
  assertPairEditable(store, link);
  validateProject({ ...store.project, timeline: { ...store.project.timeline, clipLinks: [...store.project.timeline.clipLinks ?? [], link] } });
  return linkedTransaction(store, [videoClipId, audioClipId], (stage, links) => { links.push(link); return pairResult(stage.project, link); });
}

export function unlinkClip(store: EditorStore, clipId: string): boolean {
  const link = linkedPairFor(store.project.timeline, clipId);
  if (!link) return false;
  assertPairEditable(store, link);
  return linkedTransaction(store, [link.videoClipId, link.audioClipId], (_stage, links) => { links.splice(links.findIndex((l) => l.id === link.id), 1); return true; });
}
