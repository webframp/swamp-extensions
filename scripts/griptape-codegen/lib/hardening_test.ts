/**
 * Tests for: change detection across all generated artifacts, the generated
 * test file's shape, and query-string handling on every method type.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { artifactsChanged, computeModelVersion } from "./upgrades.ts";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import {
  generateTestSource,
  planRequest,
  queryTestValue,
} from "./test_generator.ts";
import type { ParameterObject } from "./schema_fetcher.ts";

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
    summary: "List things",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    deprecated: false,
    tags: [],
    ...overrides,
  };
}

function groupOf(...ops: GroupedOperation[]): ServiceGroup {
  return { config: cfg, operations: ops };
}

function pathParam(name: string): ParameterObject {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

function queryParam(
  name: string,
  schema: ParameterObject["schema"],
): ParameterObject {
  return { name, in: "query", schema };
}

// ---------------------------------------------------------------------------
// Change detection covers every generated artifact, not just the model source
// ---------------------------------------------------------------------------

const PLACEHOLDER = "0.0.0.0";

async function scratch(): Promise<string> {
  return await Deno.makeTempDir();
}

Deno.test("computeModelVersion: an unchanged model but changed helper still bumps", async () => {
  const dir = await scratch();
  try {
    const modelPath = join(dir, "things.ts");
    const apiPath = join(dir, "api.ts");
    await Deno.writeTextFile(
      modelPath,
      `export const model = {\n  version: "2026.10.01.3",\n  upgrades: [],\n};\n`,
    );
    await Deno.writeTextFile(apiPath, `export const a = 1;\n`);
    const candidateModel =
      `export const model = {\n  version: "0.0.0.0",\n  upgrades: [],\n};\n`;

    const same = await computeModelVersion(
      modelPath,
      "2026.10.07",
      candidateModel,
      PLACEHOLDER,
      [{ path: apiPath, candidate: `export const a = 1;\n` }],
    );
    assertEquals(same.status, "unchanged");
    assertEquals(same.version, "2026.10.01.3");

    const changed = await computeModelVersion(
      modelPath,
      "2026.10.07",
      candidateModel,
      PLACEHOLDER,
      [{ path: apiPath, candidate: `export const a = 2;\n` }],
    );
    assertEquals(changed.status, "changed");
    assertEquals(changed.version, "2026.10.07.1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeModelVersion: a missing artifact counts as a change", async () => {
  const dir = await scratch();
  try {
    const modelPath = join(dir, "things.ts");
    await Deno.writeTextFile(
      modelPath,
      `export const model = {\n  version: "2026.10.07.1",\n  upgrades: [],\n};\n`,
    );
    const res = await computeModelVersion(
      modelPath,
      "2026.10.07",
      `export const model = {\n  version: "0.0.0.0",\n  upgrades: [],\n};\n`,
      PLACEHOLDER,
      [{ path: join(dir, "absent_test.ts"), candidate: "export {};\n" }],
    );
    assertEquals(res.status, "changed");
    // Same date: micro segment increments.
    assertEquals(res.version, "2026.10.07.2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("artifactsChanged: version string and formatting differences are ignored", async () => {
  const dir = await scratch();
  try {
    const manifest = join(dir, "manifest.yaml");
    await Deno.writeTextFile(manifest, `name: "x"\nversion: "2026.10.01.3"\n`);
    const changed = await artifactsChanged(
      [{ path: manifest, candidate: `name: "x"\nversion: "0.0.0.0"\n` }],
      "2026.10.01.3",
      PLACEHOLDER,
    );
    assertEquals(changed, []);

    const md = join(dir, "README.md");
    await Deno.writeTextFile(md, "# T\n\nbody\n");
    assertEquals(
      await artifactsChanged(
        [{ path: md, candidate: "# T\n\nbody changed\n" }],
        "2026.10.01.3",
        PLACEHOLDER,
      ),
      [md],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Query strings are sent for every method type
// ---------------------------------------------------------------------------

Deno.test("generateModelSource: create/update/delete append declared query params", () => {
  const group = groupOf(
    op({
      httpMethod: "post",
      path: "/api/things",
      operationId: "CreateThing",
      queryParams: [queryParam("dry_run", { type: "boolean" })],
      requestBody: { type: "object", properties: { n: { type: "string" } } },
    }),
    op({
      httpMethod: "patch",
      path: "/api/things/{thing_id}",
      operationId: "UpdateThing",
      pathParams: [pathParam("thing_id")],
      queryParams: [queryParam("dry_run", { type: "boolean" })],
      requestBody: { type: "object", properties: { n: { type: "string" } } },
    }),
    op({
      httpMethod: "delete",
      path: "/api/things/{thing_id}",
      operationId: "DeleteThing",
      pathParams: [pathParam("thing_id")],
      queryParams: [queryParam("force", { type: "boolean" })],
    }),
  );
  const src = generateModelSource(
    group,
    classifyServiceMethods(group),
    "0.0.0.0",
  );
  // One qs statement per method, each spliced into its request URL.
  assertEquals(src.match(/const qs = /g)?.length, 3);
  assertEquals(src.match(/\$\{qs\}`/g)?.length, 3);
  // The query arg is excluded from the JSON body of create/update.
  assertStringIncludes(src, `new Set(["dry_run"])`);
});

Deno.test("generateModelSource: methods without query params emit no qs scaffolding", () => {
  const group = groupOf(
    op({
      httpMethod: "delete",
      path: "/api/things/{thing_id}",
      operationId: "DeleteThing",
      pathParams: [pathParam("thing_id")],
    }),
  );
  const src = generateModelSource(
    group,
    classifyServiceMethods(group),
    "0.0.0.0",
  );
  assertEquals(src.includes("qs"), false);
});

Deno.test("generateModelSource: descriptions are never cut mid-word", () => {
  const long =
    "Allocate a brand new extraordinarily descriptive resource for the calling organization immediately and then keep it";
  const group = groupOf(
    op({
      httpMethod: "post",
      path: "/api/things",
      operationId: "CreateThing",
      requestBody: {
        type: "object",
        properties: { note: { type: "string", description: long } },
      },
    }),
  );
  const src = generateModelSource(
    group,
    classifyServiceMethods(group),
    "0.0.0.0",
  );
  const m = src.match(
    /note: z\.string\(\)\.optional\(\)\.describe\("([^"]*)"\)/,
  );
  assert(m, "expected a described note field");
  const text = m[1];
  assert(text.endsWith("..."));
  assert(text.length <= 100);
  assert(long.startsWith(text.slice(0, -3)));
  assertEquals(long[text.length - 3], " ");
});

// ---------------------------------------------------------------------------
// Generated test file shape
// ---------------------------------------------------------------------------

function sampleMethods() {
  const group = groupOf(
    op({
      httpMethod: "get",
      path: "/api/things",
      operationId: "ListThings",
      isCollection: true,
      listItemsKey: "things",
      queryParams: [
        queryParam("page", { type: "number" }),
        queryParam("page_size", { type: "number" }),
        queryParam("kind", { type: "string", enum: ["alpha", "beta"] }),
        queryParam("limit", { type: "integer" }),
      ],
      responseSchema: {
        type: "object",
        properties: { thing_id: { type: "string" } },
      },
    }),
    op({
      httpMethod: "get",
      path: "/api/things/{thing_id}",
      operationId: "GetThing",
      pathParams: [pathParam("thing_id")],
      queryParams: [queryParam("include", { type: "boolean" })],
      responseSchema: {
        type: "object",
        properties: {
          thing_id: { type: "string" },
          status: { type: "string", enum: ["on", "off"] },
        },
      },
    }),
    op({
      httpMethod: "post",
      path: "/api/things",
      operationId: "CreateThing",
      requestBody: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, size: { type: "integer" } },
      },
      responseSchema: {
        type: "object",
        properties: { thing_id: { type: "string" } },
      },
    }),
    op({
      httpMethod: "post",
      path: "/api/things/{thing_id}/runs",
      operationId: "RunThing",
      pathParams: [pathParam("thing_id")],
      requestBody: { type: "array", items: { type: "string" } },
      responseSchema: {
        type: "object",
        properties: { run_id: { type: "string" } },
      },
    }),
    op({
      httpMethod: "delete",
      path: "/api/things/{thing_id}",
      operationId: "DeleteThing",
      pathParams: [pathParam("thing_id")],
    }),
  );
  return classifyServiceMethods(group);
}

Deno.test("generateTestSource: every method gets its own uniquely named execution test", () => {
  const methods = sampleMethods();
  const src = generateTestSource(cfg, methods, "things");
  const names = [...src.matchAll(/name: "(things model: [^"]+)"/g)].map((m) =>
    m[1]
  );
  assertEquals(new Set(names).size, names.length, "test names must be unique");
  for (const m of methods) {
    assert(
      names.some((n) => n.startsWith(`things model: ${m.name} `)),
      `no execution test for ${m.name}`,
    );
  }
});

Deno.test("generateTestSource: tests execute methods and assert request shape, not just existence", () => {
  const src = generateTestSource(cfg, sampleMethods(), "things");
  assertStringIncludes(src, "assertRequest(requests, {");
  assertStringIncludes(src, `method: "POST"`);
  assertStringIncludes(src, `pathname: "/api/things/test-id-123/runs"`);
  assertStringIncludes(src, "assertWritten(written()");
  // Routes are keyed on METHOD + exact path, never a substring match.
  assertStringIncludes(src, "const key = req.method");
  assertEquals(src.includes("path.includes(pattern)"), false);
});

Deno.test("generateTestSource: covers helper behavior (errors, malformed JSON, empty body, timeout, retry)", () => {
  const src = generateTestSource(cfg, sampleMethods(), "things");
  for (
    const frag of [
      "HTTP errors name the request and status",
      "malformed JSON names status and request",
      "an empty 2xx body is not a parse failure",
      "a stalled request times out with a clear error",
      "an invalid GT_CLOUD_TIMEOUT_MS is rejected",
      "a 429 is retried after Retry-After",
      "response schemas tolerate unexpected data",
    ]
  ) {
    assertStringIncludes(src, frag);
  }
});

Deno.test("generateTestSource: tolerance test probes enum members and extra keys", () => {
  const src = generateTestSource(cfg, sampleMethods(), "things");
  assertStringIncludes(src, "__unexpected_enum_member__");
  assertStringIncludes(src, "unexpected_field");
});

Deno.test("planRequest: enum query arg is sent and asserted in the URL", () => {
  const list = sampleMethods().find((m) => m.name === "list_things")!;
  const plan = planRequest(list);
  assertEquals(plan.args.kind, "alpha");
  assertEquals(plan.query.kind, "alpha");
  assertEquals(plan.query.limit, "1");
  // page/page_size are owned by the pagination helper.
  assertEquals(plan.query.page, "1");
  assertEquals(plan.query.page_size, "50");
  assertEquals("page" in plan.args, false);
  assertEquals(plan.body, undefined);

  const src = generateTestSource(cfg, sampleMethods(), "things");
  assertStringIncludes(
    src,
    `query: {"kind":"alpha","limit":"1","page":"1","page_size":"50"}`,
  );
});

Deno.test("planRequest: expected body mirrors what the runtime sends", () => {
  const methods = sampleMethods();
  const create = planRequest(methods.find((m) => m.name === "create_thing")!);
  assertEquals(create.body, { name: "test-value", size: 1 });
  assertEquals(create.httpMethod, "POST");

  // Array body: sent as the array itself, not wrapped.
  const run = planRequest(methods.find((m) => m.name === "run_thing")!);
  assertEquals(run.body, ["test-value"]);
  assertEquals(run.pathname, "/api/things/test-id-123/runs");

  // GET and DELETE send no body.
  assertEquals(
    planRequest(methods.find((m) => m.name === "get_thing")!).body,
    undefined,
  );
  assertEquals(
    planRequest(methods.find((m) => m.name === "delete_thing")!).body,
    undefined,
  );
});

Deno.test("planRequest: a body field sharing a path-param name cannot rewrite the URL or body", () => {
  const group = groupOf(
    op({
      httpMethod: "patch",
      path: "/api/things/{thing_id}",
      operationId: "UpdateThing",
      pathParams: [pathParam("thing_id")],
      requestBody: {
        type: "object",
        properties: { thing_id: { type: "string" }, n: { type: "string" } },
      },
    }),
  );
  const plan = planRequest(classifyServiceMethods(group)[0]);
  assertEquals(plan.args.thing_id, "test-id-123");
  assertEquals(plan.body, { n: "test-value" });
});

Deno.test("queryTestValue: enum, number, boolean, array-of-enum, and string params", () => {
  assertEquals(
    queryTestValue(queryParam("a", { type: "string", enum: ["x", "y"] })),
    "x",
  );
  assertEquals(queryTestValue(queryParam("a", { type: "integer" })), 1);
  assertEquals(
    queryTestValue(
      queryParam("a", { type: "integer", minimum: 5, maximum: 3 }),
    ),
    3,
  );
  assertEquals(queryTestValue(queryParam("a", { type: "boolean" })), true);
  assertEquals(
    queryTestValue(
      queryParam("a", {
        type: "array",
        items: { type: "string", enum: ["s"] },
      }),
    ),
    "s",
  );
  assertEquals(
    queryTestValue(queryParam("a", { type: "string" })),
    "test-value",
  );
});
