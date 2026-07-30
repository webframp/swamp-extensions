/**
 * macOS Keychain vault provider for swamp.
 *
 * Stores and retrieves secrets as generic password items in the macOS
 * Keychain using the `security` command-line tool. Each item is scoped
 * by a configurable service name (defaults to "swamp").
 *
 * ## How the secret travels
 *
 * `put` never places the secret in the argument vector. It hex-encodes the
 * value and feeds `add-generic-password ... -X <hex>` to `security -i` on
 * stdin, because argv is readable by every process running as the same user
 * (#275). Hex survives `security -i`'s undocumented tokenizer unchanged: it
 * contains no whitespace, quotes, backslashes, or newlines.
 *
 * `get` reads with `find-generic-password -w`. On macOS 26 that flag prints
 * lowercase hex instead of the secret when any byte falls outside printable
 * ASCII (0x20-0x7E). Output that looks like hex is disambiguated through
 * `-g`, whose stderr marks the encoding explicitly (`password: 0x...` versus
 * `password: "..."`), so a secret that legitimately looks like hex is never
 * decoded by mistake.
 *
 * All of the behavior above was probed on real hardware (macOS 26.5.2,
 * build 25F84) and recorded in #275 before this implementation.
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
 * `security -i` reads commands with a fixed line buffer of 4096 bytes,
 * including the terminating newline (probed: a 4096-byte line executes, a
 * 4097-byte line is split and both halves execute — after storing a corrupted
 * value). The budget must be enforced before spawning, because the write
 * happens before the nonzero exit code.
 */
const MAX_INTERACTIVE_LINE = 4096;

/** Output of `find-generic-password -w` when macOS hex-encodes: hex pairs only. */
const HEX_PAIRS = /^(?:[0-9a-fA-F]{2})+$/;

/** Marker prefixes on the `-g` password line. The `0x` form means hex. */
const G_HEX_PREFIX = "password: 0x";
const G_LINE_PREFIX = "password:";

/**
 * Removes the single trailing newline the `security` CLI adds when it prints a
 * password.
 *
 * Deliberately not `trim()`: a secret may legitimately begin or end with
 * spaces or tabs, and trimming silently returned different bytes than were
 * stored. Only one line terminator is removed, and only from the end.
 *
 * On macOS 26 a secret containing any non-printable byte (including a
 * newline) comes back hex-encoded and is decoded exactly, so this ambiguity
 * only exists for raw output from older macOS versions.
 */
function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Rejects keys the `security` CLI would misread.
 *
 * The key becomes the `-a` account argument. A leading dash would be parsed
 * as a flag regardless of argv being passed as an array, and control
 * characters (a newline above all) would split or terminate the command line
 * `put` writes to `security -i`.
 */
function assertSafeKey(key: string): void {
  if (key.length === 0) {
    throw new Error("keychain key must not be empty");
  }
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new Error("keychain key must not contain control characters");
  }
  if (key.startsWith("-")) {
    throw new Error(`keychain key must not start with "-", got "${key}"`);
  }
}

/** Encodes a string's UTF-8 bytes as lowercase hex. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Decodes hex pairs to bytes. The caller validates the shape first. */
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Quotes a token for the `security -i` line.
 *
 * Probed tokenizer rules: double quotes group a token, and inside them a
 * backslash escapes the next character (`\"` is a quote, `\\` is a
 * backslash). Newlines cannot be represented at all — {@linkcode
 * assertSafeKey} and the config schema reject them upstream.
 */
