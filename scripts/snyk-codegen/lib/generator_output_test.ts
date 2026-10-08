// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for generated model code: the model source is generated for
 * a synthetic service, written next to the generated `_lib/api.ts`, imported,
 * and executed against a stubbed fetch. This pins down the request each method
 * builds (verb, path, query names, array serialization) and the response
 * schemas' tolerance, without a live API.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { ServiceConfig } from "../config.ts";
import { generateApiLib } from "./extension_generator.ts";
import {
  classifyServiceMethods,
  generateModelSource,
  resourceNameOf,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import { generateTestSource } from "./test_generator.ts";

const CONFIG: ServiceConfig = {
  name: "things",
  description: "Things",
  pathPrefixes: ["/orgs/{org_id}/things"],
  scope: "org",
  labels: [],
};

const THING_SCHEMA = {
  type: "object",
  required: ["state"],
  properties: {
    state: { type: "string", enum: ["open", "closed"] },
    size: { type: "integer", minimum: 1 },
  },
};

function op(partial: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/orgs/{org_id}/things",
    operationId: "x",
    summary: "",
    description: "",
    pathParams: [],
    queryParams: [],
    isCollection: false,
    usesCursorPagination: true,
    hasResponseBody: true,
    deprecated: false,
    tags: [],
    responseSchema: THING_SCHEMA,
    ...partial,
  };
}

const ARRAY_COMMA = {
  name: "provider",
  in: "query" as const,
  schema: { type: "array", items: { type: "string" } },
  style: "form",
  explode: false,
};
const ARRAY_REPEAT = {
  name: "target_id",
  in: "query" as const,
  schema: { type: "array", items: { type: "string" } },
};
const DOTTED = {
  name: "meta.count",
  in: "query" as const,
  schema: { type: "string", enum: ["with"] },
};

const GROUP: ServiceGroup = {
  config: CONFIG,
  operations: [
    op({
      operationId: "listThings",
      isCollection: true,
      queryParams: [ARRAY_COMMA, ARRAY_REPEAT, DOTTED],
    }),
    op({
      operationId: "getThing",
      path: "/orgs/{org_id}/things/{thing_id}",
      pathParams: [{ name: "thing_id", in: "path", required: true }],
      queryParams: [{
        name: "expand",
        in: "query",
        schema: { type: "array", items: { type: "string" } },
        style: "form",
        explode: false,
      }],
    }),
    op({
      operationId: "createThing",
      httpMethod: "post",
      queryParams: [{
        name: "dry.run",
        in: "query",
        schema: { type: "boolean" },
      }],
      requestBody: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    }),
    // A body-carrying POST is classified "create" even though the operation is
    // named update*; its written resource must still be the declared one.
    op({
      operationId: "updateThingSecret",
      httpMethod: "post",
      path: "/orgs/{org_id}/things/{thing_id}/secrets",
      pathParams: [{ name: "thing_id", in: "path", required: true }],
      requestBody: {
        type: "object",
        properties: { mode: { type: "string" } },
      },
    }),
    op({
      operationId: "deleteThing",
      httpMethod: "delete",
      path: "/orgs/{org_id}/things/{thing_id}",
      pathParams: [{ name: "thing_id", in: "path", required: true }],
      queryParams: [{
        name: "force",
        in: "query",
        schema: { type: "boolean" },
      }],
    }),
  ],
};

interface Captured {
  method: string;
  url: URL;
  body: unknown;
}

/** Generate, write, import the synthetic model, and run `fn` with a fetch stub. */
async function withGeneratedModel(
  respond: (c: Captured) => Response,
  fn: (
    // deno-lint-ignore no-explicit-any
    model: any,
    captured: Captured[],
    run: (method: string, args: Record<string, unknown>) => Promise<unknown[]>,
  ) => Promise<void>,
): Promise<void> {
  const methods = classifyServiceMethods(GROUP);
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "_lib"));
    await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
    await Deno.writeTextFile(
      join(dir, "things.ts"),
      generateModelSource(GROUP, methods, "2026.01.01.1"),
    );
    const { model } = await import(`file://${join(dir, "things.ts")}`);

    const captured: Captured[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const c: Captured = {
        method: init?.method ?? "GET",
        url: new URL(typeof input === "string" ? input : input.toString()),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      captured.push(c);
      return Promise.resolve(respond(c));
    }) as typeof fetch;

    const written: unknown[] = [];
    const context = {
      globalArgs: { apiToken: "tok", orgId: "org-1", version: "2024-10-15" },
      logger: { info() {} },
      writeResource: (spec: string, _name: string, data: unknown) => {
        // swamp rejects a write to a resource the model never declared.
        if (!model.resources[spec]) {
          throw new Error(`undeclared resource spec: ${spec}`);
        }
        written.push(data);
        return Promise.resolve({ name: _name });
      },
    };
    try {
      await fn(
        model,
        captured,
        async (method, args) => {
          await model.methods[method].execute(args, context);
          return written;
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data, links: { next: null } }), {
    status: 200,
  });

