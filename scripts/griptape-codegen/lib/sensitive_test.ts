/**
 * Tests for credential detection in request and response schemas.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import {
  isNestedSensitiveFieldName,
  scanSensitive,
  sensitivePaths,
  withSensitiveMarkers,
} from "./sensitive.ts";
import { sensitiveRequestFields } from "./service_grouper.ts";
import { schemaToZod } from "./type_mapper.ts";

/** A trimmed copy of the Griptape data-connector schemas. */
const spec = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths: {},
  components: {
    schemas: {
      ConnectorDetail: {
        type: "object",
        properties: {
          data_connector_id: { type: "string" },
          config: { $ref: "#/components/schemas/ConfigUnion" },
          env_vars: {
            type: "array",
            items: { $ref: "#/components/schemas/EnvVar" },
          },
        },
      },
      ConfigUnion: {
        oneOf: [
          {
            type: "object",
            properties: {
              google_drive: { $ref: "#/components/schemas/GoogleDrive" },
            },
          },
          {
            type: "object",
            properties: {
              s3: {
                type: "object",
                properties: {
                  bucket: { type: "string" },
                  aws_secret_access_key: { type: "string" },
                },
              },
            },
          },
        ],
      },
      GoogleDrive: {
        type: "object",
        properties: {
          access_token: { type: "string" },
          file_ids: { type: "array", items: { type: "string" } },
        },
      },
      EnvVar: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
      },
      Looped: {
        type: "object",
        properties: {
          child: { $ref: "#/components/schemas/Looped" },
          name: { type: "string" },
        },
      },
      KbConfigs: {
        type: "object",
        properties: {
          configs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                pg: {
                  type: "object",
                  properties: { password: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as OpenAPISpec;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

Deno.test("isNestedSensitiveFieldName: bare value is data below the top level", () => {
  assertEquals(isNestedSensitiveFieldName("value"), false);
  assertEquals(isNestedSensitiveFieldName("access_token"), true);
  assertEquals(isNestedSensitiveFieldName("password"), true);
});

Deno.test("scanSensitive: follows $refs and merges union variants", () => {
  const { tree, unreachable } = scanSensitive(spec, ref("ConnectorDetail"));
  assertEquals(tree, {
    config: {
      google_drive: { access_token: true },
      s3: { aws_secret_access_key: true },
    },
  });
  // env_vars[].value is ordinary data, so nothing is unreachable here.
  assertEquals(unreachable, []);
  assertEquals(sensitivePaths(tree), [
    ["config", "google_drive", "access_token"],
    ["config", "s3", "aws_secret_access_key"],
  ]);
});

Deno.test("scanSensitive: reports credentials under an array as unreachable", () => {
  const { tree, unreachable } = scanSensitive(spec, ref("KbConfigs"));
  assertEquals(tree, {});
  assertEquals(unreachable, ["configs[].pg.password"]);
});

Deno.test("scanSensitive: a top-level value is a credential (Secrets)", () => {
  const { tree } = scanSensitive(spec, {
    type: "object",
    properties: { name: { type: "string" }, value: { type: "string" } },
  });
  assertEquals(tree, { value: true });
});

Deno.test("scanSensitive: terminates on circular refs", () => {
  assertEquals(scanSensitive(spec, ref("Looped")).tree, {});
});

Deno.test("sensitiveRequestFields: flags the top-level argument holding a nested credential", () => {
  assertEquals(sensitiveRequestFields(spec, ref("ConnectorDetail")), [
    "config",
  ]);
  assertEquals(sensitiveRequestFields(spec, ref("KbConfigs")), ["configs"]);
  assertEquals(sensitiveRequestFields(spec, ref("EnvVar")), ["value"]);
  assertEquals(sensitiveRequestFields(spec, ref("GoogleDrive")), [
    "access_token",
  ]);
  assertEquals(
    sensitiveRequestFields(spec, {
      type: "object",
      properties: { name: { type: "string" } },
    }),
    [],
  );
});

Deno.test("withSensitiveMarkers: emits a declared path with a sensitive leaf in response mode", () => {
  const entity = {
    type: "object",
    properties: { data_connector_id: { type: "string" }, config: ref("X") },
  };
  const marked = withSensitiveMarkers(entity, {
    config: { google_drive: { access_token: true } },
  });
  const zod = schemaToZod(marked, { indent: 2, mode: "response" }, 1);
  assertStringIncludes(zod, "data_connector_id: z.string().nullish()");
  assertStringIncludes(zod, "config: z.looseObject({");
  assertStringIncludes(zod, "google_drive: z.looseObject({");
  assertStringIncludes(
    zod,
    "access_token: z.unknown().meta({ sensitive: true }).nullish()",
  );
  // The input schema is not mutated.
  assertEquals(entity.properties.config, ref("X"));
});

Deno.test("withSensitiveMarkers: a top-level leaf keeps its type", () => {
  const marked = withSensitiveMarkers({
    type: "object",
    properties: { token: { type: "string" } },
  }, { token: true });
  assertStringIncludes(
    schemaToZod(marked, { indent: 2, mode: "response" }, 1),
    "token: z.string().meta({ sensitive: true }).nullish()",
  );
});
