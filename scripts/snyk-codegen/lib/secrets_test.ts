// SPDX-License-Identifier: Apache-2.0
/**
 * Secret handling in generated Snyk models: which fields count as secrets,
 * how they are marked so swamp vaults them, what lists do with them, and the
 * README guidance that goes with them.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { ServiceConfig } from "../config.ts";
import { generateApiLib, generateReadme } from "./extension_generator.ts";
import {
  classifyServiceMethods,
  generateModelSource,
  secretArgumentPaths,
} from "./method_classifier.ts";
import type { GroupedOperation, ServiceGroup } from "./service_grouper.ts";
import { isSensitiveFieldName, schemaToZod } from "./type_mapper.ts";

const CONFIG: ServiceConfig = {
  name: "keys",
  description: "Keys",
  pathPrefixes: ["/orgs/{org_id}/keys"],
  scope: "org",
  labels: [],
};

const ACCOUNT = {
  type: "object",
  properties: {
    name: { type: "string" },
    client_secret: { type: "string", example: "looks-like-a-real-secret" },
    access_token_expires_at: { type: "string" },
  },
};

function op(partial: Partial<GroupedOperation>): GroupedOperation {
  return {
    httpMethod: "get",
    path: "/orgs/{org_id}/keys",
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
    responseSchema: ACCOUNT,
    ...partial,
  };
}

const ID_PARAM = { name: "key_id", in: "path" as const, required: true };

const GROUP: ServiceGroup = {
  config: CONFIG,
  operations: [
    op({ operationId: "listKeys", isCollection: true }),
    op({
      operationId: "createKey",
      httpMethod: "post",
      requestBody: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    }),
    // Rotation: the caller sends a secret nested in the JSON:API body, and the
    // response carries a field the first writer's schema does not declare.
    op({
      operationId: "updateKeySecret",
      httpMethod: "post",
      path: "/orgs/{org_id}/keys/{key_id}/secrets",
      pathParams: [ID_PARAM],
      responseSchema: {
        type: "object",
        properties: {
          client_secret: { type: "string" },
          api_key: { type: "string" },
        },
      },
      requestBody: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              attributes: {
                type: "object",
                properties: {
                  mode: { type: "string" },
                  secret: { type: "string" },
                },
              },
            },
          },
        },
      },
    }),
  ],
};

interface ZodNode {
  _zod: {
    def: {
      type: string;
      innerType?: ZodNode;
      shape?: Record<string, ZodNode>;
    };
  };
  meta(): Record<string, unknown> | undefined;
}

const WRAPPERS = new Set(["optional", "nullable", "default"]);

/** Paths swamp vaults: sensitive fields reached through object shapes only. */
function vaultedPaths(schema: unknown, prefix = ""): string[] {
  let node = schema as ZodNode;
  while (WRAPPERS.has(node._zod.def.type) && node._zod.def.innerType) {
    node = node._zod.def.innerType;
  }
  if (node._zod.def.type !== "object") return [];
  const out: string[] = [];
  for (const [key, field] of Object.entries(node._zod.def.shape ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (let n: ZodNode | undefined = field; n;) {
      if (n.meta()?.sensitive === true) {
        out.push(path);
        break;
      }
      n = WRAPPERS.has(n._zod.def.type) ? n._zod.def.innerType : undefined;
    }
    out.push(...vaultedPaths(field, path));
  }
  return out;
}

/** Generate, write and import a model for `group`, then run `fn`. */
async function withModel(
  group: ServiceGroup,
  respond: (req: { method: string; url: URL }) => unknown,
  fn: (
    // deno-lint-ignore no-explicit-any
    model: any,
    run: (method: string, args: Record<string, unknown>) => Promise<{
      written: Record<string, unknown>[];
      logs: string[];
    }>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const original = globalThis.fetch;
  try {
    await Deno.mkdir(join(dir, "_lib"));
    await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
    await Deno.writeTextFile(
      join(dir, "keys.ts"),
      generateModelSource(group, classifyServiceMethods(group), "2026.01.01.1"),
    );
    const { model } = await import(`file://${join(dir, "keys.ts")}`);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const data = respond({ method: init?.method ?? "GET", url });
      return Promise.resolve(
        new Response(JSON.stringify({ data, links: { next: null } })),
      );
    }) as typeof fetch;
    await fn(model, async (method, args) => {
      const written: Record<string, unknown>[] = [];
      const logs: string[] = [];
      await model.methods[method].execute(args, {
        globalArgs: { apiToken: "tok", orgId: "org-1", version: "2024-10-15" },
        logger: { info: (msg: string) => logs.push(msg) },
        writeResource: (spec: string, name: string, data: unknown) => {
          if (!model.resources[spec]) throw new Error(`undeclared ${spec}`);
          written.push(data as Record<string, unknown>);
          return Promise.resolve({ name });
        },
      });
      return { written, logs };
    });
  } finally {
    globalThis.fetch = original;
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("isSensitiveFieldName: matches secret names exactly", () => {
  for (
    const name of [
      "client_secret",
      "api_key",
      "access_token",
      "secret",
      "token",
      "password",
      "private_key",
      "refresh_token",
    ]
  ) {
    assertEquals(isSensitiveFieldName(name), true, name);
  }
});

Deno.test("isSensitiveFieldName: does not match fields named after a secret", () => {
  // Every one of these appears in the Snyk spec and holds no secret value.
  for (
    const name of [
      "access_token_expires_at",
      "access_token_ttl_seconds",
      "personal_access_token_id",
      "credential_id",
      "secrets",
      "secrets_enabled",
      "client_id",
      "auth_type",
      "key",
      "key_asset",
      "rule_keys",
      "keys_only",
      "component_key",
      "environment_variable_name",
      "Secret",
      "client_secret_hint",
    ]
  ) {
    assertEquals(isSensitiveFieldName(name), false, name);
  }
});

Deno.test("schemaToZod: marks secret properties sensitive at any depth", () => {
  const zod = schemaToZod({
    type: "object",
    properties: {
      client_secret: { type: "string" },
      access_token_expires_at: { type: "string" },
      nested: { type: "object", properties: { token: { type: "string" } } },
    },
  }, { lenient: true });
  assert(zod.includes("client_secret: z.string().meta({ sensitive: true })"));
  assert(zod.includes("token: z.string().meta({ sensitive: true })"));
  assert(
    !/access_token_expires_at: z\.string\(\)\.meta/.test(zod),
    "a non-secret field was marked sensitive",
  );
});

Deno.test("schemaToZod: a request-side secret says to supply it from a vault", () => {
  const zod = schemaToZod({
    type: "object",
    properties: { secret: { type: "string" } },
  });
  assert(zod.includes(".meta({ sensitive: true })"));
  assert(zod.includes("vault.get"));
  // Response-side schemas carry no argument guidance.
  const lenient = schemaToZod({
    type: "object",
    properties: { secret: { type: "string" } },
  }, { lenient: true });
  assert(!lenient.includes("vault.get"));
});

Deno.test("generated globalArgs: apiToken is sensitive and points at the vault", async () => {
  await withModel(GROUP, () => ({}), (model) => {
    const shape = model.globalArguments.shape;
    assertEquals(shape.apiToken.meta()?.sensitive, true);
    assert(String(shape.apiToken.description).includes('vault.get("snyk"'));
    return Promise.resolve();
  });
});

Deno.test("generated create: a returned secret is declared sensitive on the resource", async () => {
  await withModel(
    GROUP,
    () => ({
      id: "k1",
      attributes: { name: "n", client_secret: "minted-value" },
    }),
    async (model, run) => {
      const { written } = await run("create_key", { name: "n" });
      // The model hands swamp the secret; swamp's writer moves every path
      // the schema marks sensitive into a vault before it persists anything.
      assertEquals(written[0].client_secret, "minted-value");
      const paths = vaultedPaths(model.resources.key.schema);
      assert(paths.includes("client_secret"), JSON.stringify(paths));
      assert(!paths.includes("access_token_expires_at"));
    },
  );
});

Deno.test("generated resource: declares a secret only a later writer returns", async () => {
  await withModel(
    GROUP,
    () => ({ id: "k1", attributes: { client_secret: "a", api_key: "b" } }),
    async (model, run) => {
      const { written } = await run("update_key_secret", {
        key_id: "k1",
        data: { attributes: { mode: "replace", secret: "s" } },
      });
      assertEquals(written[0].api_key, "b");
      const paths = vaultedPaths(model.resources.key_secret.schema);
      assert(paths.includes("client_secret"));
      assert(paths.includes("api_key"));
    },
  );
});

Deno.test("generated resource: a secret the first writer omits is still declared", () => {
  // Two flat writers of one resource; only the second returns api_key.
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({
        operationId: "getKey",
        path: "/orgs/{org_id}/keys/{key_id}",
        pathParams: [ID_PARAM],
        responseSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }),
      op({
        operationId: "updateKey",
        httpMethod: "patch",
        path: "/orgs/{org_id}/keys/{key_id}",
        pathParams: [ID_PARAM],
        responseSchema: {
          type: "object",
          properties: { api_key: { type: "string" } },
        },
      }),
    ],
  };
  const source = generateModelSource(
    group,
    classifyServiceMethods(group),
    "2026.01.01.1",
  );
  assert(
    source.includes("api_key: z.unknown().meta({ sensitive: true }).nullish()"),
    "the second writer's secret is not declared on the shared resource",
  );
});

