// DDD Guidance Model Tests
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

const SAMPLE_CONTEXT = {
  name: "order-management",
  purpose: "Handle customer orders end-to-end",
  ownerTeam: "checkout-team",
  ubiquitousLanguageTerms: ["Order", "LineItem", "Cart"],
  coreSubdomain: true,
};

const SAMPLE_RELATIONSHIP = {
  upstream: "order-management",
  downstream: "shipping",
  type: "customer-supplier" as const,
  description: "Shipping reacts to order placement",
};

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

Deno.test("contexts rejects empty object (requires contexts, relationships, overloadedTerms)", () => {
  const result = model.methods.contexts.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("contexts accepts valid full input", () => {
  const result = model.methods.contexts.arguments.safeParse({
    contexts: [SAMPLE_CONTEXT],
    relationships: [SAMPLE_RELATIONSHIP],
    overloadedTerms: [],
  });
  assertEquals(result.success, true);
});

Deno.test("contexts accepts optional focus with required fields", () => {
  const result = model.methods.contexts.arguments.safeParse({
    focus: "checkout subsystem",
    contexts: [SAMPLE_CONTEXT],
    relationships: [],
    overloadedTerms: [],
  });
  assertEquals(result.success, true);
});

Deno.test("contexts rejects when contexts array is empty", () => {
  const result = model.methods.contexts.arguments.safeParse({
    contexts: [],
    relationships: [],
    overloadedTerms: [],
  });
  assertEquals(result.success, false);
});

Deno.test("language rejects empty object (requires context and entries)", () => {
  const result = model.methods.language.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("language accepts valid full input", () => {
  const result = model.methods.language.arguments.safeParse({
    context: "order-management",
    entries: [{
      term: "Order",
      definition: "A purchase request from a customer",
      examples: ["Cart checkout creates an Order"],
      relatedTerms: ["LineItem", "Cart"],
    }],
  });
  assertEquals(result.success, true);
});

Deno.test("language rejects when entries array is empty", () => {
  const result = model.methods.language.arguments.safeParse({
    context: "order-management",
    entries: [],
  });
  assertEquals(result.success, false);
});

Deno.test("language accepts optional overloadedTerms", () => {
  const result = model.methods.language.arguments.safeParse({
    context: "order-management",
    entries: [{
      term: "Order",
      definition: "A purchase request",
      examples: [],
      relatedTerms: [],
    }],
    overloadedTerms: [{
      term: "Order",
      meanings: [
        { context: "order-management", definition: "A purchase request" },
        { context: "shipping", definition: "A shipment instruction" },
      ],
    }],
  });
  assertEquals(result.success, true);
});

Deno.test("boundaries rejects empty object (requires context and aggregates)", () => {
  const result = model.methods.boundaries.arguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("boundaries accepts valid full input", () => {
  const result = model.methods.boundaries.arguments.safeParse({
    context: "order-management",
    aggregates: [{
      name: "Order",
      rootEntity: "Order",
      entities: ["LineItem"],
      valueObjects: ["Money", "Address"],
      invariants: [{
        description: "Order total must equal sum of line items",
        transactional: true,
        rationale: "Financial consistency",
      }],
      identityReferences: [{
        target: "Customer",
        reason: "Order belongs to customer",
      }],
      eventsTrigger: ["OrderPlaced", "OrderCancelled"],
    }],
    eventualConsistencyRules: [{
      trigger: "OrderPlaced",
      affectedAggregates: ["Inventory"],
      tolerableDelay: "5 seconds",
      rationale: "Stock reservation can lag slightly",
    }],
  });
  assertEquals(result.success, true);
});

Deno.test("boundaries rejects when aggregates array is empty", () => {
  const result = model.methods.boundaries.arguments.safeParse({
    context: "order-management",
    aggregates: [],
    eventualConsistencyRules: [],
  });
  assertEquals(result.success, false);
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

Deno.test("contexts writes contextMap resource with provided data", async () => {
  const { context, getWrittenResources } = createDddContext();

  const result = await model.methods.contexts.execute(
    {
      contexts: [SAMPLE_CONTEXT],
      relationships: [SAMPLE_RELATIONSHIP],
      overloadedTerms: [{
        term: "Order",
        meanings: [
          { context: "order-management", definition: "A purchase request" },
          { context: "shipping", definition: "A shipment instruction" },
        ],
      }],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "contextMap");

  const data = resources[0].data as {
    contexts: Array<{ name: string }>;
    relationships: Array<{ upstream: string }>;
    overloadedTerms: Array<{ term: string }>;
    discoveredAt: string;
  };
  assertExists(data.discoveredAt);
  assertEquals(data.contexts.length, 1);
  assertEquals(data.contexts[0].name, "order-management");
  assertEquals(data.relationships.length, 1);
  assertEquals(data.overloadedTerms.length, 1);
  assertEquals(data.overloadedTerms[0].term, "Order");
});

Deno.test("contexts passes focus to logger", async () => {
  const { context, getLogsByLevel } = createDddContext();

  await model.methods.contexts.execute(
    {
      focus: "payments",
      contexts: [SAMPLE_CONTEXT],
      relationships: [],
      overloadedTerms: [],
    },
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

Deno.test("language writes domainGlossary with entries from args", async () => {
  const { context, getWrittenResources } = createDddContext();

  const result = await model.methods.language.execute(
    {
      context: "order-management",
      entries: [{
        term: "Order",
        definition: "A purchase request from a customer",
        examples: ["Cart checkout creates an Order"],
        relatedTerms: ["LineItem"],
      }],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "domainGlossary");

  const data = resources[0].data as {
    entries: Array<{ term: string; context: string; definition: string }>;
    updatedAt: string;
  };
  assertExists(data.updatedAt);
  assertEquals(data.entries.length, 1);
  assertEquals(data.entries[0].term, "Order");
  assertEquals(data.entries[0].context, "order-management");
});

Deno.test("language merges new entries with existing glossary", async () => {
  const { context, getWrittenResources } = createDddContext({
    glossary: {
      entries: [
        {
          term: "Order",
          context: "order-management",
          definition: "A purchase request",
          examples: ["old example"],
          relatedTerms: [],
        },
        {
          term: "Shipment",
          context: "shipping",
          definition: "A delivery unit",
          examples: [],
          relatedTerms: [],
        },
      ],
      updatedAt: "2026-06-01T00:00:00Z",
    },
  });

  await model.methods.language.execute(
    {
      context: "order-management",
      entries: [{
        term: "Order",
        definition: "Updated definition",
        examples: ["new example"],
        relatedTerms: ["Cart"],
      }],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    entries: Array<{ term: string; context: string; definition: string }>;
  };
  assertEquals(data.entries.length, 2);
  const order = data.entries.find((e) => e.term === "Order")!;
  assertEquals(order.definition, "Updated definition");
  const shipment = data.entries.find((e) => e.term === "Shipment")!;
  assertEquals(shipment.context, "shipping");
});

Deno.test("language updates contextMap overloadedTerms when provided", async () => {
  const { context, getWrittenResources } = createDddContext({
    current: {
      contexts: [SAMPLE_CONTEXT],
      relationships: [],
      overloadedTerms: [{
        term: "Status",
        meanings: [
          { context: "billing", definition: "Payment state" },
        ],
      }],
      discoveredAt: "2026-06-05T00:00:00Z",
    },
  });

  await model.methods.language.execute(
    {
      context: "order-management",
      entries: [{
        term: "Status",
        definition: "Order lifecycle state",
        examples: ["pending, confirmed, shipped"],
        relatedTerms: [],
      }],
      overloadedTerms: [{
        term: "Status",
        meanings: [
          { context: "order-management", definition: "Order lifecycle state" },
        ],
      }],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const contextMapWrite = resources.find(
    (r: { specName: string }) => r.specName === "contextMap",
  );
  assertExists(contextMapWrite);
  const cmData = contextMapWrite.data as {
    overloadedTerms: Array<{
      term: string;
      meanings: Array<{ context: string; definition: string }>;
    }>;
  };
  assertEquals(cmData.overloadedTerms.length, 1);
  assertEquals(cmData.overloadedTerms[0].meanings.length, 2);
  assertExists(
    cmData.overloadedTerms[0].meanings.find((m) => m.context === "billing"),
  );
  assertExists(
    cmData.overloadedTerms[0].meanings.find(
      (m) => m.context === "order-management",
    ),
  );
});

Deno.test("language handles gracefully when no existing glossary", async () => {
  const { context, getWrittenResources } = createDddContext();

  const result = await model.methods.language.execute(
    {
      context: "new-context",
      entries: [{
        term: "Widget",
        definition: "A thing",
        examples: [],
        relatedTerms: [],
      }],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(getWrittenResources().length, 1);
  const data = getWrittenResources()[0].data as { entries: unknown[] };
  assertEquals(data.entries.length, 1);
});

// =============================================================================
// Execute Tests — boundaries
// =============================================================================

Deno.test("boundaries writes boundaries resource with provided data", async () => {
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
    {
      context: "inventory",
      aggregates: [{
        name: "StockItem",
        rootEntity: "StockItem",
        entities: [],
        valueObjects: ["Quantity"],
        invariants: [{
          description: "Stock cannot go negative",
          transactional: true,
          rationale: "Physical constraint",
        }],
        identityReferences: [],
        eventsTrigger: ["StockReserved"],
      }],
      eventualConsistencyRules: [],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "boundaries");
  assertEquals(resources[0].instanceName, "inventory");

  const data = resources[0].data as {
    aggregates: Array<{ name: string; context: string }>;
    eventualConsistencyRules: unknown[];
    discoveredAt: string;
  };
  assertExists(data.discoveredAt);
  assertEquals(data.aggregates.length, 1);
  assertEquals(data.aggregates[0].name, "StockItem");
  assertEquals(data.aggregates[0].context, "inventory");
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
    {
      context: "payments",
      aggregates: [{
        name: "Payment",
        rootEntity: "Payment",
        entities: [],
        valueObjects: ["Money"],
        invariants: [{
          description: "Payment amount must be positive",
          transactional: true,
          rationale: "Business rule",
        }],
        identityReferences: [],
        eventsTrigger: ["PaymentConfirmed"],
      }],
      eventualConsistencyRules: [],
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  assertEquals(result.dataHandles[0].name, "payments");
});

Deno.test("boundaries throws when no context map exists", async () => {
  const { context } = createDddContext();

  await assertRejects(
    () =>
      model.methods.boundaries.execute(
        {
          context: "anything",
          aggregates: [{
            name: "X",
            rootEntity: "X",
            entities: [],
            valueObjects: [],
            invariants: [{
              description: "x",
              transactional: true,
              rationale: "x",
            }],
            identityReferences: [],
            eventsTrigger: [],
          }],
          eventualConsistencyRules: [],
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
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
    () =>
      model.methods.boundaries.execute(
        {
          context: "orders",
          aggregates: [{
            name: "X",
            rootEntity: "X",
            entities: [],
            valueObjects: [],
            invariants: [{
              description: "x",
              transactional: true,
              rationale: "x",
            }],
            identityReferences: [],
            eventsTrigger: [],
          }],
          eventualConsistencyRules: [],
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
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
      model.methods.boundaries.execute(
        {
          context: "payments",
          aggregates: [{
            name: "X",
            rootEntity: "X",
            entities: [],
            valueObjects: [],
            invariants: [{
              description: "x",
              transactional: true,
              rationale: "x",
            }],
            identityReferences: [],
            eventsTrigger: [],
          }],
          eventualConsistencyRules: [],
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    'Context "payments" not found in context map',
  );
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
