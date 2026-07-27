import { assertEquals } from "@std/assert";
import { discoverExtensions, type Extension } from "./discover.ts";
import { buildDependents, expandDependents } from "./deps.ts";
import { FIXTURE_ROOT, fixtureFs, manifest } from "./fixtures.ts";

const found = discoverExtensions(FIXTURE_ROOT, fixtureFs());
const dependents = buildDependents(found);
const expand = (seed: Iterable<string>) => expandDependents(seed, dependents);

// ---------------------------------------------------------------------------
// The case that motivates the whole module
// ---------------------------------------------------------------------------

Deno.test("expand: a change to aws/inventory selects all four dependents", () => {
  // Real fan-in. Without this, scoping tests aws/inventory alone and reports
  // green while aws/ops, cost-audit, drift-state and terraform-drift are never
  // built against the change.
  assertEquals(expand(["aws/inventory"]), [
    "aws/cost-audit",
    "aws/drift-state",
    "aws/inventory",
    "aws/ops",
    "aws/terraform-drift",
  ]);
});

Deno.test("expand: a leaf with no dependents selects only itself", () => {
  assertEquals(expand(["aws/ops"]), ["aws/ops"]);
});

Deno.test("expand: seeds are always included in the result", () => {
  const out = expand(["cloudflare/kv"]);
  assertEquals(out.includes("cloudflare/kv"), true);
});

Deno.test("expand: multiple seeds union their dependents without duplication", () => {
  const out = expand(["aws/inventory", "terraform"]);
  assertEquals(new Set(out).size, out.length);
  assertEquals(out.includes("aws/terraform-drift"), true);
  assertEquals(out.includes("aws/ops"), true);
});

Deno.test("expand: output is sorted for deterministic matrix ordering", () => {
  const out = expand(["aws/inventory", "system"]);
  assertEquals([...out].sort((a, b) => a.localeCompare(b)), out);
});

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

Deno.test("buildDependents: resolves specifiers through the name map", () => {
  // aws/ops depends on @webframp/aws/inventory, which lives at aws/inventory.
  assertEquals(dependents.get("aws/inventory")?.has("aws/ops"), true);
});

Deno.test("buildDependents: ignores dependencies published outside this repo", () => {
  // external-consumer depends on @someone-else/thing, which cannot be built here.
  assertEquals(dependents.has("@someone-else/thing"), false);
  assertEquals(expand(["external-consumer"]), ["external-consumer"]);
});

Deno.test("buildDependents: an extension with no dependents has no edge", () => {
  assertEquals(dependents.has("aws/ops"), false);
});

// ---------------------------------------------------------------------------
// Transitivity and cycle safety
// ---------------------------------------------------------------------------

function synthetic(files: Record<string, string>): Extension[] {
  return discoverExtensions(FIXTURE_ROOT, fixtureFs(files));
}

Deno.test("expand: follows a transitive chain", () => {
  // c depends on b, b depends on a. Touching a must select all three.
  const exts = synthetic({
    "a/manifest.yaml": manifest("@x/a"),
    "b/manifest.yaml": manifest("@x/b", ["@x/a@1.0.0"]),
    "c/manifest.yaml": manifest("@x/c", ["@x/b@1.0.0"]),
  });
  const dep = buildDependents(exts);
  assertEquals(expandDependents(["a"], dep), ["a", "b", "c"]);
});

Deno.test("expand: terminates on a dependency cycle", () => {
  // No cycle exists today, but nothing prevents one. A CI script that hangs is
  // worse than one that over-selects.
  const exts = synthetic({
    "a/manifest.yaml": manifest("@x/a", ["@x/b@1.0.0"]),
    "b/manifest.yaml": manifest("@x/b", ["@x/a@1.0.0"]),
  });
  const dep = buildDependents(exts);
  assertEquals(expandDependents(["a"], dep), ["a", "b"]);
});

Deno.test("expand: tolerates a self-referencing dependency", () => {
  const exts = synthetic({
    "a/manifest.yaml": manifest("@x/a", ["@x/a@1.0.0"]),
  });
  const dep = buildDependents(exts);
  assertEquals(expandDependents(["a"], dep), ["a"]);
});

Deno.test("expand: a diamond selects each node once", () => {
  const exts = synthetic({
    "base/manifest.yaml": manifest("@x/base"),
    "left/manifest.yaml": manifest("@x/left", ["@x/base@1.0.0"]),
    "right/manifest.yaml": manifest("@x/right", ["@x/base@1.0.0"]),
    "top/manifest.yaml": manifest("@x/top", [
      "@x/left@1.0.0",
      "@x/right@1.0.0",
    ]),
  });
  const dep = buildDependents(exts);
  assertEquals(expandDependents(["base"], dep), [
    "base",
    "left",
    "right",
    "top",
  ]);
});

Deno.test("expand: an empty seed selects nothing", () => {
  assertEquals(expand([]), []);
});

// ---------------------------------------------------------------------------
// Real repository
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

Deno.test("buildDependents: real repo — every local dependency resolves", () => {
  const real = discoverExtensions(REPO_ROOT);
  const names = new Set(real.map((e) => e.name));
  const unresolved: string[] = [];

  for (const e of real) {
    for (const spec of e.dependencies) {
      const bare = spec.slice(0, spec.lastIndexOf("@"));
      // Only @webframp/* is expected to resolve locally.
      if (bare.startsWith("@webframp/") && !names.has(bare)) {
        unresolved.push(`${e.dir} -> ${bare}`);
      }
    }
  }

  assertEquals(unresolved, [], `unresolved local dependencies: ${unresolved}`);
});

Deno.test("expand: real repo — aws/inventory has dependents", () => {
  const real = discoverExtensions(REPO_ROOT);
  const dep = buildDependents(real);
  const out = expandDependents(["aws/inventory"], dep);
  // Guards the specific regression: if expansion silently stops working, a
  // change to the most-depended-on extension would test only itself.
  assertEquals(out.length > 1, true, `expected dependents, got ${out}`);
  assertEquals(out.includes("aws/inventory"), true);
});
