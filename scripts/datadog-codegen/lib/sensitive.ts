/**
 * Secret detection for generated schemas.
 *
 * A field marked `.meta({ sensitive: true })` is handled by swamp itself: a
 * method argument is masked in output, and a resource field is stored in a
 * vault with only a vault reference persisted. The generator marks a field
 * when its name says it holds a credential, or when `config.ts` lists it
 * because its name gives no hint.
 *
 * @module
 */

import type { SchemaObject } from "./schema_fetcher.ts";

/** Final tokens that name a credential on their own. */
const SECRET_NOUNS = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "apikey",
  "appkey",
  "privatekey",
  "authorization",
]);

/** Qualifiers that turn a trailing `key` into a credential. */
const KEY_QUALIFIERS = new Set([
  "api",
  "app",
  "application",
  "private",
  "signing",
  "encryption",
]);

/** Qualifiers that turn a trailing `token` into a pagination cursor. */
const CURSOR_QUALIFIERS = new Set([
  "page",
  "next",
  "prev",
  "previous",
  "continuation",
  "cursor",
  "pagination",
  "sync",
]);

/** Leading tokens that make the field a flag about a secret, not the secret. */
const FLAG_PREFIXES = new Set([
  "has",
  "is",
  "use",
  "uses",
  "requires",
  "enable",
  "enabled",
]);

/** Split a field name into lowercase tokens (snake, kebab and camel case). */
export function tokenizeFieldName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * True when a field's name says it holds a credential.
 *
 * Only the field's final noun counts, so `api_key` and `client_secret` match
 * while `api_key_id`, `secret_name`, `author` and `creationAuthorId` do not.
 * A trailing `token` matches unless a pagination qualifier precedes it
 * (`page_token`, `next_token`). Flags (`has_password`, `is_secret`) and
 * non-string scalars never match.
 */
export function isSensitiveFieldName(
  name: string,
  schema?: SchemaObject,
): boolean {
  if (
    schema?.type === "boolean" || schema?.type === "number" ||
    schema?.type === "integer"
  ) {
    return false;
  }
  const tokens = tokenizeFieldName(name);
  if (tokens.length === 0) return false;
  if (FLAG_PREFIXES.has(tokens[0]) && tokens.length > 1) return false;

  const last = tokens[tokens.length - 1];
  const prev = tokens.length > 1 ? tokens[tokens.length - 2] : undefined;

  if (SECRET_NOUNS.has(last)) return true;
  if (last === "key" && prev !== undefined && KEY_QUALIFIERS.has(prev)) {
    return true;
  }
  // secret_key, secret_access_key, secret_value
  if ((last === "key" || last === "value") && tokens.includes("secret")) {
    return true;
  }
  if (last === "token") {
    return prev === undefined || !CURSOR_QUALIFIERS.has(prev);
  }
  return false;
}
