import { assertEquals } from "@std/assert";
import { classify, MATRIX_LIMIT } from "./classify.ts";
import { discoverExtensions } from "./discover.ts";
import { buildDependents, expandDependents } from "./deps.ts";
import { FIXTURE_ROOT, fixtureFs, manifest } from "./fixtures.ts";

const exts = discoverExtensions(FIXTURE_ROOT, fixtureFs());
const dependents = buildDependents(exts);
const expand = (seed: Iterable<string>) => expandDependents(seed, dependents);
const ALL = exts.length;

// ---------------------------------------------------------------------------
// Fail-safe cases. Under-selecting ships untested code, so every ambiguity
// resolves to the full matrix.
// ---------------------------------------------------------------------------

Deno.test("classify: an uncomputable diff selects the full matrix", () => {
  // A shallow clone, a missing base ref, or a force-push must never be read as
  // "nothing changed".
  const r = classify(null, exts, expand);
  assertEquals(r.scope, "full");
  assertEquals(r.extensions.length, ALL);
  assertEquals(r.reason, "diff could not be computed");
});

Deno.test("classify: an empty diff selects the full matrix", () => {
  const r = classify([], exts, expand);
  assertEquals(r.scope, "full");
  assertEquals(r.extensions.length, ALL);
});

Deno.test("classify: a workflow change selects the full matrix", () => {
  const r = classify([".github/workflows/ci.yml"], exts, expand);
  assertEquals(r.scope, "full");
  assertEquals(r.extensions.length, ALL);
  assertEquals(r.reason.includes(".github/workflows/ci.yml"), true);
});

Deno.test("classify: a root config change selects the full matrix", () => {
  assertEquals(classify(["CLAUDE.md"], exts, expand).scope, "full");
  assertEquals(
    classify(["scripts/ci-discover/main.ts"], exts, expand).scope,
    "full",
  );
});

Deno.test("classify: one shared file among extension changes still forces full", () => {
  // The shared file could affect anything, so the extension signal is moot.
  const r = classify(
    ["aws/inventory/manifest.yaml", ".github/workflows/ci.yml"],
    exts,
    expand,
  );
  assertEquals(r.scope, "full");
});

// ---------------------------------------------------------------------------
// Scoped selection
// ---------------------------------------------------------------------------

Deno.test("classify: a single-extension change scopes to it plus dependents", () => {
  const r = classify(
    ["aws/inventory/extensions/models/inventory.ts"],
    exts,
    expand,
  );
  assertEquals(r.scope, "scoped");
  assertEquals(r.extensions, [
    "aws/cost-audit",
    "aws/drift-state",
    "aws/inventory",
    "aws/ops",
    "aws/terraform-drift",
  ]);
  assertEquals(r.reason.includes("+4 dependent"), true);
});

Deno.test("classify: a leaf change scopes to exactly one extension", () => {
  const r = classify(["aws/ops/README.md"], exts, expand);
  assertEquals(r.scope, "scoped");
  assertEquals(r.extensions, ["aws/ops"]);
  assertEquals(r.reason.includes("no dependents"), true);
});

Deno.test("classify: longest-prefix wins for a nested extension", () => {
  // `cloudflare/kv/...` must attribute to cloudflare/kv, not to the top-level
  // `cloudflare` that also prefixes it.
  const r = classify(
    ["cloudflare/kv/extensions/models/cloudflare/kv.ts"],
    exts,
    expand,
  );
  assertEquals(r.extensions, ["cloudflare/kv"]);
});

Deno.test("classify: a top-level change does not pull in nested siblings", () => {
  const r = classify(["cloudflare/manifest.yaml"], exts, expand);
  assertEquals(r.extensions, ["cloudflare"]);
});

Deno.test("classify: a path equal to the extension dir attributes correctly", () => {
  const r = classify(["aws/ops"], exts, expand);
  assertEquals(r.extensions, ["aws/ops"]);
});

Deno.test("classify: a directory that merely shares a prefix is not attributed", () => {
  // "aws/inventory-extras" is not inside "aws/inventory" despite the prefix.
  const r = classify(["aws/inventory-extras/thing.ts"], exts, expand);
  assertEquals(r.scope, "full");
});

Deno.test("classify: changes across several extensions union correctly", () => {
  const r = classify(
    ["aws/ops/README.md", "cloudflare/kv/README.md", "system/README.md"],
    exts,
    expand,
  );
  assertEquals(r.scope, "scoped");
  assertEquals(r.extensions, ["aws/ops", "cloudflare/kv", "sre", "system"]);
});

// ---------------------------------------------------------------------------
// Matrix output contract
// ---------------------------------------------------------------------------

Deno.test("classify: output is JSON-serializable and within the matrix limit", () => {
  for (const changed of [null, [], ["aws/inventory/x.ts"]]) {
    const r = classify(changed, exts, expand);
    const round = JSON.parse(JSON.stringify(r.extensions));
    assertEquals(Array.isArray(round), true);
    assertEquals(round.length <= MATRIX_LIMIT, true);
    for (const e of round) assertEquals(typeof e, "string");
  }
});

Deno.test("classify: overflow is flagged rather than silently truncated", () => {
  // 137 extensions fit today. If the repo ever exceeds the platform cap, the
  // right answer is to fail loudly -- truncating the matrix would mean silently
  // not testing the dropped extensions, the exact failure this design avoids.
  const many: Record<string, string> = {};
  for (let i = 0; i < MATRIX_LIMIT + 20; i++) {
    many[`ext${String(i).padStart(4, "0")}/manifest.yaml`] = manifest(
      `@x/e${i}`,
    );
  }
  const big = discoverExtensions(FIXTURE_ROOT, fixtureFs(many));
  assertEquals(big.length, MATRIX_LIMIT + 20);

  const dep = buildDependents(big);
  const r = classify(null, big, (s) => expandDependents(s, dep));

  assertEquals(r.overflow, true);
  // Nothing dropped -- the caller sees the true count and can fail on it.
  assertEquals(r.extensions.length, MATRIX_LIMIT + 20);
});

Deno.test("classify: overflow is false for a normal-sized selection", () => {
  assertEquals(classify(null, exts, expand).overflow, false);
  assertEquals(classify(["aws/ops/README.md"], exts, expand).overflow, false);
});

// ---------------------------------------------------------------------------
// Real repository
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

Deno.test("classify: real repo — full matrix fits the platform limit", () => {
  const real = discoverExtensions(REPO_ROOT);
  const dep = buildDependents(real);
  const r = classify(null, real, (s) => expandDependents(s, dep));
  assertEquals(r.scope, "full");
  assertEquals(
    r.extensions.length <= MATRIX_LIMIT,
    true,
    `${r.extensions.length} extensions exceeds the ${MATRIX_LIMIT}-job cap`,
  );
});

Deno.test("classify: real repo — a docs-only change forces the full matrix", () => {
  const real = discoverExtensions(REPO_ROOT);
  const dep = buildDependents(real);
  const r = classify(
    ["docs/plans/2026-07-27-ci-workflow-optimization.md"],
    real,
    (s) => expandDependents(s, dep),
  );
  // docs/ is outside every extension, so it is treated as shared infrastructure.
  assertEquals(r.scope, "full");
});
