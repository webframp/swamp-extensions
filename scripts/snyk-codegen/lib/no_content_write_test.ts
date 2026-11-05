// SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for no-content write operations.
 *
 * A write (POST/PUT/PATCH) whose success response carries no body (HTTP 204, or
 * a 2xx with no JSON schema) must NOT be treated as a resource-writing method:
 * there is no data to persist. The generator must classify such a method as
 * non-writing, emit no resource spec for it, emit a body that issues the call
 * and returns zero data handles, and generate a test asserting the same.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ServiceConfig } from "../config.ts";
import { generateApiLib } from "./extension_generator.ts";
import {
  classifyServiceMethods,
  generateModelSource,
  methodWritesResource,
  resourceNameOf,
} from "./method_classifier.ts";
import { generateTestSource } from "./test_generator.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import { groupOperations } from "./service_grouper.ts";

const CONFIG: ServiceConfig = {
  name: "widgets",
  description: "Widgets",
  pathPrefixes: ["/orgs/{org_id}/widgets"],
  scope: "org",
  labels: [],
};

const JSON_API = "application/vnd.api+json";

/** A spec with a 204-only POST and a 204-only PATCH, plus one writing create. */
const SPEC = {
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  components: { schemas: {}, responses: {} },
  paths: {
    // A POST whose only success is 204 — a relationship update that applies a
    // change and returns nothing.
    "/orgs/{org_id}/widgets/{widget_id}/relationships/links": {
      post: {
        operationId: "linkWidget",
        parameters: [
          {
            name: "org_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "widget_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            [JSON_API]: {
              schema: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
        responses: { "204": { description: "no content" } },
      },
    },
    // A PATCH whose only success is 204.
    "/orgs/{org_id}/widgets/{widget_id}/state": {
      patch: {
        operationId: "setWidgetState",
        parameters: [
          {
            name: "org_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "widget_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            [JSON_API]: {
              schema: {
                type: "object",
                properties: { state: { type: "string" } },
              },
            },
          },
        },
        responses: { "204": { description: "no content" } },
      },
    },
    // A create that DOES return a body — must keep writing a resource.
    "/orgs/{org_id}/widgets": {
      post: {
        operationId: "createWidget",
        requestBody: {
          content: {
            [JSON_API]: {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              [JSON_API]: {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        type: { type: "string" },
                        attributes: {
                          type: "object",
                          properties: { name: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as OpenAPISpec;

Deno.test("no-content writes are not classified as resource-writing", () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const methods = classifyServiceMethods(group);

  const link = methods.find((m) => m.operation.operationId === "linkWidget")!;
  const setState = methods.find((m) =>
    m.operation.operationId === "setWidgetState"
  )!;
  const create = methods.find((m) =>
    m.operation.operationId === "createWidget"
  )!;

  // The 204 POST classifies as create (has a request body, path does not end
  // in a param) or action; either way it must be non-writing.
  assertEquals(link.operation.hasResponseBody, false);
  assertEquals(setState.type, "update");
  assertEquals(setState.operation.hasResponseBody, false);

  assertEquals(methodWritesResource(link), false);
  assertEquals(methodWritesResource(setState), false);

  // The real create still returns a body, so it still writes.
  assertEquals(create.operation.hasResponseBody, true);
  assertEquals(methodWritesResource(create), true);
});

Deno.test("no-content writes emit no resource spec and no bare z.object({})", () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const methods = classifyServiceMethods(group);
  const src = generateModelSource(group, methods, "2026.11.05.1");

  const link = methods.find((m) => m.operation.operationId === "linkWidget")!;
  const setState = methods.find((m) =>
    m.operation.operationId === "setWidgetState"
  )!;

  // No resource spec is declared for either no-content write.
  assertEquals(
    new RegExp(`"${resourceNameOf(link)}":\\s*\\{`).test(src),
    false,
  );
  assertEquals(
    new RegExp(`"${resourceNameOf(setState)}":\\s*\\{`).test(src),
    false,
  );

  // The writing create still declares a resource.
  assertEquals(/"widget":\s*\{/.test(src), true);

  // No bare (non-passthrough) empty object schema is ever emitted.
  assertEquals(/schema:\s*z\.object\(\{\}\)\s*,/.test(src), false);
});

Deno.test("no-content write bodies issue the call and return zero data handles", async () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const methods = classifyServiceMethods(group);
  const src = generateModelSource(group, methods, "2026.11.05.1");

  const linkName =
    methods.find((m) => m.operation.operationId === "linkWidget")!.name;
  const setStateName =
    methods.find((m) => m.operation.operationId === "setWidgetState")!.name;

  const dir = await Deno.makeTempDir();
  const original = globalThis.fetch;
  try {
    await Deno.mkdir(join(dir, "_lib"));
    await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
    await Deno.writeTextFile(join(dir, "widgets.ts"), src);
    const { model } = await import(`file://${join(dir, "widgets.ts")}`);
    const execMethods = model.methods as Record<
      string,
      {
        execute: (
          a: Record<string, unknown>,
          c: unknown,
        ) => Promise<{ dataHandles: unknown[] }>;
      }
    >;

    const written: unknown[] = [];
    const context = {
      globalArgs: { apiToken: "t", orgId: "o", version: "v" },
      logger: { info() {} },
      writeResource: (_s: string, name: string, data: unknown) => {
        written.push({ name, data });
        return Promise.resolve({ name });
      },
    };

    const calls: { method?: string; body: unknown }[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const r1 = await execMethods[linkName].execute(
      { widget_id: "w1", data: ["a"] },
      context,
    );
    const r2 = await execMethods[setStateName].execute(
      { widget_id: "w1", state: "open" },
      context,
    );

    // Both calls go out with the right verb and body.
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].body, { data: ["a"] });
    assertEquals(calls[1].method, "PATCH");
    assertEquals(calls[1].body, { state: "open" });

    // Neither persists a resource.
    assertEquals(r1, { dataHandles: [] });
    assertEquals(r2, { dataHandles: [] });
    assertEquals(written, []);
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generated test for a no-content write asserts zero data handles", () => {
  const [group] = groupOperations(SPEC, [CONFIG]);
  const methods = classifyServiceMethods(group);
  const tests = generateTestSource(CONFIG, methods, "widgets");

  const linkName =
    methods.find((m) => m.operation.operationId === "linkWidget")!.name;
  const setStateName =
    methods.find((m) => m.operation.operationId === "setWidgetState")!.name;

  // The no-content write's test exists and asserts zero handles + no writes.
  assertEquals(
    tests.includes(
      `widgets model: ${linkName} executes without writing a resource`,
    ),
    true,
  );
  assertEquals(
    tests.includes(
      `widgets model: ${setStateName} executes without writing a resource`,
    ),
    true,
  );
  // Those tests assert zero data handles and no written resources.
  assertEquals(
    /executes without writing a resource[\s\S]*?result\.dataHandles\.length, 0/
      .test(tests),
    true,
  );
  assertEquals(
    /executes without writing a resource[\s\S]*?getWrittenResources\(\)\.length,\s*0/
      .test(tests),
    true,
  );
});
