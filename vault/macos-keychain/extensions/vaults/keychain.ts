/**
 * macOS Keychain vault provider for swamp.
 *
 * Stores and retrieves secrets as generic password items in the macOS
 * Keychain using the `security` command-line tool. Each item is scoped
 * by a configurable service name (defaults to "swamp").
 *
 * @module
 */

import { z } from "zod";

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

      return new TextDecoder().decode(stdout).trim();
    };

    return {
      get: async (key: string): Promise<string> => {
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
