// DDD Guidance Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertMatch, assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// =============================================================================
// Helper
// =============================================================================

function createDddContext(
  storedResources: Record<string, Record<string, unknown>> = {},
) {
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: {
        projectContext:
          "E-commerce platform with separate checkout and inventory teams",
        teamSize: "medium",
        existingPatterns: ["microservices", "event-driven"],
      },
      storedResources,
    });

  return { context, getWrittenResources, getLogsByLevel };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/ddd-guidance");
});

Deno.test("model has correct version", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model exports globalArguments schema", () => {
  assertExists(model.globalArguments);
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.contextMap);
  assertExists(model.resources.domainGlossary);
  assertExists(model.resources.boundaries);
});

Deno.test("model defines expected methods", () => {
  assertExists(model.methods.contexts);
  assertExists(model.methods.language);
  assertExists(model.methods.boundaries);
  assertExists(model.methods.revisit);
});

// =============================================================================
// Method Existence Tests
// =============================================================================

Deno.test("contexts method has execute function", () => {
  assertEquals(typeof model.methods.contexts.execute, "function");
});

Deno.test("language method has execute function", () => {
  assertEquals(typeof model.methods.language.execute, "function");
});

Deno.test("boundaries method has execute function", () => {
  assertEquals(typeof model.methods.boundaries.execute, "function");
});

// =============================================================================
// Resource Configuration Tests
// =============================================================================

Deno.test("contextMap resource has infinite lifetime with high GC", () => {
  assertEquals(model.resources.contextMap.lifetime, "infinite");
  assertEquals(model.resources.contextMap.garbageCollection, 20);
});

Deno.test("domainGlossary resource has infinite lifetime with high GC", () => {
  assertEquals(model.resources.domainGlossary.lifetime, "infinite");
  assertEquals(model.resources.domainGlossary.garbageCollection, 20);
});

Deno.test("boundaries resource has infinite lifetime with high GC", () => {
  assertEquals(model.resources.boundaries.lifetime, "infinite");
  assertEquals(model.resources.boundaries.garbageCollection, 20);
});

// =============================================================================
// Argument Schema Validation Tests
// =============================================================================