function quoteInteractive(token: string): string {
  return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The shape returned by {@linkcode vault.createProvider}. */
export interface KeychainVaultProvider {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  list(): Promise<string[]>;
  getName(): string;
}

const ConfigSchema = z.object({
  service: z.string().min(1).refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00-\x1f\x7f]/.test(s),
    "service must not contain control characters",
  ).default("swamp").describe(
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
      opts: { stdin?: string; redact?: readonly string[] } = {},
    ): Promise<{ stdout: string; stderr: string }> => {
      const cmd = new Deno.Command("security", {
        args,
        stdin: opts.stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      });

      const proc = cmd.spawn();
      if (opts.stdin !== undefined) {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(opts.stdin));
        await writer.close();
      }
      const { code, stdout, stderr } = await proc.output();
      const stderrText = new TextDecoder().decode(stderr);

      if (code !== 0) {
        // The swamp host publishes thrown error messages to the trace backend
        // as a span status and an exception, and `security` echoes rejected
        // input back on stderr, so strip every representation of the secret
        // we submitted.
        let errMsg = stderrText.trim();
        if (opts.redact?.length) {
          errMsg = redactSecret(errMsg, opts.redact);
        }
        throw new Error(
          errMsg || `security command failed with code ${code}`,
        );
      }

      return {
        stdout: stripTrailingNewline(new TextDecoder().decode(stdout)),
        stderr: stderrText,
      };
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
            const { stdout } = await runSecurity([
              "find-generic-password",
              "-s",
              parsed.service,
              "-a",
              key,
              "-w",
            ]);

            // Raw output. A hex-encoded secret can only contain hex digits,
            // and any secret with a non-hex or non-printable character can
            // never produce hex-looking output, so this is unambiguous.
            if (!HEX_PAIRS.test(stdout)) return stdout;

            // Ambiguous: either macOS 26 hex-encoded a secret containing
            // non-printable bytes, or the secret itself looks like hex.
            // `-g` states which on its password line: `password: 0x...`
            // for hex, `password: "..."` for a literal. Only the prefix is
            // inspected — the quoted form's escaping is not part of the
            // contract this relies on.
            const probe = await runSecurity([
              "find-generic-password",
              "-s",
              parsed.service,
              "-a",
              key,
              "-g",
            ]);
            const pwLine = probe.stderr
              .split("\n")
              .find((line) => line.startsWith(G_LINE_PREFIX));
            if (pwLine === undefined) {
              throw new Error(
                "could not determine keychain password encoding: " +
                  "security -g printed no password line",
              );
            }
            if (!pwLine.startsWith(G_HEX_PREFIX)) return stdout;

            const hexToken = pwLine.slice(G_HEX_PREFIX.length).split(/\s/)[0];
            if (!HEX_PAIRS.test(hexToken)) {
              throw new Error(
                "could not determine keychain password encoding: " +
                  "security -g printed a malformed hex password",
              );
            }
            // fatal: a secret that is not valid UTF-8 cannot be represented
            // as a string; returning replacement characters would hand the
            // caller silently corrupted bytes.
            return new TextDecoder("utf-8", { fatal: true }).decode(
              fromHex(hexToken),
            );
          },
        );
      },

      put: (key: string, value: string): Promise<void> => {
        return withVaultSpan(
          "Keychain put",
          spanAttributes("put", key),
          async () => {
            assertSafeKey(key);

            if (value === "") {
              // `security -i` cannot express an empty token, and an empty
              // value has nothing to leak, so argv is safe here.
              await runSecurity([
                "add-generic-password",
                "-s",
                parsed.service,
                "-a",
                key,
                "-X",
                "",
                "-U",
              ]);
              return;
            }

            const valueHex = toHex(new TextEncoder().encode(value));
            const line = [
              "add-generic-password",
              "-s",
              quoteInteractive(parsed.service),
              "-a",
              quoteInteractive(key),
              "-X",
              valueHex,
              "-U",
            ].join(" ") + "\n";

            if (line.length > MAX_INTERACTIVE_LINE) {
              const maxBytes = Math.max(
                0,
                Math.floor(
                  (MAX_INTERACTIVE_LINE - (line.length - valueHex.length)) / 2,
                ),
              );
              throw new Error(
                `secret is too large for the keychain write path: ` +
                  `${valueHex.length / 2} bytes, maximum ${maxBytes} bytes ` +
                  `with this service and key (security -i line limit)`,
              );
            }

            await runSecurity(["-i"], {
              stdin: line,
              redact: [value, valueHex],
            });
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
