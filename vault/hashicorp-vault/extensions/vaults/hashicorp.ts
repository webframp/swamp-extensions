// HashiCorp Vault Provider
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  address: z.string().url().describe(
    "Vault server address (e.g., https://vault.example.com:8200)",
  ),
  token: z.string().describe("Vault authentication token"),
  mount: z.string().default("secret").describe("Secrets engine mount path"),
  kvVersion: z.enum(["1", "2"]).default("2").describe(
    "KV secrets engine version",
  ),
  namespace: z.string().optional().describe(
    "Vault namespace (Enterprise only)",
  ),
});

export const vault = {
  type: "@webframp/hashicorp-vault",
  name: "HashiCorp Vault",
  description: "HashiCorp Vault secrets management via REST API",
  configSchema: ConfigSchema,

  createProvider: (name: string, config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    const baseUrl = parsed.address.replace(/\/$/, "");

    const headers = (): Record<string, string> => {
      const h: Record<string, string> = {
        "X-Vault-Token": parsed.token,
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
        const listPath = parsed.kvVersion === "2"
          ? `${baseUrl}/v1/${parsed.mount}/metadata`
          : `${baseUrl}/v1/${parsed.mount}`;

        const collectKeys = async (
          path: string,
          prefix: string = "",
        ): Promise<string[]> => {
          const response = await fetch(`${path}?list=true`, {
            method: "LIST",
            headers: headers(),
          });

          if (response.status === 404) {
            return [];
          }

          const data = (await handleResponse(response, "list")) as {
            data: { keys: string[] };
          };

          const keys: string[] = [];

          for (const key of data.data.keys) {
            const fullKey = prefix ? `${prefix}${key}` : key;
            if (key.endsWith("/")) {
              // It's a folder, recurse
              const subKeys = await collectKeys(
                `${path}/${key.slice(0, -1)}`,
                fullKey,
              );
              keys.push(...subKeys);
            } else {
              keys.push(fullKey);
            }
          }

          return keys;
        };

        return (await collectKeys(listPath)).sort();
      },

      getName: (): string => name,
    };
  },
};
