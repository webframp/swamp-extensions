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
import {
  Attr,
  redactSecret,
  type VaultSpanAttributes,
  withVaultSpan,
} from "./_lib/tracing.ts";

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

    const runSecurity = async (
      args: string[],
      submittedSecret?: string,
    ): Promise<string> => {
      const cmd = new Deno.Command("security", {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });

      const proc = cmd.spawn();
      const { code, stdout, stderr } = await proc.output();

      if (code !== 0) {
        let errMsg = new TextDecoder().decode(stderr).trim();
        // `put` passes the secret as the `-w` argument, and a CLI that rejects
        // an argument commonly quotes it back. The swamp host publishes thrown
        // error messages to the trace backend as a span status and an
        // exception, so strip the value we know we passed.
        if (submittedSecret) {
          errMsg = redactSecret(errMsg, submittedSecret);
        }
        throw new Error(
          errMsg || `security command failed with code ${code}`,
        );
      }

      return stripTrailingNewline(new TextDecoder().decode(stdout));
    };

    const spanAttributes = (
      method: string,
      key?: string,
    ): VaultSpanAttributes => {
      const attrs: VaultSpanAttributes = {
        [Attr.VAULT_NAME]: name,
        [Attr.RPC_SYSTEM]: "keychain",
        [Attr.RPC_SERVICE]: "@webframp/macos-keychain",
        [Attr.RPC_METHOD]: method,
        [Attr.VAULT_SERVICE]: parsed.service,
      };
      if (key !== undefined) attrs[Attr.VAULT_SECRET_KEY] = key;
      return attrs;
    };

    return {
      get: (key: string): Promise<string> => {
        return withVaultSpan(
          "Keychain get",
          spanAttributes("get", key),
          async () => {
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
        );
      },

      put: (key: string, value: string): Promise<void> => {
        return withVaultSpan(
          "Keychain put",
          spanAttributes("put", key),
          async () => {
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
            ], value);
          },
        );
      },

      list: (): Promise<string[]> => {
        // `security` has no way to enumerate accounts for a service, so this is
        // unsupported rather than empty. The span records the failure like any
        // other, which is honest: a caller did ask for a listing and did not
        // get one.
        return withVaultSpan(
          "Keychain list",
          spanAttributes("list"),
          () =>
            Promise.reject(
              new Error(
                "Listing keychain items is not supported by this vault provider",
              ),
            ),
        );
      },

      getName: (): string => name,
    };
  },
};
