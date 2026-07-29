// ABOUTME: OpenTelemetry span helpers for the DynamoDB datastore. Depends on
// ABOUTME: @opentelemetry/api only — the host process owns the TracerProvider,
// ABOUTME: so every span here is a zero-cost no-op when none is registered.

import {
  type Attributes,
  context,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from "npm:@opentelemetry/api@1.9.1";
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
} from "npm:@aws-sdk/client-dynamodb@3.1096.0";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "npm:@aws-sdk/lib-dynamodb@3.1096.0";

/** Instrumentation scope name — matches the extension name in manifest.yaml. */
const TRACER_NAME = "@webframp/dynamodb-datastore";

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Span attribute keys. Item content is never recorded — only counts and keys. */
export const Attr = {
  DB_SYSTEM: "db.system.name",
  RPC_SYSTEM: "rpc.system",
  RPC_SERVICE: "rpc.service",
  RPC_METHOD: "rpc.method",
  AWS_DYNAMODB_TABLE_NAMES: "aws.dynamodb.table_names",
  AWS_DYNAMODB_INDEX_NAME: "aws.dynamodb.index_name",
  AWS_DYNAMODB_CONSUMED_CAPACITY: "aws.dynamodb.consumed_capacity.total",
  AWS_DYNAMODB_COUNT: "aws.dynamodb.count",
  AWS_DYNAMODB_SCANNED_COUNT: "aws.dynamodb.scanned_count",
  AWS_REQUEST_ID: "aws.request_id",
  HTTP_RESPONSE_STATUS_CODE: "http.response.status_code",
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
  DATASTORE_PARTITIONS: "datastore.partitions",
  DATASTORE_ENTRIES: "datastore.entries",
  DATASTORE_CHUNKS: "datastore.chunks",
  DATASTORE_HYDRATED: "datastore.hydrated",
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
 * Detaches `fn` from whatever span is currently active.
 *
 * Heartbeat renewals fire from a `setInterval` created during `acquire()`. With
 * a context manager installed, a span created in that callback inherits the
 * acquire span as its parent and starts after that parent has already ended,
 * which most trace backends render as a broken trace. Running the callback
 * under the root context makes each renewal its own trace instead.
 */
export function detached<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn);
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

/**
 * SDK command class to the DynamoDB API operation it issues.
 *
 * Keyed on the class object rather than its name: swamp's bundler inlines npm
 * packages, and if it ever minifies them `constructor.name` collapses to a
 * single letter and every span would be named `DynamoDB Unknown`. Identity
 * comparison cannot be minified away.
 *
 * The document client's classes are named `PutCommand`/`GetCommand` while the
 * wire operations are `PutItem`/`GetItem`, and `rpc.method` should carry the
 * wire name.
 */
// deno-lint-ignore ban-types
const OPERATION_BY_CLASS = new Map<Function, string>([
  [PutCommand, "PutItem"],
  [GetCommand, "GetItem"],
  [UpdateCommand, "UpdateItem"],
  [DeleteCommand, "DeleteItem"],
  [QueryCommand, "Query"],
  [ScanCommand, "Scan"],
  [BatchGetCommand, "BatchGetItem"],
  [BatchWriteCommand, "BatchWriteItem"],
  [DescribeTableCommand, "DescribeTable"],
  [CreateTableCommand, "CreateTable"],
  [UpdateTimeToLiveCommand, "UpdateTimeToLive"],
]);

/**
 * Name-keyed fallback, for a command built from a different copy of the SDK or
 * a test double that is not one of the classes above.
 */
const OPERATION_BY_NAME: Record<string, string> = {
  PutCommand: "PutItem",
  GetCommand: "GetItem",
  UpdateCommand: "UpdateItem",
  DeleteCommand: "DeleteItem",
  QueryCommand: "Query",
  ScanCommand: "Scan",
  BatchGetCommand: "BatchGetItem",
  BatchWriteCommand: "BatchWriteItem",
  PutItemCommand: "PutItem",
  GetItemCommand: "GetItem",
  UpdateItemCommand: "UpdateItem",
  DeleteItemCommand: "DeleteItem",
  DescribeTableCommand: "DescribeTable",
  CreateTableCommand: "CreateTable",
  UpdateTimeToLiveCommand: "UpdateTimeToLive",
};

export function operationName(command: unknown): string {
  const ctor = (command as { constructor?: unknown })?.constructor;
  if (typeof ctor === "function") {
    const byClass = OPERATION_BY_CLASS.get(ctor);
    if (byClass) return byClass;
  }
  const className = (command as { constructor?: { name?: string } })
    ?.constructor?.name ?? "Unknown";
  return OPERATION_BY_NAME[className] ??
    (className.endsWith("Command")
      ? className.slice(0, -"Command".length)
      : className);
}

interface SdkCommand {
  input?: {
    TableName?: string;
    IndexName?: string;
  };
}

interface SdkOutput {
  $metadata?: { httpStatusCode?: number; requestId?: string };
  ConsumedCapacity?: { CapacityUnits?: number };
  Count?: number;
  ScannedCount?: number;
}

/**
 * Wraps an AWS SDK client so every `send` emits one span.
 *
 * This extension has no single call site every request flows through — the SDK
 * is invoked directly from lock.ts, sync.ts, and mod.ts at seventeen places, on
 * two different clients. Wrapping `send` once covers all of them, and covers
 * any call added later, without touching the call sites. `DynamoDBDocumentClient`
 * does not delegate to the base client's `send`, so instrumenting both clients
 * produces one span per logical request rather than two.
 *
 * Only `send` is intercepted; every other property passes through untouched.
 */
export function instrumentClient<C extends object>(client: C): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "send") return Reflect.get(target, prop, receiver);
      // deno-lint-ignore no-explicit-any
      const original = Reflect.get(target, prop, receiver) as any;
      if (typeof original !== "function") return original;
      // deno-lint-ignore no-explicit-any
      return (command: any, ...rest: any[]) => {
        const op = operationName(command);
        const input = (command as SdkCommand).input;
        return withSpan(`DynamoDB ${op}`, {
          [Attr.RPC_SYSTEM]: "aws-api",
          [Attr.RPC_SERVICE]: "DynamoDB",
          [Attr.RPC_METHOD]: op,
          [Attr.DB_SYSTEM]: "dynamodb",
          ...(input?.TableName
            ? { [Attr.AWS_DYNAMODB_TABLE_NAMES]: [input.TableName] }
            : {}),
          ...(input?.IndexName
            ? { [Attr.AWS_DYNAMODB_INDEX_NAME]: input.IndexName }
            : {}),
        }, async (span) => {
          const result = await original.call(target, command, ...rest) as
            | SdkOutput
            | undefined;
          const meta = result?.$metadata;
          if (meta?.httpStatusCode != null) {
            span.setAttribute(
              Attr.HTTP_RESPONSE_STATUS_CODE,
              meta.httpStatusCode,
            );
          }
          if (meta?.requestId) {
            span.setAttribute(Attr.AWS_REQUEST_ID, meta.requestId);
          }
          const capacity = result?.ConsumedCapacity?.CapacityUnits;
          if (capacity != null) {
            span.setAttribute(Attr.AWS_DYNAMODB_CONSUMED_CAPACITY, capacity);
          }
          if (result?.Count != null) {
            span.setAttribute(Attr.AWS_DYNAMODB_COUNT, result.Count);
          }
          if (result?.ScannedCount != null) {
            span.setAttribute(
              Attr.AWS_DYNAMODB_SCANNED_COUNT,
              result.ScannedCount,
            );
          }
          return result;
        });
      };
    },
  });
}
