/**
 * Every spec name passed to `writeResource` in a generated model must be a key
 * of the model's `resources` map. A method whose name prefix differs from its
 * classified type (e.g. a POST named `get_*_url`, classified as create) once
 * wrote under a name the model never declared.
 */

import { assertEquals } from "@std/assert";
import { generateModelSource } from "./method_classifier.ts";
import type { ClassifiedMethod } from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";

function op(httpMethod: string, path: string): GroupedOperation {
  return {
    httpMethod,
    path,
    operationId: "x",
    summary: "s",
    description: "d",
    pathParams: [],
    queryParams: [],
    requestBodyIsJsonApi: false,
    requestBodyIsArray: false,
    isCollection: false,
    isJsonApi: false,
    pagination: {
      style: "none",
      limitParam: "",
      limitDefault: 0,
    },
    deprecated: false,
    tags: ["T"],
  } as GroupedOperation;
}

Deno.test("generated model: writeResource names are declared resources", () => {
  const group: ServiceGroup = {
    config: {
      name: "demo",
      description: "Demo",
      tags: ["T"],
      labels: [],
    },
    operations: [],
  };
  const methods: ClassifiedMethod[] = [
    // POST classified as create but named get_*: prefix differs from type.
    {
      name: "get_file_download_url",
      type: "create",
      description: "d",
      operation: op("post", "/api/v2/files/download"),
    },
    {
      name: "get_thing",
      type: "get",
      description: "d",
      operation: op("get", "/api/v2/thing"),
    },
    {
      name: "update_other",
      type: "update",
      description: "d",
      operation: op("patch", "/api/v2/other"),
    },
  ];
  const src = generateModelSource(group, methods, "2026.01.01.1");

  const resourcesBlock = src.slice(src.indexOf("  resources: {"));
  const declared = new Set(
    [...resourcesBlock.matchAll(/^ {4}"([a-z0-9_]+)": \{$/gm)].map((m) => m[1]),
  );
  const written = [...src.matchAll(/writeResource\(\s*"([a-z0-9_]+)"/g)].map(
    (m) => m[1],
  );
  assertEquals(written.length >= 3, true);
  for (const name of written) {
    assertEquals(declared.has(name), true, `undeclared resource: ${name}`);
  }
});