Deno.test("generated list: sends API names, comma and repeated arrays", async () => {
  await withGeneratedModel(
    () => ok([{ id: "1", attributes: { state: "open" } }]),
    async (_m, captured, run) => {
      await run("list_things", {
        meta_count: "with",
        provider: ["a", "b"],
        target_id: ["x", "y"],
      });
      const q = captured[0].url.searchParams;
      assertEquals(captured[0].url.pathname, "/rest/orgs/org-1/things");
      assertEquals(q.get("meta.count"), "with");
      assertEquals(q.has("meta_count"), false);
      assertEquals(q.getAll("provider"), ["a,b"]);
      assertEquals(q.getAll("target_id"), ["x", "y"]);
      assertEquals(q.get("limit"), "100");
    },
  );
});

Deno.test("generated list: a plain string still works for an array parameter", async () => {
  await withGeneratedModel(() => ok([]), async (_m, captured, run) => {
    await run("list_things", { provider: "a,b" });
    assertEquals(captured[0].url.searchParams.getAll("provider"), ["a,b"]);
  });
});

Deno.test("generated get/create/delete send their query parameters", async () => {
  await withGeneratedModel(
    (c) =>
      c.method === "DELETE"
        ? new Response(null, { status: 204 })
        : ok({ id: "t1", attributes: { state: "open" } }),
    async (_m, captured, run) => {
      await run("get_thing", { thing_id: "t 1", expand: ["a", "b"] });
      assertEquals(captured[0].url.pathname, "/rest/orgs/org-1/things/t%201");
      assertEquals(captured[0].url.searchParams.getAll("expand"), ["a,b"]);

      await run("create_thing", { name: "n", dry_run: true });
      assertEquals(captured[1].method, "POST");
      assertEquals(captured[1].url.searchParams.get("dry.run"), "true");
      // The query field is not duplicated into the request body.
      assertEquals(captured[1].body, { name: "n" });

      await run("delete_thing", { thing_id: "t1", force: false });
      assertEquals(captured[2].method, "DELETE");
      assertEquals(captured[2].url.searchParams.get("force"), "false");
    },
  );
});

Deno.test("generated write methods only write declared resources, whatever their verb prefix", async () => {
  await withGeneratedModel(
    () => ok({ id: "s1", attributes: { state: "open" } }),
    async (model, captured, run) => {
      const methods = classifyServiceMethods(GROUP);
      const secret = methods.find((m) => m.name === "update_thing_secret")!;
      assertEquals(secret.type, "create");
      assertEquals(resourceNameOf(secret), "thing_secret");
      assertEquals(Object.keys(model.resources).includes("thing_secret"), true);
      // Throws "undeclared resource spec" if the body writes update_thing_secret.
      await run("update_thing_secret", { thing_id: "t1", mode: "replace" });
      assertEquals(
        captured[0].url.pathname,
        "/rest/orgs/org-1/things/t1/secrets",
      );
    },
  );
});

Deno.test("generated response schemas tolerate unexpected enum values and missing fields", async () => {
  await withGeneratedModel(() => ok([]), (model) => {
    const resource = model.resources.things.schema;
    const item = { state: "brand-new-state", size: 0, extra: "kept" };
    // Parses: unknown enum value, constraint violation (size >= 1), extra key.
    const parsed = resource.parse({
      items: [item, {}],
      truncated: false,
      fetchedAt: "now",
    });
    assertEquals(parsed.items[0].extra, "kept");
    return Promise.resolve();
  });
});

Deno.test("generated request args stay strict", async () => {
  await withGeneratedModel(() => ok([]), (model) => {
    const args = model.methods.create_thing.arguments;
    assertEquals(args.safeParse({ name: "x" }).success, true);
    assertEquals(args.safeParse({}).success, false);
    return Promise.resolve();
  });
});

Deno.test("generated arg schema accepts a string or array for array query params", async () => {
  await withGeneratedModel(() => ok([]), (model) => {
    const args = model.methods.list_things.arguments;
    assertEquals(args.safeParse({ provider: "a" }).success, true);
    assertEquals(args.safeParse({ provider: ["a", "b"] }).success, true);
    assertEquals(args.safeParse({ provider: 5 }).success, false);
    return Promise.resolve();
  });
});

