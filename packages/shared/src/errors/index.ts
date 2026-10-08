/**
 * Structured errors.
 *
 * Every error that can cross a process or MCP boundary must be serializable.
 * Tool consumers get {code, message, details} — never a raw stack trace.
 */

export type EditorErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'CONFLICT'
  | 'OVERLAP'
  | 'UNSUPPORTED'
  | 'IO_ERROR'
  | 'PROBE_ERROR'
  | 'EXPORT_ERROR'
  | 'INTERNAL';

export interface SerializedEditorError {
  readonly code: EditorErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base error carrying a stable machine-readable code. */
export class EditorError extends Error {
  readonly code: EditorErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: EditorErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedEditorError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const notFound = (what: string, id: string): EditorError =>
  new EditorError('NOT_FOUND', `${what} not found: ${id}`, { what, id });

export const invalidArgument = (message: string, details: Record<string, unknown> = {}): EditorError =>
  new EditorError('INVALID_ARGUMENT', message, details);

export const overlap = (message: string, details: Record<string, unknown> = {}): EditorError =>
  new EditorError('OVERLAP', message, details);

/** Normalize any thrown value into a serializable error. Never leaks a stack. */
export function serializeError(err: unknown): SerializedEditorError {
  if (err instanceof EditorError) return err.toJSON();
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message };
  return { code: 'INTERNAL', message: String(err) };
}