Deno.test("generated list: drops item secrets swamp cannot vault inside an array", async () => {
  await withModel(
    GROUP,
    () => [
      { id: "1", attributes: { name: "a", client_secret: "leaked" } },
      { id: "2", attributes: { name: "b", client_secret: null } },
    ],
    async (_model, run) => {
      const { written, logs } = await run("list_keys", {});
      const items = written[0].items as Record<string, unknown>[];
      assertEquals(JSON.stringify(written[0]).includes("leaked"), false);
      assertEquals("client_secret" in items[0], false);
      // A null carries no secret and is left as the API sent it.
      assertEquals(items[1].client_secret, null);
      assertEquals(items[0].name, "a");
      assert(logs.some((l) => l.includes("dropped")));
    },
  );
});

Deno.test("generated create: secrets in an array response are dropped", async () => {
  await withModel(
    GROUP,
    () => [{ id: "1", attributes: { client_secret: "leaked" } }],
    async (_model, run) => {
      const { written } = await run("create_key", { name: "n" });
      assertEquals(JSON.stringify(written[0]).includes("leaked"), false);
    },
  );
});

Deno.test("generator refuses a secret-bearing resource swamp would not vault", () => {
  // list_x and get_x share resource "x", so its schema is a union, which
  // swamp does not walk for sensitive fields.
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [
      op({ operationId: "listKeys", isCollection: true }),
      op({ operationId: "getKeys" }),
    ],
  };
  assertThrows(
    () =>
      generateModelSource(group, classifyServiceMethods(group), "2026.1.1.1"),
    Error,
    "cannot vault fields inside a union",
  );
});

