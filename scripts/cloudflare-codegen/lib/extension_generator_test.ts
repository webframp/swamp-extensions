/**
 * Tests for the extension generator module.
 */

import { assertEquals } from "@std/assert";
import {
  generateReleaseNotes,
  generateSwampYaml,
} from "./extension_generator.ts";

// ---------------------------------------------------------------------------
// generateSwampYaml
//
// swamp mints `repoId` lazily into .swamp.yaml on first invocation in a
// directory — the generator never creates one. Regeneration must therefore
// carry forward whatever is already there, or it silently destroys the identity
// swamp uses for that repo. All 26 generated cloudflare extensions have a
// committed repoId that a naive regeneration would drop.
// ---------------------------------------------------------------------------

Deno.test("generateSwampYaml: preserves an existing repoId", () => {
  const existing =
    "repoVersion: 1\nrepoId: ad340ac8-27c9-44d1-a2f6-b4958dcf32a1\n";
  const result = generateSwampYaml(existing);

  assertEquals(
    result.includes("repoId: ad340ac8-27c9-44d1-a2f6-b4958dcf32a1"),
    true,
  );
  assertEquals(result.includes("repoVersion: 1"), true);
});

Deno.test("generateSwampYaml: emits no repoId for a new extension", () => {
  const result = generateSwampYaml(undefined);

  assertEquals(result.includes("repoId"), false);
  assertEquals(result.includes("repoVersion: 1"), true);
});

Deno.test("generateSwampYaml: a marker without a repoId stays without one", () => {
  const result = generateSwampYaml("repoVersion: 1\n");
  assertEquals(result.includes("repoId"), false);
});

Deno.test("generateSwampYaml: tolerates extra marker fields and comments", () => {
  // swamp writes additional keys over time (upgradedAt, tools, ...). Only the
  // repoId is carried forward — the rest are swamp's to re-add — but their
  // presence must not defeat the match.
  const existing = [
    "# Swamp repository marker",
    "repoVersion: 1",
    "tools:",
    "  - claude",
    "repoId: 11111111-2222-3333-4444-555555555555",
    'upgradedAt: "2026-07-26T15:33:08.695Z"',
    "",
  ].join("\n");

  const result = generateSwampYaml(existing);
  assertEquals(
    result.includes("repoId: 11111111-2222-3333-4444-555555555555"),
    true,
  );
});

Deno.test("generateSwampYaml: output is stable across repeated runs", () => {
  // Regeneration must be idempotent, or every run produces a spurious diff.
  const existing =
    "repoVersion: 1\nrepoId: ad340ac8-27c9-44d1-a2f6-b4958dcf32a1\n";
  const once = generateSwampYaml(existing);
  assertEquals(generateSwampYaml(once), once);
});

Deno.test("generateSwampYaml: ignores a repoId-like value in a comment", () => {
  const existing = "# repoId: not-the-real-one\nrepoVersion: 1\n";
  assertEquals(generateSwampYaml(existing).includes("repoId"), false);
});

// ---------------------------------------------------------------------------
// generateReleaseNotes
//
// Per-version notes are immutable on the swamp registry, so a wrong body is
// permanent. The default text claims an initial release, which is false for
// every version after the first — main.ts requires an explicit body when
// RELEASE_NOTES.md already exists.
// ---------------------------------------------------------------------------

const cfg = {
  name: "api-shield",
  description: "API Shield",
  pathPrefixes: ["/zones/{zone_id}/api_gateway"],
  scope: "zone" as const,
  labels: ["cloudflare"],
};

Deno.test("generateReleaseNotes: defaults to initial-release text", () => {
  const notes = generateReleaseNotes(cfg, "2026.07.19.1", 31);
  assertEquals(notes.startsWith("## 2026.07.19.1"), true);
  assertEquals(notes.includes("Initial code-generated release"), true);
  assertEquals(notes.includes("31 methods"), true);
});

Deno.test("generateReleaseNotes: an explicit body replaces the default", () => {
  const notes = generateReleaseNotes(
    cfg,
    "2026.07.27.1",
    31,
    "**Fixed:** methods referencing an undeclared path parameter.",
  );
  assertEquals(notes.includes("Initial code-generated release"), false);
  assertEquals(
    notes.includes(
      "**Fixed:** methods referencing an undeclared path parameter.",
    ),
    true,
  );
  assertEquals(notes.startsWith("## 2026.07.27.1"), true);
});

Deno.test("generateReleaseNotes: heading is always the version being published", () => {
  const notes = generateReleaseNotes(cfg, "2026.07.27.2", 31, "**Changed:** x");
  assertEquals(notes.split("\n")[0], "## 2026.07.27.2");
});

Deno.test("generateReleaseNotes: trailing whitespace in the body is trimmed", () => {
  const notes = generateReleaseNotes(
    cfg,
    "2026.07.27.1",
    31,
    "**Fixed:** y\n\n\n",
  );
  assertEquals(notes.endsWith("**Fixed:** y\n"), true);
});
