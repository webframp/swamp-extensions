// SPDX-License-Identifier: Apache-2.0
import { assertEquals } from "@std/assert";
import { assertThrows } from "@std/assert";
import {
  buildUpgradesBlock,
  compareCalVer,
  computeModelVersion,
  computeUpgradesBlock,
  extractExistingUpgrades,
  lastToVersion,
  stripUpgradesBlock,
} from "./upgrades.ts";

const SAMPLE = `export const model = {
  type: "@webframp/cloudflare/dns",
  version: "2026.08.26.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.24.1",
      description: "Added optional durationMs, collectedBy, and fetchedAt",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.2",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {},
};
`;

Deno.test("extractExistingUpgrades preserves hand-written entries verbatim", () => {
  const entries = extractExistingUpgrades(SAMPLE);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].includes('toVersion: "2026.08.24.1"'), true);
  assertEquals(
    entries[1].includes("Label metadata update, no schema changes"),
    true,
  );
});

Deno.test("extractExistingUpgrades returns [] when no upgrades block", () => {
  assertEquals(extractExistingUpgrades("export const model = {};"), []);
});

Deno.test("lastToVersion reads the final entry's toVersion", () => {
  const entries = extractExistingUpgrades(SAMPLE);
  assertEquals(lastToVersion(entries), "2026.08.26.2");
  assertEquals(lastToVersion([]), null);
});

Deno.test("stripUpgradesBlock removes the whole upgrades array", () => {
  const stripped = stripUpgradesBlock(SAMPLE);
  assertEquals(stripped.includes("upgrades:"), false);
  assertEquals(stripped.includes("resources:"), true);
});

Deno.test("computeUpgradesBlock: new -> empty array", () => {
  assertEquals(
    computeUpgradesBlock("new", "2026.08.28.1", undefined),
    "  upgrades: [],",
  );
});

Deno.test("computeUpgradesBlock: unchanged -> re-emits existing verbatim, no new entry", () => {
  const block = computeUpgradesBlock("unchanged", "2026.08.26.2", SAMPLE);
  // Both existing entries preserved, no third appended.
  assertEquals((block.match(/toVersion:/g) ?? []).length, 2);
  assertEquals(
    block.includes("Label metadata update, no schema changes"),
    true,
  );
});

Deno.test("computeUpgradesBlock: changed -> appends one identity entry, keeps history", () => {
  const block = computeUpgradesBlock("changed", "2026.08.28.1", SAMPLE);
  const toVersions = block.match(/toVersion:/g) ?? [];
  assertEquals(toVersions.length, 3); // 2 preserved + 1 appended
  // Prior descriptions intact — not relabelled.
  assertEquals(block.includes('toVersion: "2026.08.24.1"'), true);
  assertEquals(block.includes('toVersion: "2026.08.26.2"'), true);
  assertEquals(block.includes('toVersion: "2026.08.28.1"'), true);
  assertEquals(block.includes("no migration required"), true);
});

Deno.test("computeUpgradesBlock: unchanged with lagging last toVersion appends a catch-up entry", () => {
  // Model version advanced (e.g. manual bump) but chain's last entry lags.
  const block = computeUpgradesBlock("unchanged", "2026.08.28.9", SAMPLE);
  const toVersions = block.match(/toVersion:/g) ?? [];
  assertEquals(toVersions.length, 3);
  assertEquals(block.includes('toVersion: "2026.08.28.9"'), true);
});

Deno.test("compareCalVer orders by segment", () => {
  assertEquals(compareCalVer("2026.08.26.4", "2026.08.27.1") < 0, true);
  assertEquals(compareCalVer("2026.08.27.1", "2026.08.26.4") > 0, true);
  assertEquals(compareCalVer("2026.08.26.2", "2026.08.26.2"), 0);
  assertEquals(compareCalVer("2026.08.26.10", "2026.08.26.2") > 0, true);
});

Deno.test("computeUpgradesBlock: changed with backwards version throws (HIGH guard)", () => {
  // SAMPLE's last toVersion is 2026.08.26.2. A forced/lower version must not
  // be appended after it — that would be a backwards chain.
  assertThrows(
    () => computeUpgradesBlock("changed", "2026.08.26.1", SAMPLE),
    Error,
    "backwards upgrade chain",
  );
});

Deno.test("computeUpgradesBlock: changed with equal version throws (HIGH guard)", () => {
  assertThrows(
    () => computeUpgradesBlock("changed", "2026.08.26.2", SAMPLE),
    Error,
    "strictly greater",
  );
});

Deno.test("computeUpgradesBlock: unchanged catch-up with backwards version throws (HIGH guard)", () => {
  // Forcing a version that differs from the tail but is lower must also throw,
  // not silently append a backwards entry.
  assertThrows(
    () => computeUpgradesBlock("unchanged", "2026.08.25.9", SAMPLE),
    Error,
    "backwards upgrade chain",
  );
});

Deno.test("buildUpgradesBlock with no entries yields empty array literal", () => {
  assertEquals(buildUpgradesBlock([], null), "  upgrades: [\n  ],");
});

Deno.test("computeModelVersion: missing file -> new at .1", async () => {
  const res = await computeModelVersion(
    "/nonexistent/model.ts",
    "2026.08.28",
    'export const model = { version: "0.0.0.0" };',
    "0.0.0.0",
  );
  assertEquals(res.status, "new");
  assertEquals(res.version, "2026.08.28.1");
});

Deno.test("computeModelVersion: identical content -> unchanged, keeps version", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    const existing =
      `export const model = {\n  version: "2026.08.26.2",\n  upgrades: [],\n};\n`;
    await Deno.writeTextFile(tmp, existing);
    // Candidate identical except the placeholder version.
    const candidate =
      `export const model = {\n  version: "0.0.0.0",\n  upgrades: [],\n};\n`;
    const res = await computeModelVersion(
      tmp,
      "2026.08.28",
      candidate,
      "0.0.0.0",
    );
    assertEquals(res.status, "unchanged");
    assertEquals(res.version, "2026.08.26.2");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("computeModelVersion: changed content -> bumps (new date -> .1)", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    const existing =
      `export const model = {\n  version: "2026.08.26.2",\n  upgrades: [],\n  foo: 1,\n};\n`;
    await Deno.writeTextFile(tmp, existing);
    const candidate =
      `export const model = {\n  version: "0.0.0.0",\n  upgrades: [],\n  foo: 2,\n};\n`;
    const res = await computeModelVersion(
      tmp,
      "2026.08.28",
      candidate,
      "0.0.0.0",
    );
    assertEquals(res.status, "changed");
    assertEquals(res.version, "2026.08.28.1");
  } finally {
    await Deno.remove(tmp);
  }
});
