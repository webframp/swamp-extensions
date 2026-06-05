// Swamp Adoption Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// =============================================================================
// Helper
// =============================================================================

function createAdoptionContext(
  storedResources: Record<string, Record<string, unknown>> = {},
) {
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: {
        userContext: "SRE team managing AWS and GitLab",
        currentTools: ["terraform", "ansible"],
        painPoints: ["drift detection", "secret rotation"],
        swampExperience: "installed",
      },
      storedResources,
    });

  return { context, getWrittenResources, getLogsByLevel };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/swamp-adoption");
});

Deno.test("model has correct version", () => {
  assertEquals(model.version, "2026.06.05.1");
});

Deno.test("model exports globalArguments schema", () => {
  assertExists(model.globalArguments);
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.landscape);
  assertExists(model.resources.extensionDesign);
  assertExists(model.resources.scaffold);
});

Deno.test("model defines expected methods", () => {
  assertExists(model.methods.discover);
  assertExists(model.methods.design);
  assertExists(model.methods.scaffold);
  assertExists(model.methods.next);
});

// =============================================================================
// Method Existence Tests
// =============================================================================

Deno.test("discover method has execute function", () => {
  assertEquals(typeof model.methods.discover.execute, "function");
});

Deno.test("design method has execute function", () => {
  assertEquals(typeof model.methods.design.execute, "function");
});

Deno.test("scaffold method has execute function", () => {
  assertEquals(typeof model.methods.scaffold.execute, "function");
});

Deno.test("next method has execute function", () => {
  assertEquals(typeof model.methods.next.execute, "function");
});

// =============================================================================
// Resource Existence Tests
// =============================================================================

Deno.test("landscape resource has correct lifetime", () => {
  assertEquals(model.resources.landscape.lifetime, "infinite");
  assertEquals(model.resources.landscape.garbageCollection, 5);
});

Deno.test("extensionDesign resource has correct lifetime", () => {
  assertEquals(model.resources.extensionDesign.lifetime, "infinite");
  assertEquals(model.resources.extensionDesign.garbageCollection, 10);
});

Deno.test("scaffold resource has 24h lifetime", () => {
  assertEquals(model.resources.scaffold.lifetime, "24h");
  assertEquals(model.resources.scaffold.garbageCollection, 3);
});

// =============================================================================
// Argument Schema Validation Tests
// =============================================================================

