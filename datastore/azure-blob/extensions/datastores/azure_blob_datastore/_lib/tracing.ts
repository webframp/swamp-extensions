// ABOUTME: OpenTelemetry span helpers for the Azure Blob datastore. Depends on
// ABOUTME: @opentelemetry/api only — the host process owns the TracerProvider,
// ABOUTME: so every span here is a zero-cost no-op when none is registered.

import {
  type Attributes,
  type Span,
  SpanStatusCode,
  trace,
} from "npm:@opentelemetry/api@1.9.0";

/** Instrumentation scope name — matches the extension name in manifest.yaml. */
const TRACER_NAME = "@webframp/azure-blob-datastore";

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Span attribute keys.
 *
 * Never add a key here whose value could carry secret material. Azure Shared
 * Key signatures, AAD client secrets, and bearer tokens must not reach a trace
 * backend. Blob paths and container names are identifiers and are safe.
 */
export const Attr = {
  RPC_SYSTEM: "rpc.system",
  RPC_SERVICE: "rpc.service",
  RPC_METHOD: "rpc.method",
  AZURE_BLOB_CONTAINER: "azure.blob.container",
  AZURE_BLOB_KEY: "azure.blob.key",
  AZURE_REQUEST_ID: "azure.request_id",
  HTTP_REQUEST_METHOD: "http.request.method",
  HTTP_RESPONSE_STATUS_CODE: "http.response.status_code",
  HTTP_RESPONSE_BODY_SIZE: "http.response.body.size",
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
  DATASTORE_SHARD: "datastore.shard",
  DATASTORE_SHARDS: "datastore.shards",
  DATASTORE_ENTRIES: "datastore.entries",
  DATASTORE_HYDRATED: "datastore.hydrated",
  DATASTORE_CACHE_HIT: "datastore.cache_hit",
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
