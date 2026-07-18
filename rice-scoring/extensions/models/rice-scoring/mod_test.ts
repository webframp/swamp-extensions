// RICE Scoring Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/rice-scoring");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model has all expected methods", () => {
  const methodNames = Object.keys(model.methods);
  assertEquals(methodNames.sort(), ["rank", "score"]);
});

Deno.test("model has all expected resources", () => {
  const resourceNames = Object.keys(model.resources);
  assertEquals(resourceNames, ["scores"]);
});

// =============================================================================
// GlobalArgs Schema Tests
// =============================================================================

Deno.test("globalArguments accepts empty object (all defaults)", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(
      result.data.reachDefinition,
      "Number of users/customers affected per quarter",
    );
    assertEquals(result.data.effortUnit, "person-weeks");
    assertEquals(result.data.scoringContext, "");
  }
});

Deno.test("globalArguments accepts custom values", () => {
  const result = model.globalArguments.safeParse({
    reachDefinition: "API requests per month",
    reachScale: "1-100 logarithmic",
    impactScale: "1-5 linear",
    effortUnit: "story points",
    confidenceGuidance: "Use t-shirt sizes mapped to decimals",
    scoringContext: "Platform team Q3 planning",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.reachDefinition, "API requests per month");
    assertEquals(result.data.effortUnit, "story points");
    assertEquals(result.data.scoringContext, "Platform team Q3 planning");
  }
});

// =============================================================================
// Argument Schema Validation Tests
// =============================================================================

Deno.test("score arguments accept valid items", () => {
  const result = model.methods.score.arguments.safeParse({
    items: [
      {
        name: "Feature A",
        description: "A new feature",
        reach: 5,
        impact: 2,
        confidence: 0.8,
        effort: 3,
        rationale: {
          reach: "Affects ~5000 users",
          impact: "High impact per user",
          confidence: "Strong signal from user research",
          effort: "3 person-weeks for full implementation",
        },
      },
    ],
  });
  assertEquals(result.success, true);
});

Deno.test("score arguments reject empty items array", () => {
  const result = model.methods.score.arguments.safeParse({ items: [] });
  assertEquals(result.success, false);
});

Deno.test("score arguments reject missing required fields", () => {
  const result = model.methods.score.arguments.safeParse({
    items: [{ name: "Incomplete" }],
  });
  assertEquals(result.success, false);
});

Deno.test("score arguments reject confidence > 1", () => {
  const result = model.methods.score.arguments.safeParse({
    items: [
      {
        name: "Bad confidence",
        description: "Testing",
        reach: 5,
        impact: 2,
        confidence: 1.5,
        effort: 3,
        rationale: {
          reach: "r",
          impact: "i",
          confidence: "c",
          effort: "e",
        },
      },
    ],
  });
  assertEquals(result.success, false);
});

Deno.test("score arguments reject effort below 0.1", () => {
  const result = model.methods.score.arguments.safeParse({
    items: [
      {
        name: "Zero effort",
        description: "Testing",
        reach: 5,
        impact: 2,
        confidence: 0.8,
        effort: 0,
        rationale: {
          reach: "r",
          impact: "i",
          confidence: "c",
          effort: "e",
        },
      },
    ],
  });
  assertEquals(result.success, false);
});

Deno.test("rank arguments accept empty object", () => {
  const result = model.methods.rank.arguments.safeParse({});
  assertEquals(result.success, true);
});

// =============================================================================
// Execute Tests
// =============================================================================

Deno.test("score method writes a resource with scored items", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });

  // deno-lint-ignore no-explicit-any
  await (model.methods.score.execute as any)(
    {
      items: [
        {
          name: "Feature A",
          description: "First feature",
          reach: 10,
          impact: 2,
          confidence: 0.8,
          effort: 4,
          rationale: {
            reach: "Entire user base",
            impact: "High value per user",
            confidence: "Data from survey",
            effort: "4 weeks with one engineer",
          },
        },
      ],
    },
    context,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "scores");

  const data = resources[0].data as {
    items: Array<{ name: string; score: number }>;
  };
  assertEquals(data.items.length, 1);
  assertEquals(data.items[0].name, "Feature A");
});

