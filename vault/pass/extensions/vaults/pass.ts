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
 *
 * This list is only meaningful alongside `clearEnv: true`. Deno merges the
 * `env` option into the parent environment rather than replacing it, so an
 * allowlist without `clearEnv` filters nothing at all.
 */
export const ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SHELL",
  // Locale, so error messages and character handling match the user's shell.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  // GPG needs these to find its home and reach its agent.
  "GNUPGHOME",
  "GPG_AGENT_INFO",
  "GPG_TTY",
  "SSH_AUTH_SOCK",
  "TERM",
  // pinentry needs these to draw a prompt. Which ones matter depends on which
  // pinentry is installed: the curses variant needs the TTY, the GTK and Qt
  // variants need the display, the session bus, and the X authority file.
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "PINENTRY_USER_DATA",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // pass's own configuration, other than PASSWORD_STORE_DIR which is set
  // explicitly from config.
  "PASSWORD_STORE_KEY",
  "PASSWORD_STORE_GPG_OPTS",
  "PASSWORD_STORE_UMASK",
  "PASSWORD_STORE_SIGNING_KEY",
  "PASSWORD_STORE_CLIP_TIME",
  "PASSWORD_STORE_CHARACTER_SET",
  "PASSWORD_STORE_CHARACTER_SET_NO_SYMBOLS",
  "PASSWORD_STORE_GENERATED_LENGTH",
  "PASSWORD_STORE_ENABLE_EXTENSIONS",
  "PASSWORD_STORE_EXTENSIONS_DIR",
] as const;

/**
 * Builds the environment for a subprocess: the allowlist, plus any names the
 * operator added via `extraEnv`, plus the store directory.
 */
function buildEnv(
  storeDir: string | undefined,
  extraEnv: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ENV_ALLOWLIST, ...extraEnv]) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  if (storeDir !== undefined) env.PASSWORD_STORE_DIR = storeDir;
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
    if (segment === "") {
      throw new Error(
        `pass key must not contain an empty path segment, got "${key}"`,
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
  extraEnv: z.array(z.string().min(1)).default([]).describe(
    "Additional environment variable names to forward to the pass subprocess. " +
      "The subprocess otherwise receives only the variables pass and GPG need. " +
      "Use this if an unusual pinentry or GPG setup requires a variable that " +
      "is not on the default list.",
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
      const cmd = new Deno.Command("pass", {
        args,
        env: buildEnv(storeDir, parsed.extraEnv),
        // Without this Deno merges `env` into the parent environment instead of
        // replacing it, and the allowlist filters nothing.
        clearEnv: true,
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
          // `find` gets the same narrowed environment as `pass`. It needs none
          // of it, but leaving one subprocess inheriting the parent env while
          // narrowing the other defeats the point.
          env: buildEnv(storeDir, parsed.extraEnv),
          clearEnv: true,
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
