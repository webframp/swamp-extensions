// ABOUTME: OpenTelemetry span helpers for the PostgreSQL datastore. Depends on
// ABOUTME: @opentelemetry/api only — the host process owns the TracerProvider,
// ABOUTME: so every span here is a zero-cost no-op when none is registered.

import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from "npm:@opentelemetry/api@1.9.1";

/** Instrumentation scope name — matches the extension name in manifest.yaml. */
const TRACER_NAME = "@webframp/postgres-datastore";

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Span attribute keys.
 *
 * Never add a key here whose value could carry secret material. The connection
 * string embeds a password and query parameters can hold file content, so
 * neither is ever recorded — only operation names, table names, and counts.
 */
export const Attr = {
  DB_SYSTEM: "db.system.name",
  DB_OPERATION: "db.operation.name",
  DB_COLLECTION: "db.collection.name",
  DB_RETURNED_ROWS: "db.response.returned_rows",
  ERROR_TYPE: "error.type",
  LOCK_KEY: "lock.key",
  LOCK_TIMEOUT_MS: "lock.timeout_ms",
  LOCK_TTL_MS: "lock.ttl_ms",
  LOCK_WAIT_DURATION_MS: "lock.wait_duration_ms",
  LOCK_CONTENDED: "lock.contended",
  LOCK_HOLDER: "lock.holder",
  DATASTORE_FILE: "datastore.file",
  DATASTORE_FILES_PULLED: "datastore.files_pulled",
  DATASTORE_FILES_PUSHED: "datastore.files_pushed",
  DATASTORE_FILES_DELETED: "datastore.files_deleted",
  DATASTORE_FILES_PLANNED_PUSH: "datastore.files_planned_push",
  DATASTORE_FILES_PLANNED_DELETE: "datastore.files_planned_delete",
  DATASTORE_FAST_PATH_HIT: "datastore.fast_path_hit",
  DATASTORE_SCOPED: "datastore.scoped",
  DATASTORE_METADATA_ONLY: "datastore.metadata_only",
  DATASTORE_HYDRATED: "datastore.hydrated",
} as const;

/**
 * Runs `fn` inside an active span, recording failures on the way out.
 *
 * Error recording lives here rather than at each call site so no instrumented
 * operation can end up with a span that reports success after throwing.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return await getTracer().startActiveSpan(name, async (span) => {
    span.setAttributes(attrs);
    try {
      return await fn(span);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      span.setAttribute(Attr.ERROR_TYPE, error.name);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wraps a single SQL round trip.
 *
 * `op` is a hand-written label rather than the SQL text: statement text would
 * push structure into span names, and the parameters bound to it can contain
 * file content.
 */
export function sqlSpan<T>(
  op: string,
  dbOperation: string,
  table: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`PostgreSQL ${op}`, {
    [Attr.DB_SYSTEM]: "postgresql",
    [Attr.DB_OPERATION]: dbOperation,
    [Attr.DB_COLLECTION]: table,
  }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      // Decorate in place rather than wrapping in a new Error: callers and
      // tests rely on the original error's `name`/`code` (e.g. Postgres
      // error codes used for retry classification) surviving unchanged —
      // only the message gains the operation/table context that a bare
      // driver error (e.g. "relation does not exist") lacks.
      if (err instanceof Error) {
        err.message = `PostgreSQL ${op} on "${table}" failed: ${err.message}`;
      }
      throw err;
    }
  });
}

/**
 * Records a retry as an event on whichever span is currently active.
 *
 * Retry helpers sit below the span-creating layer, so they attach to the
 * enclosing operation's span instead of opening one of their own. No active
 * span means no event — the call is safe either way.
 */
export function recordRetry(
  attempt: number,
  delayMs: number,
  extra?: Attributes,
): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.addEvent("retry", {
    "retry.attempt": attempt,
    "retry.delay_ms": delayMs,
    ...extra,
  });
}
