// AWS Pricing Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { PricingClient } from "npm:@aws-sdk/client-pricing@3.1010.0";
import { model } from "./pricing.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockPricing(handler: (command: unknown) => unknown): () => void {
  const original = PricingClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  PricingClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    PricingClient.prototype.send = original;
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/pricing");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region defaulting to us-east-1", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines expected resources", () => {
  assertEquals("services" in model.resources, true);
  assertEquals("attributes" in model.resources, true);
  assertEquals("prices" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("list_services" in model.methods, true);
  assertEquals("get_attribute_values" in model.methods, true);
  assertEquals("get_price" in model.methods, true);
  assertEquals("get_ec2_price" in model.methods, true);
});

// =============================================================================
// list_services Tests
// =============================================================================

Deno.test({
  name: "list_services returns services and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockPricing(() => ({
      Services: [
        {
          ServiceCode: "AmazonEC2",
          AttributeNames: ["instanceType", "location"],
        },
        {
          ServiceCode: "AmazonRDS",
          AttributeNames: ["instanceType", "databaseEngine"],
        },
      ],
      NextToken: undefined,
    }));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-pricing",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.list_services.execute(
        { serviceCode: undefined },
        context as unknown as Parameters<
          typeof model.methods.list_services.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "services");
      assertEquals(resources[0].name, "all");

      const data = resources[0].data as {
        services: Array<{
          serviceCode: string;
          attributeNames: string[];
        }>;
        fetchedAt: string;
      };
      assertEquals(data.services.length, 2);
      assertEquals(data.services[0].serviceCode, "AmazonEC2");
      assertEquals(data.services[0].attributeNames, [
        "instanceType",
        "location",
      ]);
      assertEquals(data.services[1].serviceCode, "AmazonRDS");
      assertEquals(data.services[1].attributeNames, [
        "instanceType",
        "databaseEngine",
      ]);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_attribute_values Tests
// =============================================================================

Deno.test({
  name: "get_attribute_values returns sorted values and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockPricing(() => ({
      AttributeValues: [
        { Value: "t3.medium" },
        { Value: "t3.large" },
        { Value: "m5.xlarge" },
      ],
      NextToken: undefined,
    }));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-pricing",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_attribute_values.execute(
        { serviceCode: "AmazonEC2", attributeName: "instanceType" },
        context as unknown as Parameters<
          typeof model.methods.get_attribute_values.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "attributes");
      assertEquals(resources[0].name, "AmazonEC2-instanceType");

      const data = resources[0].data as {
        serviceCode: string;
        attributeName: string;
        values: string[];
        fetchedAt: string;
      };
      assertEquals(data.serviceCode, "AmazonEC2");
      assertEquals(data.attributeName, "instanceType");
      assertEquals(data.values.length, 3);
      // Values should be sorted alphabetically
      assertEquals(data.values, ["m5.xlarge", "t3.large", "t3.medium"]);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_price Tests
// =============================================================================

Deno.test({
  name: "get_price parses JSON price list and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    const restore = mockPricing(() => ({
      PriceList: [
        JSON.stringify({
          product: {
            productFamily: "Compute Instance",
            attributes: { instanceType: "t3.medium" },
          },
          terms: {
            OnDemand: {
              abc123: {
                priceDimensions: {
                  def456: { pricePerUnit: { USD: "0.0416" } },
                },
              },
            },
          },
        }),
      ],
      NextToken: undefined,
    }));
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-pricing",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_price.execute(
        {
          serviceCode: "AmazonEC2",
          filters: [{ field: "instanceType", value: "t3.medium" }],
          maxResults: 10,
        },
        context as unknown as Parameters<
          typeof model.methods.get_price.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "prices");

      const data = resources[0].data as {
        serviceCode: string;
        filters: Array<{ field: string; value: string }>;
        items: Array<{
          serviceCode: string;
          product: Record<string, unknown>;
          terms: Record<string, unknown>;
        }>;
        fetchedAt: string;
      };
      assertEquals(data.serviceCode, "AmazonEC2");
      assertEquals(data.items.length, 1);
      assertEquals(data.items[0].serviceCode, "AmazonEC2");

      // Verify product attributes are present
      const product = data.items[0].product as {
        productFamily: string;
        attributes: { instanceType: string };
      };
      assertEquals(product.productFamily, "Compute Instance");
      assertEquals(product.attributes.instanceType, "t3.medium");

      // Verify terms are present
      const terms = data.items[0].terms as {
        OnDemand: Record<string, unknown>;
      };
      assertEquals("OnDemand" in terms, true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_ec2_price Tests
// =============================================================================

Deno.test({
  name: "get_ec2_price sends correct filters and writes resource",
  sanitizeResources: false, // AWS SDK client uses connection pooling
  fn: async () => {
    let capturedFilters: Array<{
      Type: string;
      Field: string;
      Value: string;
    }> = [];

    const restore = mockPricing((cmd: unknown) => {
      const command = cmd as {
        input: {
          Filters: Array<{ Type: string; Field: string; Value: string }>;
        };
      };
      capturedFilters = command.input.Filters;
      return {
        PriceList: [
          JSON.stringify({
            product: {
              attributes: { instanceType: "t3.medium" },
            },
            terms: {
              OnDemand: {
                "term-abc": {
                  priceDimensions: {
                    "dim-xyz": { pricePerUnit: { USD: "0.0416" } },
                  },
                },
              },
            },
          }),
        ],
      };
    });
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
        definition: {
          id: "test-id",
          name: "aws-pricing",
          version: 1,
          tags: {},
        },
      });

      const result = await model.methods.get_ec2_price.execute(
        {
          instanceType: "t3.medium",
          region: "us-east-1",
          operatingSystem: "Linux",
          tenancy: "Shared",
        },
        context as unknown as Parameters<
          typeof model.methods.get_ec2_price.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);

      // Verify resource written with correct name
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "prices");
      assertEquals(resources[0].name, "ec2-t3.medium-us-east-1");

      // Verify filters sent to the Pricing API
      const instanceFilter = capturedFilters.find(
        (f) => f.Field === "instanceType",
      );
      assertEquals(instanceFilter?.Value, "t3.medium");

      const locationFilter = capturedFilters.find(
        (f) => f.Field === "location",
      );
      assertEquals(locationFilter?.Value, "US East (N. Virginia)");

      const osFilter = capturedFilters.find(
        (f) => f.Field === "operatingSystem",
      );
      assertEquals(osFilter?.Value, "Linux");

      const tenancyFilter = capturedFilters.find(
        (f) => f.Field === "tenancy",
      );
      assertEquals(tenancyFilter?.Value, "Shared");

      // Verify items parsed
      const data = resources[0].data as {
        items: Array<{
          serviceCode: string;
          product: Record<string, unknown>;
        }>;
      };
      assertEquals(data.items.length, 1);
      assertEquals(data.items[0].serviceCode, "AmazonEC2");
    } finally {
      restore();
    }
  },
});
