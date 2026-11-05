/**
 * A POST whose only success response is 204 No Content (e.g. the metrics
 * tag-indexing-rules reorder endpoint) creates nothing to persist. It must be
 * classified as an action, write no resource, declare no resource spec, and its
 * generated test must assert zero data handles — never a create that stores an
 * empty `{}` under a constant "created" instance name.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import { generateTestSource } from "./test_generator.ts";
import { groupOperations } from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

// Mirrors Datadog's POST /api/v2/metrics/tag-indexing-rules/order: a JSON:API
// request body, and a single 204 success response with no content.
const SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  components: {
    schemas: {
      ReorderRequest: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: ["type", "attributes"],
            properties: {
              type: { type: "string", enum: ["tag_indexing_rules"] },
              attributes: {
                type: "object",
                properties: {
                  rule_ids: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    "/api/v2/metrics/tag-indexing-rules/order": {
      post: {
        operationId: "ReorderTagIndexingRules",
        tags: ["Metrics"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReorderRequest" },
            },
          },
        },
        responses: { "204": { description: "No Content" } },
      },
    },
  },
} as unknown as OpenAPISpec;

const SERVICE: ServiceConfig = {
  name: "metrics",
  description: "Metrics",
  tags: ["Metrics"],
  labels: [],
};

function build() {
  const [group] = groupOperations(SPEC, [SERVICE]);
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.01.01.1");
  return { group, methods, source };
}

Deno.test("grouper flags a 204-only POST as having no success response body", () => {
  const { group } = build();
  const post = group.operations.find((o) => o.httpMethod === "post")!;
  assertEquals(post.hasSuccessResponseBody, false);
});

Deno.test("a 204-only POST is classified as an action, not a create", () => {
  const { methods } = build();
  const reorder = methods.find((m) => m.name === "reorder_tag_indexing_rules")!;
  assertEquals(reorder.type, "action");
});

Deno.test("a no-content action writes no resource and declares no resource spec", () => {
  const { source } = build();
  // No resource spec named for the reorder method.
  assertEquals(source.includes('"reorder_tag_indexing_rules": {'), false);
  // No empty-schema fallback leaks into the output.
  assertEquals(source.includes("schema: z.object({}),"), false);
  // The execute body returns no data handles and never calls writeResource.
  const reorderStart = source.indexOf("reorder_tag_indexing_rules: {");
  assertEquals(reorderStart >= 0, true);
  const reorderBody = source.slice(reorderStart, reorderStart + 1200);
  assertStringIncludes(reorderBody, "return { dataHandles: [] };");
  // No writeResource *call* (the type annotation in the execute signature does
  // mention writeResource, so match the invocation form specifically).
  assertEquals(reorderBody.includes("context.writeResource("), false);
  // It never derives the bogus constant instance name.
  assertEquals(source.includes('.id ?? "created"'), false);
});

Deno.test("the generated no-content action test asserts zero data handles", () => {
  const { group, methods } = build();
  const src = generateTestSource(group.config, methods, "tag_indexing_rules");
  assertStringIncludes(
    src,
    "metrics model: reorder_tag_indexing_rules executes successfully",
  );
  assertStringIncludes(src, "assertEquals(result.dataHandles.length, 0);");
  assertStringIncludes(src, "assertEquals(resources.length, 0);");
});