Deno.test("generated tests execute every method with unique names and exact paths", () => {
  const methods = classifyServiceMethods(GROUP);
  const src = generateTestSource(CONFIG, methods, "things");
  const names = [...src.matchAll(/name: "(things model: [^"]+)"/g)].map((m) =>
    m[1]
  );
  assertEquals(new Set(names).size, names.length);
  for (const m of methods) {
    assertStringIncludes(src, `things model: ${m.name} `);
    assertStringIncludes(src, `${m.name}.execute(`);
  }
  // Exact verb + path routing, query names as on the wire, 204 for DELETE.
  assertStringIncludes(src, '"GET /orgs/test-org-123/things"');
  assertStringIncludes(
    src,
    '"DELETE /orgs/test-org-123/things/test-id-123": { status: 204 }',
  );
  assertStringIncludes(src, 'query.getAll("meta.count"), ["with"]');
  assertStringIncludes(src, 'query.getAll("provider"), ["al pha,be&ta"]');
  assertStringIncludes(src, 'query.getAll("target_id"), ["al pha","be&ta"]');
  assertStringIncludes(src, 'query.getAll("dry.run"), ["true"]');
  // Write methods assert the exact body; reads assert there is none.
  assertStringIncludes(src, 'assertEquals(req0.body, {"name":"test-value"});');
  assertStringIncludes(src, "assertEquals(req0.body, null);");
  assertStringIncludes(src, "assertEquals(req0.path,");
});

Deno.test("generated test source is stable across runs", () => {
  const methods = classifyServiceMethods(GROUP);
  assertEquals(
    generateTestSource(CONFIG, methods, "things"),
    generateTestSource(CONFIG, methods, "things"),
  );
});

Deno.test("generated get/create fail on an empty 2xx body; delete accepts it", async () => {
  await withGeneratedModel(
    () => new Response(null, { status: 202 }),
    async (_m, captured, run) => {
      let msg = "";
      try {
        await run("get_thing", { thing_id: "t1" });
      } catch (e) {
        msg = (e as Error).message;
      }
      assertStringIncludes(msg, "empty response body");
      assertStringIncludes(msg, "get_thing");

      msg = "";
      try {
        await run("create_thing", { name: "n" });
      } catch (e) {
        msg = (e as Error).message;
      }
      assertStringIncludes(msg, "create_thing");

      // A delete legitimately answers without a body.
      await run("delete_thing", { thing_id: "t1" });
      assertEquals(captured.length, 3);
    },
  );
});

Deno.test("generated query args that collide with a path param reuse the path value", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "getThing",
        path: "/orgs/{org_id}/things/{thing_id}",
        pathParams: [{ name: "thing_id", in: "path", required: true }],
        queryParams: [{
          name: "thing-id",
          in: "query",
          schema: { type: "string" },
        }],
      }),
    ],
  };
  const src = generateModelSource(
    group,
    classifyServiceMethods(group),
    "2026.01.01.1",
  );
  // Only the path usage remains; the colliding query field is not emitted.
  assertEquals(src.includes('name: "thing-id"'), false);
});

Deno.test("a resource written by a list and a get/create accepts every writer's data", async () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "listWidgets",
        path: "/orgs/{org_id}/widgets",
        isCollection: true,
      }),
      op({
        operationId: "createWidgets",
        httpMethod: "post",
        path: "/orgs/{org_id}/widgets",
        isCollection: false,
        hasResponseBody: false,
        responseSchema: undefined,
        requestBody: { type: "object", properties: { n: { type: "string" } } },
      }),
      op({
        operationId: "getWidget",
        path: "/orgs/{org_id}/widgets/{widget_id}",
        pathParams: [{ name: "widget_id", in: "path", required: true }],
      }),
    ],
  };
  const methods = classifyServiceMethods(group);
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "_lib"));
    await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
    await Deno.writeTextFile(
      join(dir, "w.ts"),
      generateModelSource(group, methods, "2026.01.01.1"),
    );
    const { model } = await import(`file://${join(dir, "w.ts")}`);
    const schema = model.resources.widgets.schema;
    // List wrapper, the empty object a 204 create stores, and a flat get.
    assertEquals(
      schema.safeParse({
        items: [{ state: "x" }],
        truncated: false,
        fetchedAt: "t",
      })
        .success,
      true,
    );
    assertEquals(schema.safeParse({}).success, true);
    assertEquals(
      model.resources.widget.schema.safeParse({ state: "open" }).success,
      true,
    );
    // The flat shape keeps declared fields rather than stripping to {}.
    assertEquals(
      schema.safeParse({ id: "1", state: "open" }).data,
      { id: "1", state: "open" },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