Deno.test("discover accepts empty object", () => {
  const result = model.methods.discover.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("design accepts optional system string", () => {
  const result = model.methods.design.arguments.safeParse({
    system: "gitlab",
  });
  assertEquals(result.success, true);
});

Deno.test("design accepts empty object (system is optional)", () => {
  const result = model.methods.design.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("scaffold accepts optional outputFormat enum", () => {
  const result = model.methods.scaffold.arguments.safeParse({
    outputFormat: "resource",
  });
  assertEquals(result.success, true);
});

Deno.test("scaffold accepts stdout outputFormat", () => {
  const result = model.methods.scaffold.arguments.safeParse({
    outputFormat: "stdout",
  });
  assertEquals(result.success, true);
});

Deno.test("scaffold rejects invalid outputFormat", () => {
  const result = model.methods.scaffold.arguments.safeParse({
    outputFormat: "invalid",
  });
  assertEquals(result.success, false);
});

Deno.test("next accepts empty object", () => {
  const result = model.methods.next.arguments.safeParse({});
  assertEquals(result.success, true);
});

// =============================================================================
// GlobalArgs Schema Tests
// =============================================================================

Deno.test("globalArgs requires userContext", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArgs accepts userContext only (others have defaults)", () => {
  const result = model.globalArguments.safeParse({
    userContext: "Platform engineer",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.currentTools, []);
    assertEquals(result.data.painPoints, []);
    assertEquals(result.data.swampExperience, "none");
  }
});

Deno.test("globalArgs accepts full input", () => {
  const result = model.globalArguments.safeParse({
    userContext: "SRE managing AWS",
    currentTools: ["terraform", "kubectl"],
    painPoints: ["drift", "secrets"],
    swampExperience: "built-something",
  });
  assertEquals(result.success, true);
});

Deno.test("globalArgs rejects invalid swampExperience", () => {
  const result = model.globalArguments.safeParse({
    userContext: "test",
    swampExperience: "expert",
  });
  assertEquals(result.success, false);
});

// =============================================================================
// Execute Tests
// =============================================================================

Deno.test("discover writes landscape resource", async () => {
  const { context, getWrittenResources } = createAdoptionContext();

  const result = await model.methods.discover.execute(
    {} as Record<string, never>,
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "landscape");

  const data = resources[0].data as {
    systems: unknown[];
    dataFlows: unknown[];
    suggestedFirstExtension: string;
    reasoning: string;
    discoveredAt: string;
  };
  assertExists(data.suggestedFirstExtension);
  assertExists(data.reasoning);
  assertExists(data.discoveredAt);
  assertEquals(Array.isArray(data.systems), true);
  assertEquals(Array.isArray(data.dataFlows), true);
});

Deno.test("design writes extensionDesign resource", async () => {
  const { context, getWrittenResources } = createAdoptionContext({
    current: {
      systems: [{ name: "gitlab", type: "saas", interactions: [] }],
      dataFlows: [],
      suggestedFirstExtension: "gitlab",
      reasoning: "High pain, high frequency",
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  const result = await model.methods.design.execute(
    { system: "gitlab" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "extensionDesign");

  const data = resources[0].data as {
    name: string;
    description: string;
    labels: string[];
  };
  assertEquals(data.name, "@webframp/gitlab");
  assertEquals(data.labels.includes("gitlab"), true);
});

Deno.test("design uses suggestedFirstExtension when system not provided", async () => {
  const { context, getWrittenResources } = createAdoptionContext({
    current: {
      systems: [],
      dataFlows: [],
      suggestedFirstExtension: "cloudflare",
      reasoning: "Suggested by pain matrix",
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  // deno-lint-ignore no-explicit-any
  const result = await model.methods.design.execute({}, context as any);

  assertExists(result.dataHandles);
  const resources = getWrittenResources();

  const data = resources[0].data as { name: string };
  assertEquals(data.name, "@webframp/cloudflare");
});

Deno.test("design handles gracefully when no landscape exists", async () => {
  const { context, getWrittenResources } = createAdoptionContext();

  // deno-lint-ignore no-explicit-any
  const result = await model.methods.design.execute({}, context as any);

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  const data = resources[0].data as { name: string };
  assertEquals(data.name, "@webframp/unknown-system");
});

Deno.test("scaffold writes scaffold resource with files array", async () => {
  const { context, getWrittenResources } = createAdoptionContext({
    "current-design": {
      name: "@webframp/my-service",
      description: "Manages my-service resources",
      globalArguments: [],
      methods: [],
      resources: [],
      dependencies: [],
      vaultNeeded: false,
      labels: ["my-service"],
      designedAt: "2026-06-05T00:00:00Z",
    },
  });

  const result = await model.methods.scaffold.execute(
    { outputFormat: "resource" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "scaffold");

  const data = resources[0].data as {
    files: Array<{ path: string; content: string }>;
    generatedFrom: string;
    generatedAt: string;
  };
  assertEquals(Array.isArray(data.files), true);
  assertEquals(data.files.length, 4);
  assertEquals(data.generatedFrom, "@webframp/my-service");
  assertExists(data.generatedAt);

  // Verify expected file paths
  const paths = data.files.map((f) => f.path);
  assertEquals(paths.includes("manifest.yaml"), true);
  assertEquals(paths.includes("deno.json"), true);
  assertEquals(
    paths.some((p) => p.endsWith("mod.ts")),
    true,
  );
  assertEquals(
    paths.some((p) => p.endsWith("mod_test.ts")),
    true,
  );
});

Deno.test("scaffold stdout format returns empty dataHandles", async () => {
  const { context, getWrittenResources, getLogsByLevel } =
    createAdoptionContext({
      "current-design": {
        name: "@webframp/example",
        description: "Example extension",
      },
    });

  const result = await model.methods.scaffold.execute(
    { outputFormat: "stdout" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertEquals(result.dataHandles.length, 0);
  assertEquals(getWrittenResources().length, 0);

  const logs = getLogsByLevel("info");
  assertEquals(logs.length > 0, true);
});

Deno.test("scaffold throws when no design exists", async () => {
  const { context } = createAdoptionContext();

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () =>
      model.methods.scaffold.execute(
        { outputFormat: "resource" },
        context as any,
      ),
    Error,
    "No extension design found",
  );
});

Deno.test("next reads resources and logs advisory output", async () => {
  const { context, getWrittenResources, getLogsByLevel } =
    createAdoptionContext({
      current: {
        systems: [
          { name: "gitlab", type: "saas", interactions: [] },
          { name: "aws", type: "infrastructure", interactions: [] },
        ],
        dataFlows: [],
        suggestedFirstExtension: "gitlab",
        reasoning: "test",
        discoveredAt: "2026-06-05T00:00:00Z",
      },
      "current-design": {
        name: "@webframp/gitlab",
        description: "GitLab extension",
      },
    });

  // deno-lint-ignore no-explicit-any
  const result = await model.methods.next.execute({} as any, context as any);

  assertEquals(result.dataHandles.length, 0);
  assertEquals(getWrittenResources().length, 0);

  const logs = getLogsByLevel("info");
  assertEquals(logs.length > 0, true);
});

Deno.test("next throws when no landscape exists", async () => {
  const { context } = createAdoptionContext();

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => model.methods.next.execute({} as any, context as any),
    Error,
    "No landscape found",
  );
});
