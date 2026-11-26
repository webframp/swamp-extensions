/**
 * A JSON:API `data` object with no `attributes` (`{data: {id, type}}`) is a
 * resource object: its own fields go beside `type`. The generated create must
 * ask for those fields and send them there, with the fixed `type` as a
 * constant, rather than wrapping them in `attributes`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyServiceMethods,
  generateModelSource,
} from "./method_classifier.ts";
import { groupOperations } from "./service_grouper.ts";
import type { OpenAPISpec } from "./schema_fetcher.ts";
import type { ServiceConfig } from "../config.ts";

const SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  components: {
    schemas: {
      WidgetType: { type: "string", enum: ["widgets"] },
      WidgetCreateData: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string", description: "The widget name." },
          type: { $ref: "#/components/schemas/WidgetType" },
        },
      },
      WidgetCreateRequest: {
        type: "object",
        required: ["data"],
        properties: {
          data: { $ref: "#/components/schemas/WidgetCreateData" },
        },
      },
    },
  },
  paths: {
    "/api/v2/widgets": {
      post: {
        operationId: "CreateWidget",
        tags: ["Widgets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WidgetCreateRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: { id: { type: "string" } },
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

const SERVICE: ServiceConfig = {
  name: "widgets",
  description: "Widgets",
  tags: ["Widgets"],
  labels: [],
};

function build() {
  const [group] = groupOperations(SPEC, [SERVICE]);
  const methods = classifyServiceMethods(group);
  const source = generateModelSource(group, methods, "2026.01.01.1");
  return { group, source };
}

Deno.test("grouper marks an attribute-less data object as a resource object", () => {
  const { group } = build();
  const post = group.operations[0];
  assertEquals(post.requestBodyIsResourceObject, true);
  assertEquals(post.requestBodyType, "widgets");
  assertEquals(Object.keys(post.requestBody?.properties ?? {}), ["id"]);
});

Deno.test("generated create asks for id and sends it beside the fixed type", () => {
  const { source } = build();
  assertStringIncludes(source, 'id: z.string().describe("The widget name.")');
  assertStringIncludes(source, 'type: "widgets", ...attrs');
  assertEquals(source.includes("attributes: attrs"), false);
  assertEquals(source.includes("type: z.unknown()"), false);
});
