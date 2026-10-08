/** Bounded undo/redo snapshots. The project store owns validation and events. */
export class SnapshotHistory<T> {
  #undo: T[] = [];
  #redo: T[] = [];

  constructor(private readonly limit = 200) { }

  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }

  record(before: T): void {
    this.#undo.push(before);
    if (this.#undo.length > this.limit) this.#undo.shift();
    this.#redo = [];
  }

  clear(): void { this.#undo = []; this.#redo = []; }

  undo(current: T): T | undefined {
    const previous = this.#undo.pop();
    if (previous !== undefined) this.#redo.push(current);
    return previous;
  }

  redo(current: T): T | undefined {
    const next = this.#redo.pop();
    if (next !== undefined) this.#undo.push(current);
    return next;
  }
}
