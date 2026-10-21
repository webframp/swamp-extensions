/**
 * Tests for the sensitivity analysis module.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  annotateSensitive,
  clearPublicFieldFlags,
  collectInputSecretNames,
  formatPath,
  isSensitiveArgField,
  isSensitiveFieldName,
  isSensitiveResponseField,
  prepareResponseSchema,
  vaultablePaths,
} from "./sensitivity.ts";
import type { OpenAPISpec, SchemaObject } from "./schema_fetcher.ts";

function specWith(schemas: Record<string, SchemaObject>): OpenAPISpec {
  return {
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0" },
    paths: {},
    components: { schemas },
  };
}

const ref = (name: string): SchemaObject => ({
  $ref: `#/components/schemas/${name}`,
});

// ---------------------------------------------------------------------------
// isSensitiveFieldName
// ---------------------------------------------------------------------------

Deno.test("isSensitiveFieldName: flags credentials in snake_case and camelCase", () => {
  for (
    const n of [
      "secret",
      "secrets",
      "password",
      "token",
      "client_secret",
      "private_key",
      "secret_access_key",
      "secretAccessKey",
      "sessionToken",
      "privateKey",
      "tunnel_secret",
      "cf_api_key",
      "auth_credentials",
      "api_key",
      "psk",
      "streamKey",
      "access_client_secret",
    ]
  ) {
    assertEquals(isSensitiveFieldName(n), true, n);
  }
});

Deno.test("isSensitiveFieldName: spares identifiers, counters and cursors", () => {
  for (
    const n of [
      "token_id",
      "secret_name",
      "secret_id",
      "secret_preview",
      "max_tokens",
      "input_tokens",
      "token_pricing",
      "client_secret_version",
      "previous_client_secret_expires_at",
      "page_token",
      "next_page_token",
      "continuation_token",
      "keyword_tokenizer",
      "accessKeyId",
      "parentAccessKeyId",
      "public_key",
      "key",
      "sitekey",
      "credential_status",
      "name",
      "web_analytics_token",
    ]
  ) {
    assertEquals(isSensitiveFieldName(n), false, n);
  }
});

Deno.test("isSensitiveFieldName: a boolean or numeric field is never a credential", () => {
  for (const type of ["boolean", "number", "integer"]) {
    for (const n of ["require_client_secret", "ttl_token", "secret"]) {
      assertEquals(isSensitiveFieldName(n, { type }), false, `${n}: ${type}`);
    }
  }
  assertEquals(
    isSensitiveFieldName("client_secret", { type: "string" }),
    true,
  );
  assertEquals(
    isSensitiveArgField("require_client_secret", { type: "boolean" }),
    false,
  );
  assertEquals(
    isSensitiveResponseField("access_token", { type: "integer" }),
    false,
  );
});

Deno.test("clearPublicFieldFlags: unflags the public Pages analytics tag only", () => {
  const spec = specWith({
    build_config: {
      type: "object",
      properties: {
        web_analytics_token: { type: "string", "x-sensitive": true },
        deploy_hook_secret: { type: "string", "x-sensitive": true },
      },
    },
  });
  clearPublicFieldFlags(spec);
  const props = spec.components!.schemas!.build_config.properties!;
  assertEquals(props.web_analytics_token["x-sensitive"], undefined);
  assertEquals(props.deploy_hook_secret["x-sensitive"], true);
  assertEquals(
    isSensitiveResponseField("web_analytics_token", props.web_analytics_token),
    false,
  );
});

// ---------------------------------------------------------------------------
// Field predicates
// ---------------------------------------------------------------------------

Deno.test("isSensitiveArgField: the spec's x-sensitive flag wins regardless of name", () => {
  assertEquals(
    isSensitiveArgField("text", { type: "string", "x-sensitive": true }),
    true,
  );
  assertEquals(isSensitiveArgField("text", { type: "string" }), false);
});

Deno.test("isSensitiveArgField: a credential-named container is marked whole only when nothing inside is", () => {
  // Values are opaque: the whole map must be redacted.
  assertEquals(
    isSensitiveArgField("secrets", {
      type: "object",
      additionalProperties: { type: "object" },
    }),
    true,
  );
  // The container declares its own secret leaf: mark the leaf, not the box.
  assertEquals(
    isSensitiveArgField("credentials", {
      type: "object",
      properties: {
        access_key_id: { type: "string" },
        secret_access_key: { type: "string" },
      },
    }),
    false,
  );
});

Deno.test("isSensitiveResponseField: write-only secrets are never marked on a resource", () => {
  assertEquals(
    isSensitiveResponseField("password", {
      type: "string",
      writeOnly: true,
      "x-sensitive": true,
    }),
    false,
  );
  assertEquals(
    isSensitiveArgField("password", {
      type: "string",
      writeOnly: true,
      "x-sensitive": true,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// annotateSensitive
// ---------------------------------------------------------------------------

Deno.test("annotateSensitive: flags a $ref whose target carries x-sensitive", () => {
  const spec = specWith({
    tunnel_secret: { type: "string", "x-sensitive": true },
    tunnel_name: { type: "string" },
  });
  const body: SchemaObject = {
    type: "object",
    properties: {
      tunnel_secret: ref("tunnel_secret"),
      name: ref("tunnel_name"),
    },
  };
  annotateSensitive(spec, body);
  assertEquals(body.properties!.tunnel_secret["x-swamp-sensitive"], true);
  assertEquals(body.properties!.name["x-swamp-sensitive"], undefined);
});

// ---------------------------------------------------------------------------
// prepareResponseSchema
// ---------------------------------------------------------------------------

Deno.test("prepareResponseSchema: a response without secrets is returned untouched", () => {
  const spec = specWith({});
  const schema: SchemaObject = {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
  };
  const { schema: out, secrets } = prepareResponseSchema(spec, schema);
  assertStrictEquals(out, schema);
  assertEquals(secrets, { wrapRoot: false, vaultable: [], leaves: [] });
});

Deno.test("prepareResponseSchema: a bare secret response is wrapped as { value }", () => {
  const spec = specWith({});
  const { secrets } = prepareResponseSchema(spec, {
    type: "string",
    "x-sensitive": true,
  });
  assertEquals(secrets.wrapRoot, true);
  assertEquals(secrets.vaultable, [["value"]]);
});

Deno.test("prepareResponseSchema: a top-level secret field is vaultable", () => {
  const spec = specWith({
    access_client_secret: { type: "string", "x-sensitive": true },
  });
  const { secrets } = prepareResponseSchema(spec, {
    type: "object",
    properties: {
      client_id: { type: "string" },
      client_secret: ref("access_client_secret"),
    },
  });
  assertEquals(secrets.vaultable, [["client_secret"]]);
  assertEquals(secrets.leaves, [[{ k: "client_secret" }]]);
});

Deno.test("prepareResponseSchema: an opaque $ref holding a secret is expanded into a passthrough skeleton", () => {
  const spec = specWith({
    stream_input_rtmps: {
      type: "object",
      properties: {
        streamKey: { type: "string", "x-sensitive": true },
        region: { type: "string" },
      },
    },
  });
  const { schema, secrets } = prepareResponseSchema(spec, {
    type: "object",
    properties: { uid: { type: "string" }, rtmps: ref("stream_input_rtmps") },
  });
  const rtmps = schema!.properties!.rtmps;
  assertEquals(rtmps["x-swamp-loose"], true);
  // Only the path to the secret is declared; region passes through.
  assertEquals(Object.keys(rtmps.properties!), ["streamKey"]);
  assertEquals(secrets.vaultable, [["rtmps", "streamKey"]]);
});

Deno.test("prepareResponseSchema: write-only secrets in a response are ignored", () => {
  const spec = specWith({
    db: {
      type: "object",
      properties: {
        host: { type: "string" },
        password: { type: "string", writeOnly: true, "x-sensitive": true },
      },
    },
  });
  const schema: SchemaObject = {
    type: "object",
    properties: { origin: ref("db") },
  };
  const { schema: out, secrets } = prepareResponseSchema(spec, schema);
  assertStrictEquals(out, schema);
  assertEquals(secrets.leaves, []);
});

Deno.test("prepareResponseSchema: a top-level union is flattened so variant secrets are vaultable", () => {
  const spec = specWith({
    github: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["github"] },
        config: {
          type: "object",
          properties: {
            client_id: { type: "string" },
            client_secret: { type: "string", "x-sensitive": true },
          },
        },
      },
    },
    okta: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["okta"] },
        config: {
          type: "object",
          properties: {
            okta_account: { type: "string" },
            client_secret: { type: "string", "x-sensitive": true },
          },
        },
      },
    },
  });
  const { schema, secrets } = prepareResponseSchema(spec, {
    anyOf: [ref("github"), ref("okta")],
  });
  assertEquals(schema!.type, "object");
  // The variants' configs disagree, so they merge into one skeleton that still
  // reaches client_secret instead of hiding the whole config in the vault.
  assertEquals(secrets.vaultable, [["config", "client_secret"]]);
});

Deno.test("prepareResponseSchema: a collection reports every secret for stripping, with union guards", () => {
  const spec = specWith({
    secret_env: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["secret_text"] },
        value: { type: "string", "x-sensitive": true },
      },
    },
    plain_env: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["plain_text"] },
        value: { type: "string" },
      },
    },
  });
  const item: SchemaObject = {
    type: "object",
    properties: {
      env_vars: {
        type: "object",
        additionalProperties: { oneOf: [ref("plain_env"), ref("secret_env")] },
      },
    },
  };
  const { schema, secrets } = prepareResponseSchema(spec, item, true);
  assertStrictEquals(schema, item);
  assertEquals(secrets.vaultable, []);
  assertEquals(secrets.leaves, [[
    { k: "env_vars" },
    { values: true },
    { k: "value", when: ["type", "secret_text"] },
  ]]);
  assertEquals(formatPath(secrets.leaves[0]), "env_vars{}.value");
});

Deno.test("vaultablePaths: name-flagged fields count, array items do not", () => {
  assertEquals(
    vaultablePaths({
      type: "object",
      properties: {
        client_secret: { type: "string" },
        tokens: {
          type: "array",
          items: { type: "object", properties: { token: { type: "string" } } },
        },
      },
    }),
    [["client_secret"]],
  );
});

// ---------------------------------------------------------------------------
// collectInputSecretNames
// ---------------------------------------------------------------------------

Deno.test("collectInputSecretNames: finds secrets nested in opaque $ref arguments", () => {
  const spec = specWith({
    database: {
      type: "object",
      properties: {
        host: { type: "string" },
        password: { type: "string", writeOnly: true, "x-sensitive": true },
      },
    },
  });
  const names = collectInputSecretNames(
    spec,
    {
      type: "object",
      properties: { name: { type: "string" }, origin: ref("database") },
    },
    [{ name: "page_token", schema: { type: "string" } }],
  );
  assertEquals(names, ["password"]);
});
