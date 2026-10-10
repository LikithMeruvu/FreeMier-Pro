import type { Clip, Project, Timeline, Track } from '@freemier/shared';
import { newProjectId, newTimelineId } from '@freemier/shared';
import { SnapshotHistory } from '../history/snapshots.js';
import { validateProject } from './validation.js';

/** The immutable state a store holds. */
export interface EditorState {
  readonly project: Project;
  readonly revision: number;
}

/** What changed in a mutation — the GUI uses this to update precisely. */
export interface ChangeEvent {
  readonly revision: number;
  /** Coarse category so consumers can filter. */
  readonly kind:
  | 'project'
  | 'media'
  | 'timeline'
  | 'clip'
  | 'track'
  | 'selection'
  | 'undo'
  | 'redo';
  /** IDs touched by the change, when applicable. */
  readonly ids: readonly string[];
  /** The full new state — consumers may diff or replace wholesale. */
  readonly state: EditorState;
}

export type ChangeListener = (event: ChangeEvent) => void;

/** Options for creating an empty project. */
export interface CreateProjectOptions {
  name?: string;
  fps?: number;
  width?: number;
  height?: number;
}

/** Build a fresh empty project with one video and one audio track. */
export function createEmptyProject(opts: CreateProjectOptions = {}): Project {
  const fps = opts.fps ?? 30;
  const now = Date.now();

  const videoTrack: Track = {
    id: 'trk_video_1',
    kind: 'video',
    name: 'V1',
    clips: [],
    muted: false,
    locked: false,
    order: 1,
  };
  const audioTrack: Track = {
    id: 'trk_audio_1',
    kind: 'audio',
    name: 'A1',
    clips: [],
    muted: false,
    locked: false,
    order: 0,
  };

  const timeline: Timeline = {
    id: newTimelineId(),
    name: 'Main',
    fps,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    tracks: [audioTrack, videoTrack],
  };

  return validateProject({
    id: newProjectId(),
    name: opts.name ?? 'Untitled Project',
    version: 1,
    timeline,
    media: [],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Holds the authoritative editor state.
 *
 * Contract:
 *  - State is immutable; every mutation produces a new snapshot.
 *  - Every mutation bumps `revision` and emits exactly one ChangeEvent.
 *  - Undo restores the exact prior snapshot (deep-equal, not recomputed).
 *  - There is exactly one store per project — the single source of truth
 *    shared by the MCP server and the GUI.
 */
export class EditorStore {
  #state: EditorState;
  #history: SnapshotHistory<EditorState>;
  #listeners = new Set<ChangeListener>();
  #loadGeneration = 0;

  constructor(project: Project, maxUndo = 200) {
    this.#state = { project: validateProject(project), revision: 0 };
    this.#history = new SnapshotHistory(maxUndo);
  }

  static create(opts: CreateProjectOptions = {}): EditorStore {
    return new EditorStore(createEmptyProject(opts));
  }

  get state(): EditorState {
    return this.#state;
  }

  get project(): Project {
    return this.#state.project;
  }

  get revision(): number {
    return this.#state.revision;
  }

  /** Monotonic signal for successful document replacements; undo never rewinds it. */
  get loadGeneration(): number {
    return this.#loadGeneration;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Apply a mutation. The updater receives the current project and returns a
   * new one. The old snapshot is pushed onto the undo stack.
   */
  mutate<T>(
    kind: ChangeEvent['kind'],
    ids: readonly string[],
    updater: (project: Project) => Project,
  ): T | void {
    const before = this.#state;
    const nextProject = updater(before.project);

    // No-op mutations must not pollute the undo stack.
    if (nextProject === before.project) return;

    // Refusal precedes history changes and notifications for every engine caller.
    validateProject(nextProject);

    this.#history.record(before);

    this.#state = {
      project: { ...nextProject, updatedAt: Date.now() },
      revision: before.revision + 1,
    };
    this.#emit({ revision: this.#state.revision, kind, ids, state: this.#state });
  }

  /** Replace the entire project. Clears both stacks. */
  load(project: Project): void {
    validateProject(project);
    this.#history.clear();
    this.#state = { project, revision: this.#state.revision + 1 };
    this.#loadGeneration += 1;
    this.#emit({ revision: this.#state.revision, kind: 'project', ids: [project.id], state: this.#state });
  }

  undo(): boolean {
    const prev = this.#history.undo(this.#state);
    if (!prev) return false;
    this.#state = prev;
    this.#emit({ revision: this.#state.revision, kind: 'undo', ids: [], state: this.#state });
    return true;
  }

  redo(): boolean {
    const next = this.#history.redo(this.#state);
    if (!next) return false;
    this.#state = next;
    this.#emit({ revision: this.#state.revision, kind: 'redo', ids: [], state: this.#state });
    return true;
  }

  #emit(event: ChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A faulty listener must never break a mutation.
      }
    }
  }
}

/** Convenience: replace one track in a timeline, returning a new timeline. */
export function withTrack(timeline: Timeline, track: Track): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => (t.id === track.id ? track : t)),
  };
}

/** Convenience: replace one track's clips, returning a new timeline. */
export function withClips(timeline: Timeline, trackId: string, clips: readonly Clip[]): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => (t.id === trackId ? { ...t, clips } : t)),
  };
}
