// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for change detection beyond the model source: bumpVersion and
 * changedFiles.
 */

import { assertEquals } from "@std/assert";
import { bumpVersion, changedFiles, computeModelVersion } from "./upgrades.ts";

Deno.test("bumpVersion: same date increments the micro segment", () => {
  assertEquals(bumpVersion("2026.10.07.3", "2026.10.07"), "2026.10.07.4");
});

Deno.test("bumpVersion: a new date restarts at .1", () => {
  assertEquals(bumpVersion("2026.09.25.7", "2026.10.07"), "2026.10.07.1");
});

Deno.test("changedFiles: identical, reformatted, differing and missing files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/same.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(`${dir}/fmt.ts`, "export const   b =   2\n");
    await Deno.writeTextFile(`${dir}/diff.ts`, "export const c = 3;\n");
    await Deno.writeTextFile(`${dir}/notes.md`, "# Title\n\ntext\n");
    const changed = await changedFiles([
      {
        path: `${dir}/same.ts`,
        candidate: "export const a = 1;\n",
        suffix: ".ts",
      },
      // Whitespace-only differences are normalized by deno fmt: not a change.
      {
        path: `${dir}/fmt.ts`,
        candidate: "export const b = 2;\n",
        suffix: ".ts",
      },
      {
        path: `${dir}/diff.ts`,
        candidate: "export const c = 4;\n",
        suffix: ".ts",
      },
      {
        path: `${dir}/notes.md`,
        candidate: "# Title\n\ntext\n",
        suffix: ".md",
      },
      { path: `${dir}/missing.ts`, candidate: "export {};\n", suffix: ".ts" },
    ]);
    assertEquals(changed, [`${dir}/diff.ts`, `${dir}/missing.ts`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("changedFiles: a changed helper is detected even when the model source is unchanged", async () => {
  // Regression: computeModelVersion compares only the model source, so a
  // change confined to api.ts used to be reported "unchanged" and skipped.
  const dir = await Deno.makeTempDir();
  try {
    const model =
      `export const model = {\n  version: "2026.08.26.2",\n  upgrades: [],\n};\n`;
    await Deno.writeTextFile(`${dir}/model.ts`, model);
    await Deno.writeTextFile(`${dir}/api.ts`, "export const t = 1;\n");
    const res = await computeModelVersion(
      `${dir}/model.ts`,
      "2026.10.07",
      model.replace("2026.08.26.2", "0.0.0.0"),
      "0.0.0.0",
    );
    assertEquals(res.status, "unchanged");
    const changed = await changedFiles([
      {
        path: `${dir}/api.ts`,
        candidate: "export const t = 2;\n",
        suffix: ".ts",
      },
    ]);
    assertEquals(changed.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
