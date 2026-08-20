/**
 * OpenTelemetry helpers for the macOS Keychain vault provider.
 *
 * API-only: this module never constructs a TracerProvider. When the host has
 * not configured one, `trace.getTracer` returns a no-op tracer and every call
 * here costs a few property lookups.
 *
 * ## What must never reach a span
 *
 * Secret values, argv, stdin, and error messages. The last one is not obvious:
 * the swamp host records the message of any error that escapes a vault method
 * into `swamp.cli` as a status description, an `exception.message`, and a stack
 * trace. A keychain error message is `security`'s stderr, and `put` feeds the
 * hex-encoded secret to `security -i` on stdin, whose parser echoes rejected
 * input back — so an unredacted stderr would put the secret in that message.
 *
 * {@linkcode withVaultSpan} therefore records `SpanStatusCode.ERROR` and an
 * `error.type` and nothing else. It accepts no parameter capable of carrying a
 * message, so an edit cannot reintroduce one without changing this file.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import {
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from "npm:@opentelemetry/api@1.9.1";

/** Extension name, used as the instrumentation scope. */
const INSTRUMENTATION_NAME = "@webframp/macos-keychain";
/** Kept in step with `version` in manifest.yaml. */
const INSTRUMENTATION_VERSION = "2026.08.20.1";

/** Returns the tracer for this extension. No-op unless the host configured a provider. */
export function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

/**
 * Attribute keys this extension may set.
 *
 * Deliberately short. Every key here holds a name, a count, or a type — never a
 * value, a credential, or a message.
 */
export const Attr = {
  /** Configured name of the vault instance, e.g. "prod-secrets". */
  VAULT_NAME: "vault.name",
  /** Key the operation addressed. A name, never the secret stored under it. */
  VAULT_SECRET_KEY: "vault.secret_key",
  /** Keychain service name the items are scoped by. */
  VAULT_SERVICE: "vault.service",
  RPC_SYSTEM: "rpc.system",
  RPC_SERVICE: "rpc.service",
  RPC_METHOD: "rpc.method",
  ERROR_TYPE: "error.type",
} as const;

/** The only attribute keys {@linkcode withVaultSpan} accepts. */
type AttrKey = typeof Attr[keyof typeof Attr];

/** Attribute values are scalars only — no objects that might stringify a secret. */
export type VaultSpanAttributes = Partial<
  Record<AttrKey, string | number | boolean>
>;

/**
 * Classifies an error for the `error.type` attribute.
 *
 * Uses `name`, which is a runtime string on built-in errors and survives
 * minification, unlike `constructor.name`.
 */
function errorType(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return typeof err;
}

/**
 * Runs `fn` inside a span, recording failure without recording why.
 *
 * There is no parameter for a message or an error, by design. See the module
 * comment.
 */
export async function withVaultSpan<T>(
  name: string,
  attributes: VaultSpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return await tracer.startActiveSpan(name, async (span: Span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      return await fn();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(Attr.ERROR_TYPE, errorType(err));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Removes a known secret value from text destined for an error message.
 *
 * The host publishes thrown error messages to the trace backend, and a CLI or
 * API that rejects a value often echoes that value back in its error output.
 * Where the extension holds the secret it just submitted, it can strip it
 * exactly rather than guess at patterns.
 *
 * Values shorter than four characters are left alone: replacing every "a" in a
 * diagnostic destroys the diagnostic, and a three-character secret is not
 * something this can protect.
 */
export function redactSecret(
  text: string,
  secrets: string | readonly string[],
): string {
  const list = typeof secrets === "string" ? [secrets] : secrets;
  let out = text;
  for (const secret of list) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
