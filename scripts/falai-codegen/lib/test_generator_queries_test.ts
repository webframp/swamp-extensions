// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the generated tests' handling of query arguments: enum query
 * arguments must be exercised and asserted in the request URL, and every
 * method (not just the first of each type) must get its own test.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { enumQueryParams, generateTestSource } from "./test_generator.ts";
import { classifyServiceMethods } from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import type { ServiceConfig } from "../config.ts";

function op(overrides: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/assets",
    operationId: "listAssets",
    summary: "",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    pagination: { paginated: false, hasNextCursor: false, hasHasMore: false },
    deprecated: false,
    tags: [],
    ...overrides,
  };
}

const CONFIG: ServiceConfig = {
  name: "assets",
  description: "fal.ai Assets",
  tags: ["Assets"],
  labels: [],
};

function enumListGroup(): ServiceGroup {
  return {
    config: CONFIG,
    operations: [
      op({
        operationId: "getAssets",
        path: "/assets",
        isCollection: true,
        pagination: {
          paginated: true,
          resultsField: "assets",
          hasNextCursor: false,
          hasHasMore: false,
        },
        queryParams: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "sort",
            in: "query",
            schema: { type: "string", enum: ["relevant", "recent"] },
          },
          {
            name: "sort-dir",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"] },
          },
        ],
        responseSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      }),
    ],
  };
}

Deno.test("enumQueryParams: picks the first value of scalar enums and skips limit/cursor", () => {
  const [method] = classifyServiceMethods(enumListGroup());
  const params = enumQueryParams(method);
  assertEquals(params.map((p) => [p.argName, p.queryName, p.value]), [
    ["sort", "sort", "relevant"],
    ["sort_dir", "sort-dir", "asc"],
  ]);
});

Deno.test("generateTestSource: asserts enum query args reach the request URL under the API's name", () => {
  const methods = classifyServiceMethods(enumListGroup());
  const source = generateTestSource(CONFIG, methods, "assets");
  // The mock server records every request URL.
  assertStringIncludes(source, "requests.push(url)");
  // The test calls the method with the enum values...
  assertStringIncludes(source, '"sort":"relevant"');
  assertStringIncludes(source, '"sort_dir":"asc"');
  // ...and asserts the wire name (dash intact), not the sanitized arg name.
  assertStringIncludes(source, 'u.searchParams.get("sort") === "relevant"');
  assertStringIncludes(source, 'u.searchParams.get("sort-dir") === "asc"');
});

Deno.test("generateTestSource: methods with no enum query args get no URL assertions", () => {
  const methods = classifyServiceMethods({
    config: CONFIG,
    operations: [op({ operationId: "getAssetThing", path: "/assets/thing" })],
  });
  const source = generateTestSource(CONFIG, methods, "assets");
  assertEquals(source.includes("searchParams.get("), false);
  // An unused `requests` binding would fail lint in the generated extension.
  assertEquals(
    source.includes("server, requests } = startMockFalServer"),
    false,
  );
});

Deno.test("generateTestSource: binds requests when a test asserts on them", () => {
  const methods = classifyServiceMethods(enumListGroup());
  const source = generateTestSource(CONFIG, methods, "assets");
  assertStringIncludes(source, "const { url, server, requests } =");
});

Deno.test("generateTestSource: every method gets its own test, not just the first of each type", () => {
  const methods = classifyServiceMethods({
    config: CONFIG,
    operations: [
      op({ operationId: "getAlpha", path: "/assets/alpha" }),
      op({ operationId: "getBeta", path: "/assets/beta" }),
    ],
  });
  assertEquals(methods.length, 2);
  assertEquals(methods[0].type, methods[1].type);
  const source = generateTestSource(CONFIG, methods, "assets");
  for (const m of methods) {
    assertStringIncludes(source, `assets model: ${m.name} `);
  }
});
