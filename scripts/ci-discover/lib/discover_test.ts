import { assertEquals } from "@std/assert";
import {
  discoverExtensions,
  nameToDir,
  parseManifestDependencies,
  parseManifestName,
  stripVersion,
} from "./discover.ts";
import { FIXTURE_ROOT, fixtureFs, manifest } from "./fixtures.ts";

const fs = fixtureFs();
const found = discoverExtensions(FIXTURE_ROOT, fs);
const dirs = found.map((e) => e.dir);

// ---------------------------------------------------------------------------
// Two-level discovery
// ---------------------------------------------------------------------------

Deno.test("discover: finds both a top-level extension and its nested children", () => {
  // A single-level scan finds 36 of this repo's 137 extensions. The nested ones
  // are where the CI coverage gap lived.
  assertEquals(dirs.includes("cloudflare"), true);
  assertEquals(dirs.includes("cloudflare/kv"), true);
  assertEquals(dirs.includes("cloudflare/r2"), true);
});

Deno.test("discover: output is sorted and free of duplicates", () => {
  assertEquals([...dirs].sort((a, b) => a.localeCompare(b)), dirs);
  assertEquals(new Set(dirs).size, dirs.length);
});

Deno.test("discover: skips dotted directories", () => {
  // .swamp/ holds a data cache that contains manifest.yaml files.
  assertEquals(dirs.some((d) => d.startsWith(".")), false);
  assertEquals(
    found.some((e) => e.name === "@webframp/should-not-appear"),
    false,
  );
});

Deno.test("discover: does not descend into an extension's own tree", () => {
  // aws/inventory/extensions/models/manifest.yaml belongs to aws/inventory. It is
  // excluded by depth (4 levels) rather than by treating aws/inventory as a leaf
  // — leaf-stopping would also drop cloudflare/kv, a real sibling extension.
  assertEquals(found.some((e) => e.name === "@webframp/nested"), false);
  assertEquals(dirs.includes("aws/inventory"), true);
  assertEquals(dirs.includes("aws/inventory/extensions/models"), false);
});

// ---------------------------------------------------------------------------
// Name / directory mapping
// ---------------------------------------------------------------------------

Deno.test("discover: name does not have to mirror the directory", () => {
  const map = nameToDir(found);
  // Real cases. Deriving a directory from a dependency specifier would miss all
  // three, which is why resolution goes through this map.
  assertEquals(map.get("@webframp/nix"), "driver/nix");
  assertEquals(map.get("@webframp/pass"), "vault/pass");
  assertEquals(map.get("@webframp/postgres-datastore"), "datastore/postgres");
});

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

Deno.test("parseManifestName: reads a quoted name", () => {
  assertEquals(parseManifestName(manifest("@webframp/x")), "@webframp/x");
});

Deno.test("parseManifestName: reads an unquoted name", () => {
  assertEquals(parseManifestName("name: @webframp/x\n"), "@webframp/x");
});

Deno.test("parseManifestName: returns null when absent", () => {
  assertEquals(parseManifestName('version: "1"\n'), null);
});

Deno.test("parseManifestName: ignores a name key nested under another block", () => {
  // Only a top-level `name:` counts; an indented one belongs to something else.
  assertEquals(parseManifestName("models:\n  name: nope\n"), null);
});

Deno.test("parseManifestDependencies: reads every entry", () => {
  const deps = parseManifestDependencies(
    manifest("@webframp/a", [
      "@webframp/aws/logs@2026.07.21.1",
      "@webframp/aws/inventory@2026.07.21.1",
    ]),
  );
  assertEquals(deps, [
    "@webframp/aws/logs@2026.07.21.1",
    "@webframp/aws/inventory@2026.07.21.1",
  ]);
});

Deno.test("parseManifestDependencies: empty when the block is absent", () => {
  assertEquals(parseManifestDependencies(manifest("@webframp/a")), []);
});

Deno.test("parseManifestDependencies: stops at the next top-level key", () => {
  // Without a terminator the `labels:` list below would be absorbed as deps.
  const deps = parseManifestDependencies(
    manifest("@webframp/a", ["@webframp/b@1.0.0"]),
  );
  assertEquals(deps, ["@webframp/b@1.0.0"]);
  assertEquals(deps.some((d) => d === "fixture"), false);
});

// ---------------------------------------------------------------------------
// Version stripping
// ---------------------------------------------------------------------------

Deno.test("stripVersion: splits on the LAST @, not the first", () => {
  // The leading @ of the collective makes a first-@ split wrong.
  assertEquals(
    stripVersion("@webframp/aws/inventory@2026.07.21.1"),
    "@webframp/aws/inventory",
  );
});

Deno.test("stripVersion: leaves a specifier with no version alone", () => {
  assertEquals(
    stripVersion("@webframp/aws/inventory"),
    "@webframp/aws/inventory",
  );
});

// ---------------------------------------------------------------------------
// Real repository smoke test
//
// Asserts invariants that hold regardless of how many extensions exist, so the
// test does not need editing every time one is added.
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

Deno.test("discover: real repo — every result has a manifest and a name", () => {
  const real = discoverExtensions(REPO_ROOT);
  assertEquals(real.length > 100, true);
  for (const e of real) {
    assertEquals(e.name.startsWith("@"), true, `${e.dir} has name ${e.name}`);
    assertEquals(e.dir.startsWith("."), false, `${e.dir} is dotted`);
  }
});

Deno.test("discover: real repo — no duplicate directories or names", () => {
  const real = discoverExtensions(REPO_ROOT);
  assertEquals(new Set(real.map((e) => e.dir)).size, real.length);
  assertEquals(new Set(real.map((e) => e.name)).size, real.length);
});

Deno.test("discover: real repo — finds nested extensions, not just top level", () => {
  const real = discoverExtensions(REPO_ROOT).map((e) => e.dir);
  // If this ever collapses to top-level only, coverage silently drops to ~36.
  assertEquals(real.filter((d) => d.includes("/")).length > 50, true);
});
