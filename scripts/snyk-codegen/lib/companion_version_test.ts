// SPDX-License-Identifier: Apache-2.0
import { assertEquals } from "@std/assert";
import { computeModelVersion } from "./upgrades.ts";

const MODEL_EXISTING =
  `export const model = {\n  version: "2026.08.26.2",\n  upgrades: [],\n};\n`;
const MODEL_CANDIDATE =
  `export const model = {\n  version: "0.0.0.0",\n  upgrades: [],\n};\n`;

async function check(
  api: string,
  test: string,
  options: { omitTestFile?: boolean } = {},
) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/model.ts`, MODEL_EXISTING);
    await Deno.writeTextFile(`${dir}/api.ts`, "export const a = 1;\n");
    if (!options.omitTestFile) {
      await Deno.writeTextFile(`${dir}/model_test.ts`, "export const t = 1;\n");
    }
    return await computeModelVersion(
      `${dir}/model.ts`,
      "2026.08.28",
      MODEL_CANDIDATE,
      "0.0.0.0",
      [
        { path: `${dir}/api.ts`, candidate: api },
        { path: `${dir}/model_test.ts`, candidate: test },
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("companions identical to disk -> unchanged, keeps the version", async () => {
  const res = await check("export const a = 1;\n", "export const t = 1;\n");
  assertEquals(res.status, "unchanged");
  assertEquals(res.version, "2026.08.26.2");
});

Deno.test("a changed helper bumps the version though the model source is identical", async () => {
  const res = await check("export const a = 2;\n", "export const t = 1;\n");
  assertEquals(res.status, "changed");
  assertEquals(res.version, "2026.08.28.1");
});

Deno.test("a changed test file bumps the version though the model source is identical", async () => {
  const res = await check("export const a = 1;\n", "export const t = 2;\n");
  assertEquals(res.status, "changed");
  assertEquals(res.version, "2026.08.28.1");
});

Deno.test("a companion missing on disk counts as a change", async () => {
  const res = await check("export const a = 1;\n", "export const t = 1;\n", {
    omitTestFile: true,
  });
  assertEquals(res.status, "changed");
});
