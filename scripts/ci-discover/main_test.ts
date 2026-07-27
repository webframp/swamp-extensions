import { assertEquals } from "@std/assert";
import { parseArgs } from "./main.ts";

// ---------------------------------------------------------------------------
// Argument parsing.
//
// The library tests cover the discovery and classification logic, but not the
// CLI surface — which is where the first real bug in this script lived: `deno
// task discover -- --changed-from x` forwards a literal `--`, and rejecting it
// made the documented invocation form fail outright.
// ---------------------------------------------------------------------------

Deno.test("parseArgs: tolerates the bare -- that deno task forwards", () => {
  const opts = parseArgs(["--", "--changed-from", "/tmp/x"]);
  assertEquals(opts.changedFrom, "/tmp/x");
});

Deno.test("parseArgs: tolerates -- appearing more than once", () => {
  const opts = parseArgs(["--", "--diff-base", "main", "--"]);
  assertEquals(opts.diffBase, "main");
});

Deno.test("parseArgs: reads each supported flag", () => {
  const opts = parseArgs([
    "--repo-root",
    "/repo",
    "--diff-base",
    "origin/main",
    "--github-output",
  ]);
  assertEquals(opts.repoRoot, "/repo");
  assertEquals(opts.diffBase, "origin/main");
  assertEquals(opts.githubOutput, true);
});

Deno.test("parseArgs: defaults to no scoping and no github output", () => {
  const opts = parseArgs([]);
  assertEquals(opts.diffBase, undefined);
  assertEquals(opts.changedFrom, undefined);
  assertEquals(opts.githubOutput, false);
  assertEquals(opts.exclude, []);
});

Deno.test("parseArgs: --exclude parses comma-separated directories", () => {
  const opts = parseArgs(["--exclude", "datastore/valkey,foo/bar"]);
  assertEquals(opts.exclude, ["datastore/valkey", "foo/bar"]);
});

Deno.test("parseArgs: --exclude trims whitespace and drops empties", () => {
  const opts = parseArgs(["--exclude", " datastore/valkey , , foo/bar "]);
  assertEquals(opts.exclude, ["datastore/valkey", "foo/bar"]);
});

Deno.test("parseArgs: --exclude with single value", () => {
  const opts = parseArgs(["--exclude", "datastore/valkey"]);
  assertEquals(opts.exclude, ["datastore/valkey"]);
});

Deno.test("parseArgs: default repo root is the repository, not the script dir", () => {
  // main.ts lives at scripts/ci-discover/, so the root is two levels up. Getting
  // this wrong is how the cloudflare generator silently wrote 26 extensions into
  // scripts/cloudflare-codegen/cloudflare/ and reported success.
  const opts = parseArgs([]);
  assertEquals(opts.repoRoot.endsWith("/scripts/ci-discover"), false);
  assertEquals(opts.repoRoot.endsWith("/scripts"), false);
});
