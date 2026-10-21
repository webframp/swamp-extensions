/**
 * Secret handling in generated models: credential-named and configured fields
 * get `.meta({ sensitive: true })` where swamp honours it, the API keys are
 * documented as vault-only, and generation fails rather than emit a marker
 * swamp cannot act on.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { isSensitiveFieldName, tokenizeFieldName } from "./sensitive.ts";
import { schemaToZod, type SensitiveMark } from "./type_mapper.ts";
import {
  classifyServiceMethods,
  generateModelSource,
  sensitiveArgNames,
  sensitiveResponsePaths,
} from "./method_classifier.ts";
import { groupOperations } from "./service_grouper.ts";
import { generateApiLib, generateReadme } from "./extension_generator.ts";
import { generateTestSource } from "./test_generator.ts";
import type { OpenAPISpec, SchemaObject } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

Deno.test("tokenizeFieldName splits snake, kebab and camel case", () => {
  assertEquals(tokenizeFieldName("clientSecret"), ["client", "secret"]);
  assertEquals(tokenizeFieldName("api_key"), ["api", "key"]);
  assertEquals(tokenizeFieldName("DD-API-KEY"), ["dd", "api", "key"]);
  assertEquals(tokenizeFieldName("creationAuthorId"), [
    "creation",
    "author",
    "id",
  ]);
});

Deno.test("isSensitiveFieldName matches credential-named fields", () => {
  for (
    const name of [
      "secret",
      "client_secret",
      "clientSecret",
      "webhook_secret",
      "password",
      "passwd",
      "passphrase",
      "credentials",
      "auth_credentials",
      "api_key",
      "apiKey",
      "apikey",
      "app_key",
      "application_key",
      "private_key",
      "privateKey",
      "signing_key",
      "secret_key",
      "secret_access_key",
      "secret_value",
      "token",
      "access_token",
      "refresh_token",
      "auth_token",
      "authorization",
    ]
  ) {
    assertEquals(isSensitiveFieldName(name), true, name);
  }
});

Deno.test("isSensitiveFieldName does not over-match", () => {
  // Names found in the Datadog v2 operations this generator emits, plus
  // near-misses that only look like credentials.
  for (
    const name of [
      "author",
      "author_uuid",
      "creationAuthorId",
      "updateAuthorId",
      "session_id",
      "cert",
      "certificate",
      "fingerprint",
      "fingerprint256",
      "secure",
      "is_totp",
      "is_fido",
      "key",
      "tag_key",
      "bucketKey",
      "api_key_id",
      "secret_name",
      "token_count",
      "max_tokens",
      "page_token",
      "next_token",
      "pageToken",
      "has_password",
      "is_secret",
      "auth_type",
      "public_id",
    ]
  ) {
    assertEquals(isSensitiveFieldName(name), false, name);
  }
});

Deno.test("isSensitiveFieldName ignores non-string scalars", () => {
  assertEquals(isSensitiveFieldName("password", { type: "boolean" }), false);
  assertEquals(isSensitiveFieldName("token", { type: "integer" }), false);
  assertEquals(isSensitiveFieldName("password", { type: "string" }), true);
});

// ---------------------------------------------------------------------------
// Type mapper
// ---------------------------------------------------------------------------

Deno.test("schemaToZod marks named and configured fields and tracks reachability", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      name: { type: "string" },
      client_secret: { type: "string" },
      value: {
        type: "object",
        properties: { value: { type: "string" }, secure: { type: "boolean" } },
      },
      keys: {
        type: "array",
        items: { type: "object", properties: { token: { type: "string" } } },
      },
      byName: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { password: { type: "string" } },
        },
      },
    },
  };
  const marks: SensitiveMark[] = [];
  const src = schemaToZod(schema, {
    isSensitiveName: isSensitiveFieldName,
    sensitivePaths: ["value.value"],
    marks,
  });
  assertEquals(
    marks.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "byName{}.password", reachable: false },
      { path: "client_secret", reachable: true },
      { path: "keys[].token", reachable: false },
      { path: "value.value", reachable: true },
    ],
  );
  assertStringIncludes(
    src,
    "client_secret: z.string().meta({ sensitive: true }).optional()",
  );
  assertEquals(src.includes("name: z.string().meta"), false);
});

Deno.test("schemaToZod without sensitive options emits no markers", () => {
  const src = schemaToZod({
    type: "object",
    properties: { client_secret: { type: "string" } },
  });
  assertEquals(src.includes("sensitive"), false);
});

// ---------------------------------------------------------------------------
// Generated model
// ---------------------------------------------------------------------------

const SERVICE: ServiceConfig = {
  name: "vars",
  description: "Vars",
  tags: ["Vars"],
  labels: [],
};

function jsonApi(attributes: SchemaObject) {
  return {
    "200": {
      description: "ok",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  attributes,
                },
              },
            },
          },
        },
      },
    },
  };
}

function jsonApiBody(attributes: SchemaObject) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: { type: { type: "string" }, attributes },
            },
          },
        },
      },
    },
  };
}

const VARIABLE_ATTRS: SchemaObject = {
  type: "object",
  properties: {
    name: { type: "string" },
    value: {
      type: "object",
      properties: { secure: { type: "boolean" }, value: { type: "string" } },
    },
  },
};

function spec(overrides: {
  patchBody?: SchemaObject;
  patchResponse?: SchemaObject;
  thingResponse?: SchemaObject;
} = {}): OpenAPISpec {
  return {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    components: { schemas: {} },
    paths: {
      "/api/v2/synthetics/variables/{variable_id}/jsonpatch": {
        patch: {
          // Real operationId, so the shipped SENSITIVE_* config applies.
          operationId: "PatchGlobalVariable",
          tags: ["Vars"],
          parameters: [{
            name: "variable_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: jsonApiBody(
            overrides.patchBody ?? {
              type: "object",
              properties: {
                json_patch: { type: "array", items: { type: "object" } },
              },
            },
          ),
          responses: jsonApi(overrides.patchResponse ?? VARIABLE_ATTRS),
        },
      },
      "/api/v2/things": {
        post: {
          operationId: "CreateThing",
          tags: ["Vars"],
          requestBody: jsonApiBody({
            type: "object",
            properties: {
              name: { type: "string" },
              api_key: { type: "string" },
              config: {
                type: "object",
                properties: {
                  username: { type: "string" },
                  password: { type: "string" },
                },
              },
            },
          }),
          responses: jsonApi(
            overrides.thingResponse ?? {
              type: "object",
              properties: {
                name: { type: "string" },
                client_secret: { type: "string" },
                page_token: { type: "string" },
              },
            },
          ),
        },
      },
    },
  } as unknown as OpenAPISpec;
}

function build(s = spec()) {
  const [group] = groupOperations(s, [SERVICE]);
  const methods = classifyServiceMethods(group);
  return { group, methods };
}

type ZodLike = {
  meta?: () => Record<string, unknown> | undefined;
  description?: string;
  _zod?: { def?: { innerType?: ZodLike; shape?: Record<string, ZodLike> } };
};

function marked(schema: ZodLike | undefined): boolean {
  for (let cur = schema; cur; cur = cur._zod?.def?.innerType) {
    if (cur.meta?.()?.sensitive === true) return true;
  }
  return false;
}

function field(schema: ZodLike, path: string): ZodLike | undefined {
  let cur: ZodLike | undefined = schema;
  for (const part of path.split(".")) {
    while (cur?._zod?.def?.innerType) cur = cur._zod.def.innerType;
    cur = cur?._zod?.def?.shape?.[part];
  }
  return cur;
}

/** Write the generated model next to its _lib and import it. */
async function importModel(source: string) {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "_lib"));
  await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
  await Deno.writeTextFile(join(dir, "vars.ts"), source);
  try {
    const mod = await import(`file://${join(dir, "vars.ts")}`);
    return mod.model as {
      globalArguments: ZodLike;
      resources: Record<string, { schema: ZodLike }>;
      methods: Record<string, { arguments: ZodLike }>;
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("generated model marks API keys, secret args and returned secrets", async () => {
  const { group, methods } = build();
  const model = await importModel(
    generateModelSource(group, methods, "2026.01.01.1"),
  );

  // Global args: sensitive, and the describe text points at the vault.
  for (
    const [key, vaultKey] of [["apiKey", "API_KEY"], ["appKey", "APP_KEY"]]
  ) {
    const f = field(model.globalArguments, key)!;
    assertEquals(marked(f), true, key);
    assertStringIncludes(
      String(f.meta?.()?.description),
      `vault.get("datadog", "${vaultKey}")`,
    );
  }
  assertEquals(marked(field(model.globalArguments, "site")), false);

  // Returned secrets: configured (value.value) and named (client_secret).
  const variable = model.resources["patch_global_variable"].schema;
  assertEquals(marked(field(variable, "value.value")), true);
  assertEquals(marked(field(variable, "value.secure")), false);
  assertEquals(marked(field(variable, "name")), false);
  const thing = model.resources["thing"].schema;
  assertEquals(marked(field(thing, "client_secret")), true);
  assertEquals(marked(field(thing, "page_token")), false);
  assertEquals(marked(field(thing, "name")), false);

  // Secret-valued args: configured (json_patch), named (api_key), nested.
  const patchArgs = model.methods["patch_global_variable"].arguments;
  assertEquals(marked(field(patchArgs, "json_patch")), true);
  assertEquals(marked(field(patchArgs, "variable_id")), false);
  const createArgs = model.methods["create_thing"].arguments;
  assertEquals(marked(field(createArgs, "api_key")), true);
  assertEquals(marked(field(createArgs, "config.password")), true);
  assertEquals(marked(field(createArgs, "config.username")), false);
  assertEquals(marked(field(createArgs, "name")), false);
  assertStringIncludes(
    String(field(createArgs, "api_key")?.meta?.()?.description),
    "Secret: supply it with a vault.get expression",
  );
  assertStringIncludes(
    String(field(patchArgs, "json_patch")?.meta?.()?.description),
    "Can carry a secret: put it in a vault.get expression",
  );
});

Deno.test("sensitiveResponsePaths and sensitiveArgNames report what is marked", () => {
  const { methods } = build();
  const patch = methods.find((m) => m.name === "patch_global_variable")!;
  const create = methods.find((m) => m.name === "create_thing")!;
  assertEquals(sensitiveResponsePaths(patch, methods), ["value.value"]);
  assertEquals(sensitiveResponsePaths(create, methods), ["client_secret"]);
  assertEquals(sensitiveArgNames(patch.operation), ["json_patch"]);
  assertEquals(sensitiveArgNames(create.operation), ["api_key"]);
});

Deno.test("generation fails when a returned secret sits where swamp cannot vault it", () => {
  const { group, methods } = build(spec({
    thingResponse: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: {
            type: "object",
            properties: { client_secret: { type: "string" } },
          },
        },
      },
    },
  }));
  assertThrows(
    () => generateModelSource(group, methods, "2026.01.01.1"),
    Error,
    "keys[].client_secret",
  );
});