Deno.test("score method computes RICE score correctly (R*I*C/E)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });

  // R=10, I=3, C=0.5, E=2 => 10*3*0.5/2 = 7.5
  // deno-lint-ignore no-explicit-any
  await (model.methods.score.execute as any)(
    {
      items: [
        {
          name: "Exact score",
          description: "Testing computation",
          reach: 10,
          impact: 3,
          confidence: 0.5,
          effort: 2,
          rationale: {
            reach: "r",
            impact: "i",
            confidence: "c",
            effort: "e",
          },
        },
      ],
    },
    context,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    items: Array<{ score: number }>;
  };
  assertEquals(data.items[0].score, 7.5);
});

Deno.test("score method sorts items by score descending", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });

  // deno-lint-ignore no-explicit-any
  await (model.methods.score.execute as any)(
    {
      items: [
        {
          name: "Low priority",
          description: "Low score item",
          reach: 1,
          impact: 1,
          confidence: 0.5,
          effort: 5,
          rationale: {
            reach: "r",
            impact: "i",
            confidence: "c",
            effort: "e",
          },
        },
        {
          name: "High priority",
          description: "High score item",
          reach: 10,
          impact: 3,
          confidence: 1.0,
          effort: 1,
          rationale: {
            reach: "r",
            impact: "i",
            confidence: "c",
            effort: "e",
          },
        },
      ],
    },
    context,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    items: Array<{ name: string; score: number }>;
  };
  assertEquals(data.items[0].name, "High priority");
  assertEquals(data.items[1].name, "Low priority");
  assertEquals(data.items[0].score, 30);
  assertEquals(data.items[1].score, 0.1);
});

Deno.test("score method rejects empty items at execute level", async () => {
  const { context } = createModelTestContext({
    globalArgs: {},
  });

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => (model.methods.score.execute as any)({ items: [] }, context),
    Error,
    "At least one item is required",
  );
});

Deno.test("rank method reads and sorts stored scores", async () => {
  const { context, getLogsByLevel } = createModelTestContext({
    globalArgs: {},
    storedResources: {
      "scores-latest": {
        items: [
          {
            name: "B",
            description: "Second",
            reach: 5,
            impact: 1,
            confidence: 0.8,
            effort: 2,
            score: 2,
            rationale: {
              reach: "r",
              impact: "i",
              confidence: "c",
              effort: "e",
            },
            scoredAt: "2026-06-05T00:00:00Z",
          },
          {
            name: "A",
            description: "First",
            reach: 10,
            impact: 3,
            confidence: 1.0,
            effort: 1,
            score: 30,
            rationale: {
              reach: "r",
              impact: "i",
              confidence: "c",
              effort: "e",
            },
            scoredAt: "2026-06-05T00:00:00Z",
          },
        ],
      },
    },
  });

  // deno-lint-ignore no-explicit-any
  const result = await (model.methods.rank.execute as any)(
    {} as Record<string, never>,
    context,
  );

  assertEquals(result.dataHandles, []);

  const infoLogs = getLogsByLevel("info");
  assertEquals(infoLogs.length, 2);
  // First log should be the highest-scored item (A with score 30)
  assertEquals(infoLogs[0].message.includes("A"), true);
  assertEquals(infoLogs[0].message.includes("#1"), true);
});

Deno.test("rank method throws when no scores exist", async () => {
  const { context } = createModelTestContext({
    globalArgs: {},
  });

  // deno-lint-ignore no-explicit-any
  const rankExec = model.methods.rank.execute as any;
  await assertRejects(
    () => rankExec({} as Record<string, never>, context),
    Error,
    "No scores found",
  );
});
