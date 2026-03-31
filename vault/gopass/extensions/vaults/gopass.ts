// gopass Vault Provider (gopass.pw)
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  store: z.string().optional().describe(
    "Store/mount name (omit for default store)",
  ),
  passwordOnly: z.boolean().default(true).describe(
    "Return only the password (first line) instead of full secret",
  ),
});

export const vault = {
  type: "@webframp/gopass",
  name: "gopass",
  description:
    "gopass password manager (gopass.pw) - pass compatible with extra features",
  configSchema: ConfigSchema,

  createProvider: (name: string, config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);

    // Build secret path with optional store prefix
    const secretPath = (key: string): string => {
      if (parsed.store) {
        return `${parsed.store}/${key}`;
      }
      return key;
    };

    const runGopass = async (
      args: string[],
      stdin?: string,
    ): Promise<string> => {
      const cmd = new Deno.Command("gopass", {
        args,
        stdin: stdin ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
      });

      const proc = cmd.spawn();

      if (stdin) {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(stdin));
        await writer.close();
      }

      const { code, stdout, stderr } = await proc.output();

      if (code !== 0) {
        const errMsg = new TextDecoder().decode(stderr).trim();
        throw new Error(errMsg || `gopass command failed with code ${code}`);
      }

      return new TextDecoder().decode(stdout).trim();
    };

    return {
      get: async (key: string): Promise<string> => {
        const path = secretPath(key);
        // Use -o to get only the password (first line), or -n for no newline
        const args = parsed.passwordOnly
          ? ["show", "-o", "-n", path]
          : ["show", "-n", path];
        return await runGopass(args);
      },

      put: async (key: string, value: string): Promise<void> => {
        const path = secretPath(key);
        // Use --force to overwrite existing secrets
        await runGopass(["insert", "--force", "--multiline", path], value);
      },

      list: async (): Promise<string[]> => {
        // gopass list --flat gives us a clean newline-separated list
        const args = parsed.store
          ? ["list", "--flat", parsed.store]
          : ["list", "--flat"];

        const output = await runGopass(args);

        if (!output) return [];

        let keys = output.split("\n").filter(Boolean);

        // If using a store prefix, the keys already include it - strip it
        if (parsed.store) {
          const prefix = `${parsed.store}/`;
          keys = keys.map((k) =>
            k.startsWith(prefix) ? k.slice(prefix.length) : k
          );
        }

        return keys.sort();
      },

      getName: (): string => name,
    };
  },
};
