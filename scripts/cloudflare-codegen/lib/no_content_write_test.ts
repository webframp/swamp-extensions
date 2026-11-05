/**
 * A write (POST/PUT/PATCH) whose only success response is 204 No Content (or a
 * 2xx with no application/json schema) creates nothing to persist. It must be
 * classified so it does not write a resource, declare no resource spec, emit no
 * bare `z.object({})`, return `{ dataHandles: [] }` from its body, and its
 * generated test must assert zero data handles — never a create/action that
 * stores an empty `{}` under a constant instance name.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyServiceMethods,
  generateModelSource,
  methodWritesResource,
} from "./method_classifier.ts";
import { generateTestSource } from "./test_generator.ts";
import { groupOperations } from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

// A 204-only POST to a {param} path (an action) and a 204-only PATCH (update).
// Both are writes with no response body: nothing to persist. A POST create is
// intentionally NOT exercised here — a create always writes, even with an
// unresolved response schema (see methodWritesResource).
const SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  components: { schemas: {} },
  paths: {
    "/zones/{zone_id}/demo/rules/{rule_id}": {
      post: {
        operationId: "demo-activate-rule",
        summary: "Activate rule",
        tags: ["Demo"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  files: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "204": { description: "No Content" } },
      },
    },
    "/zones/{zone_id}/demo/order": {
      patch: {
        operationId: "demo-reorder-rules",
        summary: "Reorder rules",
        tags: ["Demo"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  rule_ids: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "204": { description: "No Content" } },
      },
    },
  },
} as unknown as OpenAPISpec;

const SERVICE: ServiceConfig = {
  name: "demo",
  description: "Demo",
  pathPrefixes: ["/zones/{zone_id}/demo"],
  scope: "zone",
  labels: ["cloudflare"],
};

function build() {
  const [group] = groupOperations(SPEC, [SERVICE]);
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.11.05.1");
  return { group, methods, source };
}

Deno.test("grouper flags a 204-only write as having no success response body", () => {
  const { group } = build();
  for (const op of group.operations) {
    assertEquals(op.hasSuccessResponseBody, false);
  }
});

Deno.test("a 204-only write does not write a resource", () => {
  const { methods } = build();
  assertEquals(methods.length, 2);
  for (const m of methods) {
    assertEquals(methodWritesResource(m), false);
  }
});

Deno.test("a no-content write declares no resource spec and emits no bare z.object({})", () => {
  const { source, methods } = build();
  for (const m of methods) {
    // No resource spec named for the method's resource.
    const resourceName = m.name.replace(/^(create|update|action)_/, "");
    assertEquals(source.includes(`"${resourceName}": {`), false);
  }
  // No empty-schema fallback leaks into the output.
  assertEquals(source.includes("schema: z.object({}),"), false);
  // The whole resources block should be empty.
  assertStringIncludes(source, "resources: {\n  },");
});

Deno.test("a no-content write body returns { dataHandles: [] } and never calls writeResource", () => {
  const { source, methods } = build();
  for (const m of methods) {
    const start = source.indexOf(`${m.name}: {`);
    assertEquals(start >= 0, true);
    const body = source.slice(start, start + 1600);
    assertStringIncludes(body, "return { dataHandles: [] };");
    // No writeResource *call* (the execute signature's type annotation mentions
    // writeResource, so match the invocation form specifically).
    assertEquals(body.includes("context.writeResource("), false);
  }
  // It never derives the bogus constant instance name.
  assertEquals(source.includes('?? "created"'), false);
  assertEquals(source.includes('.id ?? "created"'), false);
});

Deno.test("the generated no-content write test asserts zero data handles", () => {
  const { group, methods } = build();
  const src = generateTestSource(group.config, methods, "demo");
  assertStringIncludes(
    src,
    "demo model: demo_activate_rule executes successfully",
  );
  assertStringIncludes(src, "assertEquals(result.dataHandles.length, 0);");
  assertStringIncludes(src, "assertEquals(resources.length, 0);");
});
