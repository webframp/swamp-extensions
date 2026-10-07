/**
 * Tests for resource-name collisions between list and non-list methods, and for
 * the schema used when an operation declares no response body.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyServiceMethods,
  generateModelSource,
  resourceNameFor,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import { generateTestSource } from "./test_generator.ts";

const cfg = {
  name: "things",
  description: "Things",
  pathPrefixes: ["/api/things"],
  labels: [],
};

function op(overrides: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/api/things",
    operationId: "ListThings",
    summary: "",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    deprecated: false,
    tags: [],
    ...overrides,
  };
}

const listEvents = op({
  path: "/api/runs/{run_id}/events",
  operationId: "ListEvents",
  isCollection: true,
  listItemsKey: "events",
  pathParams: [
    { name: "run_id", in: "path", required: true, schema: { type: "string" } },
  ],
  responseSchema: {
    type: "object",
    properties: { event_id: { type: "string" } },
  },
});

const createEvents = op({
  httpMethod: "post",
  path: "/api/runs/{run_id}/events",
  operationId: "CreateEvents",
  pathParams: [
    { name: "run_id", in: "path", required: true, schema: { type: "string" } },
  ],
  requestBody: { type: "object", properties: { events: { type: "array" } } },
});

Deno.test("classifyServiceMethods: a create that derives a list's resource name gets its own", () => {
  const group: ServiceGroup = {
    config: cfg,
    operations: [listEvents, createEvents],
  };
  const methods = classifyServiceMethods(group);
  const list = methods.find((m) => m.name === "list_events")!;
  const create = methods.find((m) => m.name === "create_events")!;
  assertEquals(resourceNameFor(list), "events");
  assertEquals(resourceNameFor(create), "events_result");
});

Deno.test("classifyServiceMethods: unrelated names are left alone", () => {
  const group: ServiceGroup = {
    config: cfg,
    operations: [
      listEvents,
      op({
        httpMethod: "post",
        path: "/api/runs/{run_id}/event",
        operationId: "CreateEvent",
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  assertEquals(
    methods.find((m) => m.name === "create_event")!.resourceName,
    undefined,
  );
  assertEquals(
    resourceNameFor(methods.find((m) => m.name === "create_event")!),
    "event",
  );
});

Deno.test("generated model: colliding list and create keep separate resources and schemas", () => {
  const group: ServiceGroup = {
    config: cfg,
    operations: [listEvents, createEvents],
  };
  const methods = classifyServiceMethods(group);
  const src = generateModelSource(group, methods, "0.0.0.0");
  assertStringIncludes(src, `"events": {`);
  assertStringIncludes(src, `"events_result": {`);
  assertStringIncludes(src, `context.writeResource("events_result"`);
  assertStringIncludes(src, `context.writeResource("events", `);
  // The result resource has no declared response body: loose, never stripped.
  assertStringIncludes(src, "schema: z.looseObject({})");
  assertEquals(src.includes("z.object({}),"), false);

  const tests = generateTestSource(cfg, methods, "things");
  assertStringIncludes(tests, `assertWritten(written(), "events_result"`);
});

Deno.test("generateTestSource: a list of plain strings gets string fixtures and no object probes", () => {
  const logs = op({
    path: "/api/runs/{run_id}/logs",
    operationId: "ListRunLogs",
    isCollection: true,
    listItemsKey: "logs",
    pathParams: [
      {
        name: "run_id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responseSchema: { type: "string" },
  });
  const group: ServiceGroup = { config: cfg, operations: [logs] };
  const methods = classifyServiceMethods(group);
  const tests = generateTestSource(cfg, methods, "things");
  assertStringIncludes(tests, `const fixture = "test-value";`);
  // Partial-object tolerance probes do not apply to string items.
  assertEquals(tests.includes(`resourceSchema("run_logs").safeParse({`), false);
});
