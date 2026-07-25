// ABOUTME: OpenTelemetry span helpers for the Valkey datastore. Depends on
// ABOUTME: @opentelemetry/api only — the host process owns the TracerProvider,
// ABOUTME: so every span here is a zero-cost no-op when none is registered.

import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from "npm:@opentelemetry/api@1.9.0";

/** Instrumentation scope name — matches the extension name in manifest.yaml. */
const TRACER_NAME = "@webframp/valkey-datastore";

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Span attribute keys.
 *
 * Never add a key here whose value could carry secret material. The connection
 * URL embeds a password and blob values are file content, so neither is ever
 * recorded — only command names, key names, and counts.
 */
export const Attr = {
  DB_SYSTEM: "db.system.name",
  DB_OPERATION: "db.operation.name",
  VALKEY_KEY: "valkey.key",
  VALKEY_PIPELINE_COMMANDS: "valkey.pipeline.commands",
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
  DATASTORE_PATHS: "datastore.paths",
  DATASTORE_TRUNCATED: "datastore.truncated",
  DATASTORE_SEQ: "datastore.seq",
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
 * Wraps a single Valkey round trip.
 *
 * ioredis exposes one method per command plus a pipeline builder, so there is
 * no single function every request passes through. Rather than wrap all
 * seventeen call sites, spans are placed on the round trips that carry latency:
 * the index range scans, the blob reads, and the pipeline flushes.
 */
export function commandSpan<T>(
  operation: string,
  key: string | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`Valkey ${operation}`, {
    [Attr.DB_SYSTEM]: "valkey",
    [Attr.DB_OPERATION]: operation,
    ...(key ? { [Attr.VALKEY_KEY]: key } : {}),
  }, fn);
}

/**
 * Wraps a pipeline flush, recording how many commands it batched.
 *
 * One span per flush rather than one per queued command: a push of a thousand
 * files batches three thousand commands, and a span each would bury the trace.
 */
export function pipelineSpan<T>(
  label: string,
  commandCount: number,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`Valkey pipeline ${label}`, {
    [Attr.DB_SYSTEM]: "valkey",
    [Attr.DB_OPERATION]: "PIPELINE",
    [Attr.VALKEY_PIPELINE_COMMANDS]: commandCount,
  }, fn);
}

/**
 * Records a retry as an event on whichever span is currently active.
 *
 * The lock's contention loop sits below the span-creating layer, so it attaches
 * to the enclosing operation's span instead of opening one of its own. No
 * active span means no event — the call is safe either way.
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
