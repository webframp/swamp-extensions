/**
 * In-memory fixture tree for discovery tests.
 *
 * Shapes are copied from the real repository rather than invented, including the
 * cases most likely to break a naive implementation:
 *   - two-level nesting (`cloudflare/kv` beside a top-level `cloudflare`)
 *   - names that do not mirror their directory (`driver/nix` -> `@webframp/nix`)
 *   - a real dependency fan-in (`aws/inventory` has four dependents)
 *   - a dotted directory that must not register as an extension
 *
 * @module
 */

import type { FsLike } from "./discover.ts";

/** Build a manifest body with the given name and optional dependencies. */
export function manifest(name: string, deps: string[] = []): string {
  const depBlock = deps.length > 0
    ? `dependencies:\n${deps.map((d) => `  - "${d}"`).join("\n")}\n`
    : "";
  return `manifestVersion: 1
name: "${name}"
version: "2026.07.27.1"
description: |
  Fixture.
${depBlock}labels:
  - fixture
platforms:
  - linux-x86_64
`;
}

/** Paths mirroring the real repo, keyed by path relative to the fake root. */
export const FIXTURE_FILES: Record<string, string> = {
  // Top-level extension that also has nested children — the shape that makes
  // longest-prefix attribution necessary.
  "cloudflare/manifest.yaml": manifest("@webframp/cloudflare"),
  "cloudflare/kv/manifest.yaml": manifest("@webframp/cloudflare/kv"),
  "cloudflare/r2/manifest.yaml": manifest("@webframp/cloudflare/r2"),

  // Real dependency fan-in: four dependents on aws/inventory.
  "aws/inventory/manifest.yaml": manifest("@webframp/aws/inventory"),
  "aws/networking/manifest.yaml": manifest("@webframp/aws/networking"),
  "aws/logs/manifest.yaml": manifest("@webframp/aws/logs"),
  "aws/ops/manifest.yaml": manifest("@webframp/aws/ops", [
    "@webframp/aws/logs@2026.07.21.1",
    "@webframp/aws/inventory@2026.07.21.1",
    "@webframp/aws/networking@2026.07.21.1",
  ]),
  "aws/cost-audit/manifest.yaml": manifest("@webframp/aws/cost-audit", [
    "@webframp/aws/networking@2026.07.21.1",
    "@webframp/aws/inventory@2026.07.21.1",
  ]),
  "aws/drift-state/manifest.yaml": manifest("@webframp/aws/drift-state", [
    "@webframp/aws/inventory@2026.07.21.1",
  ]),
  "aws/terraform-drift/manifest.yaml": manifest(
    "@webframp/aws/terraform-drift",
    [
      "@webframp/terraform@2026.07.18.1",
      "@webframp/aws/inventory@2026.07.21.1",
    ],
  ),
  "terraform/manifest.yaml": manifest("@webframp/terraform"),

  // Names that do not mirror their directory.
  "driver/nix/manifest.yaml": manifest("@webframp/nix"),
  "vault/pass/manifest.yaml": manifest("@webframp/pass"),
  "datastore/postgres/manifest.yaml": manifest("@webframp/postgres-datastore"),

  // A transitive chain: sre -> system, and nothing depends on sre.
  "system/manifest.yaml": manifest("@webframp/system"),
  "sre/manifest.yaml": manifest("@webframp/sre", [
    "@webframp/system@2026.07.18.1",
  ]),

  // Depends on something published elsewhere — must not blow up.
  "external-consumer/manifest.yaml": manifest("@webframp/external-consumer", [
    "@someone-else/thing@1.0.0",
  ]),

  // Must NOT be discovered: dotted dir, and a manifest nested inside an
  // extension's own tree.
  ".swamp/cache/manifest.yaml": manifest("@webframp/should-not-appear"),
  "aws/inventory/extensions/models/manifest.yaml": manifest("@webframp/nested"),
};

/** FsLike over FIXTURE_FILES. */
export function fixtureFs(
  files: Record<string, string> = FIXTURE_FILES,
): FsLike {
  const norm = (p: string) => p.replace(/^\/*/, "").replace(/\/+$/, "");

  return {
    exists(path) {
      return Object.hasOwn(files, norm(path));
    },
    readTextFile(path) {
      const key = norm(path);
      if (!Object.hasOwn(files, key)) throw new Error(`no such file: ${key}`);
      return files[key];
    },
    readDir(path) {
      const prefix = norm(path);
      const seen = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (prefix && !key.startsWith(prefix + "/")) continue;
        const rest = prefix ? key.slice(prefix.length + 1) : key;
        const head = rest.split("/")[0];
        if (!head) continue;
        // A directory if there is more path after the first segment.
        seen.set(head, rest.includes("/"));
      }
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
  };
}

/** Root path used with fixtureFs — contents are keyed relative to it. */
export const FIXTURE_ROOT = "";