Deno.test("generation fails when a configured response path is not declared", () => {
  const { group, methods } = build(spec({
    patchResponse: { type: "object", properties: { name: { type: "string" } } },
  }));
  assertThrows(
    () => generateModelSource(group, methods, "2026.01.01.1"),
    Error,
    '"value.value"',
  );
});

Deno.test("generation fails when a configured secret argument is missing", () => {
  const { group, methods } = build(spec({
    patchBody: { type: "object", properties: { name: { type: "string" } } },
  }));
  assertThrows(
    () => generateModelSource(group, methods, "2026.01.01.1"),
    Error,
    '"json_patch"',
  );
});

Deno.test("generated tests cover sensitive markers and returned secrets", () => {
  const { group, methods } = build();
  const src = generateTestSource(group.config, methods, "vars");
  assertStringIncludes(
    src,
    "vars model: apiKey and appKey are marked sensitive",
  );
  assertStringIncludes(
    src,
    "vars model: patch_global_variable marks secret arguments sensitive",
  );
  assertStringIncludes(
    src,
    "vars model: patch_global_variable leaves returned secrets to the vault",
  );
  assertStringIncludes(
    src,
    "vars model: create_thing leaves returned secrets to the vault",
  );
  // The secret is planted in the mock response under JSON:API attributes.
  assertStringIncludes(
    src,
    '"value":{"secure":true,"value":"secret-sentinel-patch_global_variable"}',
  );
});

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

Deno.test("README wires both keys from the datadog vault, never a literal", () => {
  const readme = generateReadme(SERVICE, []);
  assertStringIncludes(readme, "## Credentials");
  assertStringIncludes(readme, "swamp vault put datadog API_KEY");
  assertStringIncludes(readme, "swamp vault put datadog APP_KEY");
  assertStringIncludes(
    readme,
    `--global-arg 'apiKey=\${{ vault.get("datadog", "API_KEY") }}'`,
  );
  assertStringIncludes(
    readme,
    `--global-arg 'appKey=\${{ vault.get("datadog", "APP_KEY") }}'`,
  );
  assertEquals(readme.includes("DD_API_KEY"), false);
  assertEquals(readme.includes("DD_APP_KEY"), false);
  assertEquals(readme.includes("## Secrets"), false);
});

Deno.test("README lists returned secrets when a method receives them", () => {
  const readme = generateReadme(SERVICE, [], [
    { method: "patch_global_variable", paths: ["value.value"] },
  ]);
  assertStringIncludes(readme, "## Secrets");
  assertStringIncludes(readme, "| `patch_global_variable` | `value.value` |");
});
