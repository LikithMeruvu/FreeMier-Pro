import { createHash, randomUUID } from 'node:crypto';
import type { Project } from '@freemier/shared';
import { EditorError } from '@freemier/shared';
import type { ChangeEvent, EditorStore } from '../project/store.js';

export interface ProtectionSnapshot {
  readonly epoch: string;
  readonly generation: number;
  readonly token: string;
  readonly dirty: boolean;
  readonly savedTo?: string;
}

export interface SaveReceipt {
  readonly project: Project;
  readonly digest: string;
  readonly documentEpoch: string;
  readonly token: string;
}

export type ProtectionListener = (snapshot: ProtectionSnapshot) => void;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

/** SHA-256 of canonical project content, excluding the volatile updatedAt timestamp. */
export function projectContentDigest(project: Project): string {
  const stable = { ...project, updatedAt: undefined };
  return createHash('sha256').update(JSON.stringify(stableValue(stable))).digest('hex');
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

export class ProjectProtectionTracker {
  readonly #store: EditorStore;
  #epoch = randomUUID();
  #generation = 0;
  #loadGeneration: number;
  #baselineDigest: string;
  #savedTo: string | undefined;
  #forceDirty = false;
  #snapshot: ProtectionSnapshot;
  #listeners = new Set<ProtectionListener>();
  #unsubscribe: () => void;
  #disposed = false;

  constructor(store: EditorStore) {
    this.#store = store;
    this.#loadGeneration = store.loadGeneration;
    this.#baselineDigest = projectContentDigest(store.project);
    this.#snapshot = this.#makeSnapshot();
    this.#unsubscribe = store.subscribe((event) => this.#onStoreChange(event));
  }

  snapshot(): ProtectionSnapshot { return this.#snapshot; }

  subscribe(listener: ProtectionListener): () => void {
    if (this.#disposed) throw new EditorError('CONFLICT', 'Project protection tracker is disposed');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  captureSave(): SaveReceipt {
    const project = freezeDeep(structuredClone(this.#store.project));
    return Object.freeze({ project, digest: projectContentDigest(project), documentEpoch: this.#epoch, token: this.#snapshot.token });
  }

  acknowledgeSave(receipt: SaveReceipt, savedTo: string): ProtectionSnapshot {
    if (this.#disposed || !receipt || receipt.documentEpoch !== this.#epoch) return this.#snapshot;
    if (typeof savedTo !== 'string' || !savedTo.trim()) throw new EditorError('INVALID_ARGUMENT', 'Saved project path must be nonempty');
    this.#baselineDigest = receipt.digest;
    this.#savedTo = savedTo;
    this.#forceDirty = false;
    return this.#publish();
  }

  markLoaded(savedTo?: string): ProtectionSnapshot {
    if (savedTo !== undefined && (typeof savedTo !== 'string' || !savedTo.trim())) throw new EditorError('INVALID_ARGUMENT', 'Saved project path must be nonempty');
    this.#epoch = randomUUID();
    this.#generation += 1;
    this.#loadGeneration = this.#store.loadGeneration;
    this.#baselineDigest = projectContentDigest(this.#store.project);
    this.#savedTo = savedTo;
    this.#forceDirty = false;
    return this.#publish();
  }

  markRecovered(): ProtectionSnapshot {
    this.#epoch = randomUUID();
    this.#generation += 1;
    this.#baselineDigest = projectContentDigest(this.#store.project);
    this.#savedTo = undefined;
    this.#forceDirty = true;
    return this.#publish();
  }

  assertReplacement(expectedToken: string, discardUnsaved = false): void {
    if (typeof expectedToken !== 'string' || expectedToken !== this.#snapshot.token) {
      throw new EditorError('CONFLICT', 'Project changed before replacement', { expectedToken, currentToken: this.#snapshot.token });
    }
    if (this.#snapshot.dirty && discardUnsaved !== true) {
      throw new EditorError('CONFLICT', 'Project has unsaved changes', { token: this.#snapshot.token });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #onStoreChange(_event: ChangeEvent): void {
    const loaded = this.#store.loadGeneration !== this.#loadGeneration;
    this.#loadGeneration = this.#store.loadGeneration;
    this.#generation += 1;
    if (loaded) {
      this.#epoch = randomUUID();
      this.#baselineDigest = projectContentDigest(this.#store.project);
      this.#savedTo = undefined;
      this.#forceDirty = false;
    }
    this.#publish();
  }

  #makeSnapshot(): ProtectionSnapshot {
    const snapshot: { epoch: string; generation: number; token: string; dirty: boolean; savedTo?: string } = {
      epoch: this.#epoch,
      generation: this.#generation,
      token: `${this.#epoch}:${this.#generation}`,
      dirty: this.#forceDirty || projectContentDigest(this.#store.project) !== this.#baselineDigest,
    };
    if (this.#savedTo !== undefined) snapshot.savedTo = this.#savedTo;
    return Object.freeze(snapshot);
  }

  #publish(): ProtectionSnapshot {
    this.#snapshot = this.#makeSnapshot();
    for (const listener of this.#listeners) {
      try { listener(this.#snapshot); } catch { /* A faulty listener cannot interrupt store changes. */ }
    }
    return this.#snapshot;
  }
}
