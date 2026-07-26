/**
 * Pass (passwordstore.org) vault provider for swamp.
 *
 * Stores and retrieves secrets using the `pass` CLI with GPG encryption.
 * Supports configurable key prefixing for namespace isolation and custom
 * PASSWORD_STORE_DIR paths.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

/**
 * Environment variables forwarded to the `pass` subprocess.
 *
 * The whole parent environment used to be copied in, which handed `pass` — and
 * every GPG agent hook it invokes — any AWS key, database URL, or API token
 * that happened to be set. Only the variables pass and GPG actually need are
 * forwarded now.
 */
const ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // GPG needs these to find its home, reach its agent, and prompt correctly.
  "GNUPGHOME",
  "GPG_AGENT_INFO",
  "GPG_TTY",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "TERM",
  // pass's own configuration, other than PASSWORD_STORE_DIR which is set
  // explicitly from config.
  "PASSWORD_STORE_KEY",
  "PASSWORD_STORE_GPG_OPTS",
  "PASSWORD_STORE_UMASK",
  "PASSWORD_STORE_SIGNING_KEY",
] as const;

function allowlistedEnv(storeDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  env.PASSWORD_STORE_DIR = storeDir;
  return env;
}

/**
 * Removes the single trailing newline a CLI adds when it prints a value.
 *
 * Deliberately not `trim()`: a secret may legitimately begin or end with
 * spaces or tabs, and trimming silently returned different bytes than were
 * stored. Only one line terminator is removed, and only from the end.
 *
 * A secret whose own final character is a newline is indistinguishable from
 * the terminator the CLI adds, so that one byte cannot be recovered — a limit
 * of line-oriented CLIs, not something this can work around.
 */
function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Rejects keys that would escape the configured prefix.
 *
 * Keys become path segments under the store directory, so `..` in one lets a
 * caller read or overwrite a secret outside the namespace the config pinned
 * them to.
 */
function assertSafeKey(key: string): void {
  if (key.length === 0) {
    throw new Error("pass key must not be empty");
  }
  if (key.startsWith("/")) {
    throw new Error(`pass key must be relative, got "${key}"`);
  }
  if (key.includes("\0")) {
    throw new Error("pass key must not contain a null byte");
  }
  if (key.startsWith("-")) {
    // Keys are passed as CLI arguments. A leading dash would be parsed as a
    // flag by the CLI itself, whatever Deno.Command does with argv.
    throw new Error(`pass key must not start with "-", got "${key}"`);
  }
  for (const segment of key.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `pass key must not contain "." or ".." path segments, got "${key}"`,
      );
    }
  }
}

const ConfigSchema = z.object({
  storeDir: z.string().optional().describe(
    "PASSWORD_STORE_DIR override (defaults to ~/.password-store)",
  ),
  prefix: z.string().optional().default("swamp").describe(
    "Key prefix for namespacing secrets (defaults to 'swamp'). " +
      "BREAKING from 2026.04.13.1: prior versions had no prefix. " +
      "Set to '' (empty string) to access keys stored by earlier versions.",
  ),
});

/** Pass vault provider — delegates to the `pass` CLI for GPG-encrypted secret storage. */
export const vault = {
  type: "@webframp/pass",
  name: "Pass (passwordstore.org)",
  description: "GPG-encrypted password store using the pass CLI",
  configSchema: ConfigSchema,

  createProvider: (name: string, config: Record<string, unknown>): {
    get: (key: string) => Promise<string>;
    put: (key: string, value: string) => Promise<void>;
    list: () => Promise<string[]>;
    getName: () => string;
  } => {
    const parsed = ConfigSchema.parse(config);
    const storeDir = parsed.storeDir ||
      `${Deno.env.get("HOME")}/.password-store`;
    const prefix = parsed.prefix;

    const runPass = async (
      args: string[],
      stdin?: string,
    ): Promise<string> => {
      const env = allowlistedEnv(storeDir);

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

      return stripTrailingNewline(new TextDecoder().decode(stdout));
    };

    const prefixKey = (key: string): string => {
      assertSafeKey(key);
      return prefix ? `${prefix}/${key}` : key;
    };

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