Deno.test("secretArgumentPaths: finds nested body secrets", () => {
  const methods = classifyServiceMethods(GROUP);
  const update = methods.find((m) => m.name === "update_key_secret")!;
  assertEquals(secretArgumentPaths(update), ["data.attributes.secret"]);
  const create = methods.find((m) => m.name === "create_key")!;
  assertEquals(secretArgumentPaths(create), []);
});

Deno.test("generated README: credentials come from a vault", () => {
  const readme = generateReadme(CONFIG, classifyServiceMethods(GROUP));
  assert(readme.includes("## Credentials"));
  assert(readme.includes("swamp vault put snyk API_TOKEN"));
  assert(
    readme.includes(
      `--global-arg 'apiToken=\${{ vault.get("snyk", "API_TOKEN") }}'`,
    ),
  );
  assert(!readme.includes("apiToken=SNYK_API_TOKEN"));
});

Deno.test("generated README: notes secret-returning methods and secret arguments", () => {
  const readme = generateReadme(CONFIG, classifyServiceMethods(GROUP));
  assert(readme.includes("## Secrets"));
  assert(readme.includes("| `create_key` | `client_secret` |"));
  assert(
    readme.includes("| `update_key_secret` | `client_secret` and `api_key` |"),
  );
  assert(readme.includes("`list_keys` drops any `client_secret` value"));
  assert(readme.includes("| `update_key_secret` | `data.attributes.secret` |"));
});

Deno.test("generated README: a model with secret output needs a vault for every method", () => {
  const readme = generateReadme(CONFIG, classifyServiceMethods(GROUP)).replace(
    /\s+/g,
    " ",
  );
  // swamp infers list_keys's kind from its name: not a read, so it is
  // refused too. Stated under both Credentials and Secrets.
  const sentence =
    "swamp refuses to run any of its methods, reads included, until a vault exists";
  assertEquals(readme.split(sentence).length - 1, 2);
  assert(!readme.includes("the write fails rather than store"));
});

Deno.test("generated README: no Secrets section for a service without secrets", () => {
  const group: ServiceGroup = {
    config: CONFIG,
    operations: [op({
      operationId: "listKeys",
      isCollection: true,
      responseSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    })],
  };
  const readme = generateReadme(CONFIG, classifyServiceMethods(group));
  assert(!readme.includes("## Secrets"));
  assert(!readme.includes("refuses to run"));
  assert(readme.includes("## Credentials"));
});
