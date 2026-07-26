/**
 * macOS Keychain vault provider for swamp.
 *
 * Stores and retrieves secrets as generic password items in the macOS
 * Keychain using the `security` command-line tool. Each item is scoped
 * by a configurable service name (defaults to "swamp").
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

/**
 * Removes the single trailing newline the `security` CLI adds when it prints a
 * password.
 *
 * Deliberately not `trim()`: a secret may legitimately begin or end with
 * spaces or tabs, and trimming silently returned different bytes than were
 * stored. Only one line terminator is removed, and only from the end.
 *
 * A secret whose own final character is a newline is indistinguishable from
 * the terminator the CLI adds, so that one byte cannot be recovered.
 */
function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Rejects keys the `security` CLI would misread.
 *
 * The key becomes the `-a` account argument, so a leading dash would be parsed
 * as a flag regardless of argv being passed as an array.
 */
function assertSafeKey(key: string): void {
  if (key.length === 0) {
    throw new Error("keychain key must not be empty");
  }
  if (key.includes("\0")) {
    throw new Error("keychain key must not contain a null byte");
  }
  if (key.startsWith("-")) {
    throw new Error(`keychain key must not start with "-", got "${key}"`);
  }
}

/** The shape returned by {@linkcode vault.createProvider}. */
export interface KeychainVaultProvider {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  list(): Promise<string[]>;
  getName(): string;
}

const ConfigSchema = z.object({
  service: z.string().min(1).default("swamp").describe(
    "Service name for keychain items (defaults to 'swamp')",
  ),
});

/** macOS Keychain vault provider definition. */
export const vault = {
  type: "@webframp/macos-keychain",
  name: "macos-keychain",
  description: "macOS Keychain vault using the security CLI",
  configSchema: ConfigSchema,

  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): KeychainVaultProvider => {
    const parsed = ConfigSchema.parse(config);

    const runSecurity = async (args: string[]): Promise<string> => {
      const cmd = new Deno.Command("security", {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });

      const proc = cmd.spawn();
      const { code, stdout, stderr } = await proc.output();

      if (code !== 0) {
        const errMsg = new TextDecoder().decode(stderr).trim();
        throw new Error(
          errMsg || `security command failed with code ${code}`,
        );
      }

      return stripTrailingNewline(new TextDecoder().decode(stdout));
    };

    return {
      get: async (key: string): Promise<string> => {
        assertSafeKey(key);
        return await runSecurity([
          "find-generic-password",
          "-s",
          parsed.service,
          "-a",
          key,
          "-w",
        ]);
      },

      put: async (key: string, value: string): Promise<void> => {
        assertSafeKey(key);
        await runSecurity([
          "add-generic-password",
          "-s",
          parsed.service,
          "-a",
          key,
          "-w",
          value,
          "-U",
        ]);
      },

      list: (): Promise<string[]> => {
        return Promise.reject(
          new Error(
            "Listing keychain items is not supported by this vault provider",
          ),
        );
      },

      getName: (): string => name,
    };
  },
};
