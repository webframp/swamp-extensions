import { assertEquals, assertThrows } from "@std/assert";
import {
  detectPagination,
  PAGINATION_REF,
  schemaAtPath,
} from "./pagination.ts";
import { groupOperations } from "./service_grouper.ts";
import { SERVICES } from "../config.ts";
import { loadSpec } from "./spec_fixture.ts";

function operation(id: string) {
  const groups = groupOperations(loadSpec(), SERVICES);
  const op = groups.flatMap((g) => g.operations).find((o) =>
    o.operationId === id
  );
  if (!op) throw new Error(`no operation ${id}`);
  return op;
}

Deno.test("detectPagination: listZoneRecords is paginated though it declares no page parameters", () => {
  const spec = loadSpec();
  const declared = spec.paths["/{account}/zones/{zone}/records"].get as {
    parameters: { $ref?: string; name?: string }[];
  };
  const names = declared.parameters.map((p) => p.name ?? p.$ref);
  assertEquals(names.some((n) => n === "page" || n === "per_page"), false);
  assertEquals(
    names.some((n) => /Pagination/.test(String(n))),
    false,
  );

  const op = operation("listZoneRecords");
  assertEquals(op.pagination.paginated, true);
  assertEquals(op.pagination.resultsPath, ["data"]);
  assertEquals(op.isCollection, true);
});

Deno.test("detectPagination: queryDnsAnalytics reads rows from data.rows and keeps headers", () => {
  const op = operation("queryDnsAnalytics");
  assertEquals(op.pagination.paginated, true);
  assertEquals(op.pagination.resultsPath, ["data", "rows"]);
  assertEquals(op.pagination.keep, ["headers"]);
  assertEquals(Object.keys(op.paginatedSiblings ?? {}), ["headers"]);
  // The helper owns page and per_page, even though the spec declares both here.
  assertEquals(
    op.queryParams.some((p) => p.name === "page" || p.name === "per_page"),
    false,
  );
  assertEquals(op.queryParams.some((p) => p.name === "start_date"), true);
});

Deno.test("detectPagination: exactly seventeen operations are paginated", () => {
  const paginated = groupOperations(loadSpec(), SERVICES)
    .flatMap((g) => g.operations)
    .filter((o) => o.pagination.paginated);
  assertEquals(paginated.length, 17);
});

Deno.test("detectPagination: an array without a pagination object is a single request", () => {
  for (const id of ["listAccounts", "listWebhooks"]) {
    const op = operation(id);
    assertEquals(op.pagination.paginated, false, id);
    assertEquals(op.isCollection, true, id);
  }
});

Deno.test("detectPagination: results path that is not an array fails generation", () => {
  const raw = {
    properties: { pagination: { $ref: PAGINATION_REF } },
  };
  const resolved = {
    type: "object",
    properties: { data: { type: "object" }, pagination: { type: "object" } },
  };
  assertThrows(
    () => detectPagination("listThings", raw, resolved),
    Error,
    "listThings: paginated response has no array at data",
  );
});

Deno.test("detectPagination: a keep sibling the schema lacks fails generation", () => {
  const raw = { properties: { pagination: { $ref: PAGINATION_REF } } };
  const resolved = {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: { rows: { type: "array", items: {} } },
      },
    },
  };
  assertThrows(
    () =>
      detectPagination("q", raw, resolved, {
        q: { path: ["data", "rows"], keep: ["headers"] },
      }),
    Error,
    "keeps headers",
  );
});

Deno.test("detectPagination: a response whose pagination is not the shared ref is not paginated", () => {
  const info = detectPagination(
    "x",
    { properties: { pagination: { type: "object" } } },
    { type: "object" },
  );
  assertEquals(info.paginated, false);
});

Deno.test("schemaAtPath: walks properties and returns undefined when the path breaks", () => {
  const schema = {
    properties: { a: { properties: { b: { type: "string" } } } },
  };
  assertEquals(schemaAtPath(schema, ["a", "b"]), { type: "string" });
  assertEquals(schemaAtPath(schema, ["a", "nope"]), undefined);
  assertEquals(schemaAtPath(undefined, ["a"]), undefined);
});
