/**
 * Tests for the test generator module.
 */

import { assertEquals } from "@std/assert";
import {
  buildFinalTestArgs,
  extractPathPattern,
  PATH_PARAM_TEST_VALUE,
} from "./test_generator.ts";
import type { ClassifiedMethod } from "./method_classifier.ts";
import type { GroupedOperation } from "./service_grouper.ts";

function makeOp(overrides: Partial<GroupedOperation> = {}): GroupedOperation {
  return {
    httpMethod: "put",
    path: "/accounts/{account_id}/access/ai-controls/mcp/portals/{id}",
    operationId: "access-update-portal",
    summary: "Update portal",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    usesCursorPagination: false,
    deprecated: false,
    tags: ["Access"],
    ...overrides,
  };
}

function makeMethod(
  overrides: Partial<GroupedOperation> = {},
): ClassifiedMethod {
  return {
    name: "update_portals",
    type: "update",
    description: "Update portal",
    operation: makeOp(overrides),
    resourceName: "portal",
    // deno-lint-ignore no-explicit-any
  } as any;
}

// deno-lint-ignore no-explicit-any
const idPathParam = [{ name: "id", in: "path", required: true }] as any;

// ---------------------------------------------------------------------------
// buildFinalTestArgs
//
// A request-body property sharing a name with a path param must not override the
// path-param value, because the path param builds the request URL and the mock
// server is registered at a path containing PATH_PARAM_TEST_VALUE. The merge used
// to spread the fixture last, so a body example won.
//
// Real case: `update_portals` in cloudflare/access. The mock registered
// /access/ai-controls/mcp/portals/test-id-123 while the generated call passed
// id: "my-mcp-portal" from the spec example, so the request 404'd and the test
// failed with "Cloudflare API error: Not found". Same failure in
// cloudflare/pages, cloudflare/queues, and cloudflare/turnstile.
// ---------------------------------------------------------------------------

Deno.test("buildFinalTestArgs: path param wins over a colliding fixture key", () => {
  const method = makeMethod({ pathParams: idPathParam });
  const fixture = { id: "my-mcp-portal", name: "My MCP Portal" };

  const result = buildFinalTestArgs(method, fixture);

  assertEquals(result.id, PATH_PARAM_TEST_VALUE);
  // Non-colliding fixture fields still come through as request-body values.
  assertEquals(result.name, "My MCP Portal");
});

Deno.test("buildFinalTestArgs: the winning value matches the mock path", () => {
  // The invariant that actually matters: whatever value lands on the path param
  // must be the value the mock server is registered under.
  const method = makeMethod({ pathParams: idPathParam });
  const result = buildFinalTestArgs(method, { id: "my-mcp-portal" });
  const pattern = extractPathPattern(method.operation.path, "account");

  assertEquals(pattern.endsWith(String(result.id)), true);
  assertEquals(
    pattern,
    `/access/ai-controls/mcp/portals/${PATH_PARAM_TEST_VALUE}`,
  );
});

Deno.test("buildFinalTestArgs: no path params leaves the fixture untouched", () => {
  const method = makeMethod({
    path: "/accounts/{account_id}/access/ai-controls/mcp/portals",
  });
  const fixture = { id: "my-mcp-portal", name: "My MCP Portal" };

  assertEquals(buildFinalTestArgs(method, fixture), fixture);
});

Deno.test("buildFinalTestArgs: hyphenated path params are normalized to underscores", () => {
  const method = makeMethod({
    path: "/accounts/{account_id}/r2/buckets/{bucket-name}",
    // deno-lint-ignore no-explicit-any
    pathParams: [{ name: "bucket-name", in: "path", required: true }] as any,
  });

  const result = buildFinalTestArgs(method, {});
  assertEquals(result["bucket_name"], PATH_PARAM_TEST_VALUE);
  assertEquals("bucket-name" in result, false);
});

Deno.test("buildFinalTestArgs: every path param collides safely", () => {
  const method = makeMethod({
    path:
      "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}",
    pathParams: [
      { name: "namespace_id", in: "path", required: true },
      { name: "key_name", in: "path", required: true },
      // deno-lint-ignore no-explicit-any
    ] as any,
  });

  const result = buildFinalTestArgs(method, {
    namespace_id: "spec-example-ns",
    key_name: "spec-example-key",
    value: "payload",
  });

  assertEquals(result.namespace_id, PATH_PARAM_TEST_VALUE);
  assertEquals(result.key_name, PATH_PARAM_TEST_VALUE);
  assertEquals(result.value, "payload");
});

// ---------------------------------------------------------------------------
// extractPathPattern
// ---------------------------------------------------------------------------

Deno.test("extractPathPattern: strips the account scope prefix", () => {
  assertEquals(
    extractPathPattern("/accounts/{account_id}/r2/buckets", "account"),
    "/r2/buckets",
  );
});

Deno.test("extractPathPattern: strips the zone scope prefix", () => {
  assertEquals(
    extractPathPattern("/zones/{zone_id}/api_gateway/operations", "zone"),
    "/api_gateway/operations",
  );
});

Deno.test("extractPathPattern: substitutes remaining placeholders", () => {
  assertEquals(
    extractPathPattern(
      "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}",
      "account",
    ),
    `/storage/kv/namespaces/${PATH_PARAM_TEST_VALUE}/values/${PATH_PARAM_TEST_VALUE}`,
  );
});

Deno.test("extractPathPattern: drops a trailing slash", () => {
  assertEquals(
    extractPathPattern("/accounts/{account_id}/r2/", "account"),
    "/r2",
  );
});