Deno.test("contexts accepts empty object", () => {
  const result = model.methods.contexts.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("contexts accepts optional focus string", () => {
  const result = model.methods.contexts.arguments.safeParse({
    focus: "checkout subsystem",
  });
  assertEquals(result.success, true);
});

Deno.test("language accepts empty object", () => {
  const result = model.methods.language.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("language accepts optional context string", () => {
  const result = model.methods.language.arguments.safeParse({
    context: "order-management",
  });
  assertEquals(result.success, true);
});

Deno.test("boundaries accepts empty object", () => {
  const result = model.methods.boundaries.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("boundaries accepts optional context string", () => {
  const result = model.methods.boundaries.arguments.safeParse({
    context: "inventory",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// GlobalArgs Schema Tests
// =============================================================================

Deno.test("globalArgs requires projectContext", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArgs accepts projectContext only (others have defaults)", () => {
  const result = model.globalArguments.safeParse({
    projectContext: "Platform team managing API gateway",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.teamSize, "small");
    assertEquals(result.data.existingPatterns, []);
  }
});

Deno.test("globalArgs accepts full input", () => {
  const result = model.globalArguments.safeParse({
    projectContext: "Fintech payment processing",
    teamSize: "large",
    existingPatterns: ["CQRS", "event-sourcing", "microservices"],
  });
  assertEquals(result.success, true);
});

Deno.test("globalArgs rejects invalid teamSize", () => {
  const result = model.globalArguments.safeParse({
    projectContext: "test",
    teamSize: "huge",
  });
  assertEquals(result.success, false);
});

// =============================================================================
// Execute Tests — contexts
// =============================================================================

Deno.test("contexts writes contextMap resource", async () => {
  const { context, getWrittenResources } = createDddContext();

  const result = await model.methods.contexts.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "contextMap");

  const data = resources[0].data as {
    contexts: unknown[];
    relationships: unknown[];
    overloadedTerms: unknown[];
    discoveredAt: string;
  };
  assertExists(data.discoveredAt);
  assertEquals(Array.isArray(data.contexts), true);
  assertEquals(Array.isArray(data.relationships), true);
  assertEquals(Array.isArray(data.overloadedTerms), true);
});

Deno.test("contexts passes focus to logger", async () => {
  const { context, getLogsByLevel } = createDddContext();

  await model.methods.contexts.execute(
    { focus: "payments" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as { focus: string };
  assertEquals(meta.focus, "payments");
});

// =============================================================================
// Execute Tests — language
// =============================================================================

Deno.test("language writes domainGlossary resource", async () => {
  const { context, getWrittenResources } = createDddContext({
    current: {
      contexts: [
        {
          name: "order-management",
          purpose: "Handle orders",
          ubiquitousLanguageTerms: [],
          coreSubdomain: true,
        },
      ],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  const result = await model.methods.language.execute(
    { context: "order-management" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "domainGlossary");

  const data = resources[0].data as {
    entries: unknown[];
    updatedAt: string;
  };
  assertExists(data.updatedAt);
  assertEquals(Array.isArray(data.entries), true);
});

Deno.test("language uses first context when none specified", async () => {
  const { context, getLogsByLevel } = createDddContext({
    current: {
      contexts: [
        {
          name: "billing",
          purpose: "Handle billing",
          ubiquitousLanguageTerms: [],
          coreSubdomain: false,
        },
        {
          name: "shipping",
          purpose: "Handle shipping",
          ubiquitousLanguageTerms: [],
          coreSubdomain: false,
        },
      ],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  await model.methods.language.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  const meta = logs[0].args[0] as { context: string };
  assertEquals(meta.context, "billing");
});

Deno.test("language handles gracefully when no context map exists", async () => {
  const { context, getWrittenResources } = createDddContext();

  const result = await model.methods.language.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("language handles malformed glossary without entries field", async () => {
  const { context, getWrittenResources } = createDddContext({
    current: {
      contexts: [{
        name: "orders",
        purpose: "test",
        ubiquitousLanguageTerms: [],
        coreSubdomain: true,
      }],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
    glossary: {
      updatedAt: "2026-06-01T00:00:00Z",
    },
  });

  const result = await model.methods.language.execute(
    { context: "orders" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  const resources = getWrittenResources();
  const data = resources[0].data as { entries: unknown[] };
  assertEquals(data.entries.length, 0);
});

Deno.test("language preserves existing glossary entries", async () => {
  const { context, getWrittenResources } = createDddContext({
    current: {
      contexts: [{
        name: "orders",
        purpose: "test",
        ubiquitousLanguageTerms: [],
        coreSubdomain: true,
      }],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
    glossary: {
      entries: [
        {
          term: "Order",
          context: "orders",
          definition: "A purchase request",
          examples: ["Cart checkout"],
          relatedTerms: ["LineItem"],
        },
      ],
      updatedAt: "2026-06-01T00:00:00Z",
    },
  });

  await model.methods.language.execute(
    { context: "orders" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as { entries: Array<{ term: string }> };
  assertEquals(data.entries.length, 1);
  assertEquals(data.entries[0].term, "Order");
});

// =============================================================================
// Execute Tests — boundaries
// =============================================================================

Deno.test("boundaries writes boundaries resource", async () => {
  const { context, getWrittenResources } = createDddContext({
    current: {
      contexts: [
        {
          name: "inventory",
          purpose: "Track stock",
          ubiquitousLanguageTerms: [],
          coreSubdomain: false,
        },
      ],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  const result = await model.methods.boundaries.execute(
    { context: "inventory" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "boundaries");

  const data = resources[0].data as {
    aggregates: unknown[];
    eventualConsistencyRules: unknown[];
    discoveredAt: string;
  };
  assertExists(data.discoveredAt);
  assertEquals(Array.isArray(data.aggregates), true);
  assertEquals(Array.isArray(data.eventualConsistencyRules), true);
});

Deno.test("boundaries uses context argument for instance name", async () => {
  const { context } = createDddContext({
    current: {
      contexts: [
        {
          name: "payments",
          purpose: "Process payments",
          ubiquitousLanguageTerms: [],
          coreSubdomain: true,
        },
      ],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  const result = await model.methods.boundaries.execute(
    { context: "payments" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertEquals(result.dataHandles[0].name, "payments");
});

Deno.test("boundaries throws when no context map exists", async () => {
  const { context } = createDddContext();

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => model.methods.boundaries.execute({}, context as any),
    Error,
    "No bounded contexts discovered yet",
  );
});

Deno.test("boundaries throws when contexts array is empty", async () => {
  const { context } = createDddContext({
    current: {
      contexts: [],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => model.methods.boundaries.execute({}, context as any),
    Error,
    "No bounded contexts discovered yet",
  );
});

Deno.test("boundaries throws when specified context not in map", async () => {
  const { context } = createDddContext({
    current: {
      contexts: [{
        name: "orders",
        purpose: "Manage orders",
        ubiquitousLanguageTerms: [],
        coreSubdomain: true,
      }],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  await assertRejects(
    () =>
      // deno-lint-ignore no-explicit-any
      model.methods.boundaries.execute({ context: "payments" }, context as any),
    Error,
    'Context "payments" not found in context map',
  );
});

Deno.test("boundaries uses first context from map when none specified", async () => {
  const { context, getLogsByLevel } = createDddContext({
    current: {
      contexts: [
        {
          name: "fulfillment",
          purpose: "Ship orders",
          ubiquitousLanguageTerms: [],
          coreSubdomain: false,
        },
      ],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  await model.methods.boundaries.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  const meta = logs[0].args[0] as { context: string };
  assertEquals(meta.context, "fulfillment");
});

// =============================================================================
// Execute Tests — revisit
// =============================================================================

Deno.test("revisit method has execute function", () => {
  assertEquals(typeof model.methods.revisit.execute, "function");
});

Deno.test("revisit accepts empty object (defaults to all)", () => {
  const result = model.methods.revisit.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.scope, "all");
  }
});

Deno.test("revisit accepts valid scope values", () => {
  for (const scope of ["all", "contexts", "language", "boundaries"]) {
    const result = model.methods.revisit.arguments.safeParse({ scope });
    assertEquals(result.success, true);
  }
});

Deno.test("revisit rejects invalid scope", () => {
  const result = model.methods.revisit.arguments.safeParse({
    scope: "everything",
  });
  assertEquals(result.success, false);
});

Deno.test("revisit throws when no context map exists", async () => {
  const { context } = createDddContext();

  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => model.methods.revisit.execute({ scope: "all" }, context as any),
    Error,
    "No existing resources found",
  );
});

Deno.test("revisit logs context names and timestamps", async () => {
  const { context, getLogsByLevel } = createDddContext({
    current: {
      contexts: [
        {
          name: "orders",
          purpose: "Manage orders",
          ubiquitousLanguageTerms: [],
          coreSubdomain: true,
        },
        {
          name: "shipping",
          purpose: "Ship things",
          ubiquitousLanguageTerms: [],
          coreSubdomain: false,
        },
      ],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-01T00:00:00Z",
    },
    glossary: {
      entries: [],
      updatedAt: "2026-06-02T00:00:00Z",
    },
  });

  await model.methods.revisit.execute(
    { scope: "contexts" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const logs = getLogsByLevel("info");
  assertEquals(logs.length, 1);
  const meta = logs[0].args[0] as {
    scope: string;
    contexts: string;
    discoveredAt: string;
  };
  assertEquals(meta.scope, "contexts");
  assertEquals(meta.contexts, "orders, shipping");
  assertEquals(meta.discoveredAt, "2026-06-01T00:00:00Z");
});

Deno.test("revisit returns empty dataHandles", async () => {
  const { context } = createDddContext({
    current: {
      contexts: [{
        name: "test",
        purpose: "test",
        ubiquitousLanguageTerms: [],
        coreSubdomain: false,
      }],
      relationships: [],
      overloadedTerms: [],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  const result = await model.methods.revisit.execute(
    { scope: "all" },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertEquals(result.dataHandles, []);
});
