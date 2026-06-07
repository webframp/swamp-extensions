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

import { z } from "npm:zod@4.3.6";

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
      if (parsed.kvVersion === "2") {
        return `${baseUrl}/v1/${parsed.mount}/${operation}/${key}`;
      }
      // KV v1 doesn't have data/metadata distinction
      return `${baseUrl}/v1/${parsed.mount}/${key}`;
    };

    const handleResponse = async (
      response: Response,
      operation: string,
      key?: string,
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
        throw new Error(message);
      }
      return response.json();
    };

    return {
      get: async (key: string): Promise<string> => {
        const url = buildPath(key, "data");
        const response = await fetch(url, { headers: headers() });
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

      put: async (key: string, value: string): Promise<void> => {
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

        const response = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        });

        await handleResponse(response, "put", key);
      },

      list: async (): Promise<string[]> => {
        const MAX_DEPTH = 10;
        const MAX_KEYS = 10000;
        const listPath = parsed.kvVersion === "2"
          ? `${baseUrl}/v1/${parsed.mount}/metadata`
          : `${baseUrl}/v1/${parsed.mount}`;

        const allKeys: string[] = [];

        const collectKeys = async (
          path: string,
          prefix: string = "",
          depth: number = 0,
        ): Promise<void> => {
          if (depth >= MAX_DEPTH || allKeys.length >= MAX_KEYS) return;

          const response = await fetch(`${path}?list=true`, {
            method: "LIST",
            headers: headers(),
          });

          if (response.status === 404) {
            return;
          }

          const data = (await handleResponse(response, "list")) as {
            data: { keys?: string[] };
          };

          if (!data.data?.keys) {
            return;
          }

          for (const key of data.data.keys) {
            if (allKeys.length >= MAX_KEYS) break;
            const fullKey = prefix ? `${prefix}${key}` : key;
            if (key.endsWith("/")) {
              await collectKeys(
                `${path}/${key.slice(0, -1)}`,
                fullKey,
                depth + 1,
              );
            } else {
              allKeys.push(fullKey);
            }
          }
        };

        await collectKeys(listPath);
        return allKeys.sort();
      },

      getName: (): string => name,
    };
  },
};
