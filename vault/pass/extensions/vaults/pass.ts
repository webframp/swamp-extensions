// Pass (passwordstore.org) Vault Provider
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  storeDir: z.string().optional().describe(
    "PASSWORD_STORE_DIR override (defaults to ~/.password-store)",
  ),
  prefix: z.string().optional().default("swamp").describe(
    "Key prefix for namespacing secrets (defaults to 'swamp')",
  ),
});

export const vault = {
  type: "@webframp/pass",
  name: "Pass (passwordstore.org)",
  description: "GPG-encrypted password store using the pass CLI",
  configSchema: ConfigSchema,

  createProvider: (name: string, config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    const storeDir = parsed.storeDir ||
      `${Deno.env.get("HOME")}/.password-store`;
    const prefix = parsed.prefix;

    const runPass = async (
      args: string[],
      stdin?: string,
    ): Promise<string> => {
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        PASSWORD_STORE_DIR: storeDir,
      };

      const cmd = new Deno.Command("pass", {
        args,
        env,
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
        throw new Error(errMsg || `pass command failed with code ${code}`);
      }

      return new TextDecoder().decode(stdout).trim();
    };

    const prefixKey = (key: string): string =>
      prefix ? `${prefix}/${key}` : key;

    return {
      get: async (key: string): Promise<string> => {
        return await runPass(["show", prefixKey(key)]);
      },

      put: async (key: string, value: string): Promise<void> => {
        // Use -m for multiline and -f to force overwrite
        await runPass(["insert", "-m", "-f", prefixKey(key)], value);
      },

      list: async (): Promise<string[]> => {
        // Find all .gpg files and convert to key names
        const cmd = new Deno.Command("find", {
          args: [
            storeDir,
            "-not",
            "-path",
            "*/.git/*",
            "-not",
            "-path",
            "*/.extensions/*",
            "-name",
            "*.gpg",
            "-type",
            "f",
          ],
          stdout: "piped",
          stderr: "piped",
        });

        const { code, stdout } = await cmd.output();

        if (code !== 0) {
          return [];
        }

        const output = new TextDecoder().decode(stdout).trim();
        if (!output) return [];

        // Convert file paths to pass key names
        // e.g., /home/user/.password-store/swamp/foo.gpg -> foo
        const dirPrefix = storeDir.endsWith("/") ? storeDir : `${storeDir}/`;
        const keyPrefix = prefix ? `${prefix}/` : "";

        return output
          .split("\n")
          .filter(Boolean)
          .map((path) => path.replace(dirPrefix, "").replace(/\.gpg$/, ""))
          .filter((key) => key.startsWith(keyPrefix))
          .map((key) => key.slice(keyPrefix.length))
          .sort();
      },

      getName: (): string => name,
    };
  },
};
