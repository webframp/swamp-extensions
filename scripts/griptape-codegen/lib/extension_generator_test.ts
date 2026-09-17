/**
 * Tests for the extension generator module.
 */

import { assertEquals } from "@std/assert";
import { generateReleaseNotes } from "./extension_generator.ts";

// ---------------------------------------------------------------------------
// generateReleaseNotes
//
// RELEASE_NOTES.md is a changelog: every regeneration must prepend the new
// entry above whatever history already exists, or a repeat `deno task
// generate` silently erases every prior release's notes.
// ---------------------------------------------------------------------------

const cfg = {
  name: "threads",
  description: "Griptape Cloud Threads",
  pathPrefixes: ["/api/threads"],
  labels: ["griptape"],
};

Deno.test("generateReleaseNotes: defaults to initial-release text when there is no existing file", () => {
  const notes = generateReleaseNotes(cfg, "2026.08.29.1", 7);
  assertEquals(notes.startsWith("## 2026.08.29.1"), true);
  assertEquals(notes.includes("Initial code-generated release"), true);
  assertEquals(notes.includes("7 methods"), true);
});

Deno.test("generateReleaseNotes: prepends the new entry above existing history", () => {
  const existing = "## 2026.08.29.1\n\n**Added:** Initial release.\n";
  const notes = generateReleaseNotes(
    cfg,
    "2026.09.17.1",
    7,
    "Regenerated from updated API spec.",
    existing,
  );

  assertEquals(notes.startsWith("## 2026.09.17.1"), true);
  assertEquals(notes.includes("Regenerated from updated API spec."), true);
  // Prior history must survive verbatim, not be replaced.
  assertEquals(notes.includes("## 2026.08.29.1"), true);
  assertEquals(notes.includes("**Added:** Initial release."), true);
  // New entry comes first.
  assertEquals(
    notes.indexOf("2026.09.17.1") < notes.indexOf("2026.08.29.1"),
    true,
  );
});

Deno.test("generateReleaseNotes: repeated regeneration accumulates history rather than replacing it", () => {
  let notes = generateReleaseNotes(cfg, "2026.08.29.1", 7);
  notes = generateReleaseNotes(
    cfg,
    "2026.09.15.1",
    7,
    "Dependency bump.",
    notes,
  );
  notes = generateReleaseNotes(
    cfg,
    "2026.09.17.1",
    7,
    "Regenerated from updated API spec.",
    notes,
  );

  assertEquals(notes.includes("2026.08.29.1"), true);
  assertEquals(notes.includes("2026.09.15.1"), true);
  assertEquals(notes.includes("2026.09.17.1"), true);
});
