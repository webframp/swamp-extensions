/**
 * HashiCorp Vault secrets provider for swamp.
 *
 * Connects to a HashiCorp Vault server via the HTTP API and exposes
 * KV v1 and KV v2 secrets engines through the standard swamp vault
 * interface. Supports custom mount paths and Vault Enterprise namespaces.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  Attr,
  recordCount,
  redactSecret,
  type VaultSpanAttributes,
  withVaultSpan,
} from "./_lib/tracing.ts";

/** Shape returned by {@link vault.createProvider}. */
interface VaultProviderInstance {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  list(): Promise<string[]>;
  getName(): string;
}

const ConfigSchema = z.object({
  address: z.string().url().describe(
    "Vault server address (e.g., https://vault.example.com:8200)",
  ),
  token: z.string().optional().describe(
    "Vault authentication token. If omitted, resolves from VAULT_TOKEN env var or ~/.vault-token file.",
  ),
  mount: z.string().default("secret").describe("Secrets engine mount path"),
  kvVersion: z.enum(["1", "2"]).default("2").describe(
    "KV secrets engine version",
  ),
  namespace: z.string().optional().describe(
    "Vault namespace (Enterprise only)",
  ),
});

/**
 * Resolve the Vault token using the standard credential chain:
 * 1. Explicit config token (highest priority)
 * 2. VAULT_TOKEN environment variable
 * 3. ~/.vault-token file (written by `vault login`)
 *
 * Throws with an actionable error if no token is found.
 */
function resolveToken(configToken: string | undefined): string {
  if (configToken) return configToken;

  const envToken = Deno.env.get("VAULT_TOKEN");
  if (envToken) return envToken;

  try {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    if (home) {
      const fileToken = Deno.readTextFileSync(`${home}/.vault-token`).trim();
      if (fileToken) return fileToken;
    }
  } catch {
    // File doesn't exist or isn't readable — fall through
  }

  throw new Error(
    "No Vault token found. Provide one via: " +
      "(1) config 'token' field, " +
      "(2) VAULT_TOKEN environment variable, or " +
      "(3) ~/.vault-token file (run 'vault login' to create it).",
  );
}

/**
 * Rejects keys that would escape the configured mount.
 *
 * The key is interpolated into the request path, so a `..` segment reaches a
 * different mount or a different Vault API entirely — `secret/data/../../sys`
 * is not the secret the caller thinks they asked for.
 */
function assertSafeKey(key: string): void {
  if (key.length === 0) {
    throw new Error("Vault key must not be empty");
  }
  if (key.startsWith("/")) {
    throw new Error(`Vault key must be relative, got "${key}"`);
  }
  if (key.includes("\0")) {
    throw new Error("Vault key must not contain a null byte");
  }
  for (const segment of key.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `Vault key must not contain "." or ".." path segments, got "${key}"`,
      );
    }
    if (segment === "") {
      throw new Error(
        `Vault key must not contain an empty path segment, got "${key}"`,
      );
    }
  }
}

/** Percent-encodes each path segment while leaving the separators intact. */
function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * Wraps `fetch` so a network-level failure (DNS, connection refused, TLS,
 * timeout) is reported with which Vault operation and key were involved,
 * instead of a bare, context-free fetch error. HTTP-level errors (non-2xx
 * responses) are handled separately by `handleResponse`.
 */
async function vaultFetch(
  url: string,
  init: RequestInit,
  operation: string,
  key?: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Vault ${operation} request failed${
        key ? ` (key: ${key})` : ""
      }: could not reach ${url}: ${reason}`,
      { cause },
    );
  }
}

/**
 * Vault provider definition for HashiCorp Vault.
 *
 * Implements the swamp `VaultProvider` contract with `get`, `put`, `list`,
 * and `getName` operations backed by the Vault KV secrets engine.
 */
export const vault = {
  type: "@webframp/hashicorp-vault",
  name: "HashiCorp Vault",
  description: "HashiCorp Vault secrets management via REST API",
  configSchema: ConfigSchema,

  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): VaultProviderInstance => {
    const parsed = ConfigSchema.parse(config);
    const baseUrl = parsed.address.replace(/\/$/, "");
    const token = resolveToken(parsed.token);

    const headers = (): Record<string, string> => {
      const h: Record<string, string> = {
        "X-Vault-Token": token,
        "Content-Type": "application/json",
      };
      if (parsed.namespace) {
        h["X-Vault-Namespace"] = parsed.namespace;
      }
      return h;
    };

    const buildPath = (key: string, operation: "data" | "metadata"): string => {
      assertSafeKey(key);
      const encoded = encodeKeyPath(key);
      if (parsed.kvVersion === "2") {
        return `${baseUrl}/v1/${parsed.mount}/${operation}/${encoded}`;
      }
      // KV v1 doesn't have data/metadata distinction
      return `${baseUrl}/v1/${parsed.mount}/${encoded}`;
    };

    const handleResponse = async (
      response: Response,
      operation: string,
      key?: string,
      submittedSecrets?: readonly string[],
    ): Promise<unknown> => {
      if (!response.ok) {
        const body = await response.text();
        let message =
          `Vault ${operation} failed: ${response.status} ${response.statusText}`;
        try {
          const parsed = JSON.parse(body);
          if (parsed.errors?.length) {
            message = `Vault ${operation} failed: ${parsed.errors.join(", ")}`;
          }
        } catch {
          // Use default message
        }
        if (key) {
          message += ` (key: ${key})`;
        }
        // Vault echoing a rejected value back in its error list would put the
        // secret in this message, and the host publishes thrown messages to the
        // trace backend. Strip everything we know we sent — for a JSON secret
        // that means each field value, not just the string the caller passed.
        if (submittedSecrets?.length) {
          message = redactSecret(message, submittedSecrets);
        }
        throw new Error(message);
      }
      return response.json();
    };

    const spanAttributes = (
      method: string,
      key?: string,
    ): VaultSpanAttributes => {
      const attrs: VaultSpanAttributes = {
        [Attr.VAULT_NAME]: name,
        [Attr.RPC_SYSTEM]: "vault",
        [Attr.RPC_SERVICE]: "@webframp/hashicorp-vault",
        [Attr.RPC_METHOD]: method,
        [Attr.VAULT_KV_VERSION]: parsed.kvVersion,
      };
      if (key !== undefined) attrs[Attr.VAULT_SECRET_KEY] = key;
      return attrs;
    };

    return {
      get: (key: string): Promise<string> => {
        return withVaultSpan(
          "Vault get",
          spanAttributes("get", key),
          async () => {
            const url = buildPath(key, "data");
            const response = await vaultFetch(
              url,
              { headers: headers() },
              "get",
              key,
            );
            const data = (await handleResponse(response, "get", key)) as {
              data: { data?: Record<string, unknown>; value?: string };
            };

            // KV v2 nests data under data.data, KV v1 under data
            const secretData = parsed.kvVersion === "2"
              ? data.data.data
              : data.data;

            if (!secretData) {
              throw new Error(`Secret '${key}' not found or has no data`);
            }

            // If there's a single 'value' key, return it directly
            if ("value" in secretData && typeof secretData.value === "string") {
              return secretData.value;
            }

            // Otherwise return JSON of all key-value pairs
            return JSON.stringify(secretData);
          },
        );
      },

      put: (key: string, value: string): Promise<void> => {
        return withVaultSpan(
          "Vault put",
          spanAttributes("put", key),
          async () => {
            const url = buildPath(key, "data");

            // Try to parse value as JSON, otherwise store as { value: ... }
            let secretData: Record<string, unknown>;
            try {
              secretData = JSON.parse(value);
              if (typeof secretData !== "object" || secretData === null) {
                secretData = { value };
              }
            } catch {
              secretData = { value };
            }

            const body = parsed.kvVersion === "2"
              ? { data: secretData }
              : secretData;

            // Everything leaving here as secret material: the value as given,
            // plus each string field if it parsed as an object. A JSON secret's
            // fields are what Vault would quote back, not the wrapper.
            const submitted = [
              value,
              ...Object.values(secretData).filter((v): v is string =>
                typeof v === "string"
              ),
            ];

            const response = await vaultFetch(
              url,
              {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body),
              },
              "put",
              key,
            );

            await handleResponse(response, "put", key, submitted);
          },
        );
      },

      list: (): Promise<string[]> => {
        return withVaultSpan("Vault list", spanAttributes("list"), async () => {
          const MAX_DEPTH = 10;
          const MAX_KEYS = 10000;
          const listPath = parsed.kvVersion === "2"
            ? `${baseUrl}/v1/${parsed.mount}/metadata`
            : `${baseUrl}/v1/${parsed.mount}`;

          const allKeys: string[] = [];
          // Set when a cap stopped the walk, so a listing that looks complete
          // can be told apart from one that was cut short.
          let truncated = false;

          const collectKeys = async (
            path: string,
            prefix: string = "",
            depth: number = 0,
          ): Promise<void> => {
            if (depth >= MAX_DEPTH || allKeys.length >= MAX_KEYS) {
              truncated = true;
              return;
            }

            // One span per request: `list` is the only operation that fans out,
            // and a slow or failing branch is otherwise invisible inside the
            // parent's total duration.
            const data = await withVaultSpan(
              "Vault LIST",
              { ...spanAttributes("list"), [Attr.VAULT_LIST_DEPTH]: depth },
              async () => {
                const response = await vaultFetch(
                  `${path}?list=true`,
                  { method: "LIST", headers: headers() },
                  "list",
                );

                if (response.status === 404) {
                  // A missing path means an empty listing, not a failure. The
                  // body still has to be read or the connection leaks.
                  await response.body?.cancel();
                  return undefined;
                }

                return (await handleResponse(response, "list")) as {
                  data: { keys?: string[] };
                };
              },
            );

            if (!data?.data?.keys) {
              return;
            }

            for (const key of data.data.keys) {
              if (allKeys.length >= MAX_KEYS) {
                truncated = true;
                break;
              }
              const fullKey = prefix ? `${prefix}${key}` : key;
              if (key.endsWith("/")) {
                // The directory name comes back from Vault and goes straight
                // into the next request path, so it needs the same encoding a
                // caller-supplied key gets. A directory containing `?` would
                // otherwise start a query string.
                const dir = encodeURIComponent(key.slice(0, -1));
                await collectKeys(
                  `${path}/${dir}`,
                  fullKey,
                  depth + 1,
                );
              } else {
                allKeys.push(fullKey);
              }
            }
          };

          await collectKeys(listPath);
          recordCount(Attr.VAULT_KEYS_RETURNED, allKeys.length);
          recordCount(Attr.VAULT_TRUNCATED, truncated);
          return allKeys.sort();
        });
      },

      getName: (): string => name,
    };
  },
};
