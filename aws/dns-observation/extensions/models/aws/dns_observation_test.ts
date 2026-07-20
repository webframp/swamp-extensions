// AWS DNS Observation Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { Route53Client } from "npm:@aws-sdk/client-route-53@3.1090.0";
import { STSClient } from "npm:@aws-sdk/client-sts@3.1090.0";
import { model } from "./dns_observation.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

function mockClients(overrides: {
  route53?: (cmd: unknown) => unknown;
  sts?: (cmd: unknown) => unknown;
}): () => void {
  const originals = {
    route53: Route53Client.prototype.send,
    sts: STSClient.prototype.send,
  };
  if (overrides.route53) {
    // deno-lint-ignore no-explicit-any
    Route53Client.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.route53!(_c));
    } as typeof originals.route53;
  }
  if (overrides.sts) {
    // deno-lint-ignore no-explicit-any
    STSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sts!(_c));
    } as typeof originals.sts;
  }
  return () => {
    Route53Client.prototype.send = originals.route53;
    STSClient.prototype.send = originals.sts;
  };
}

function makeContext(
  dataRepoOverrides?: Record<string, Record<string, unknown[]>>,
) {
  const dataRepo = dataRepoOverrides ?? {};
  const ctx = createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: {
      id: "test-id",
      name: "aws-dns-observation",
      version: 1,
      tags: {},
    },
  });

  // Track stored resources for readResource
  const storedResources: Record<string, unknown> = {};
  const origWrite = ctx.context.writeResource.bind(ctx.context);

  // Override dataRepository for detect_orphans cross-reference
  const context = {
    ...ctx.context,
    writeResource: (spec: string, instance: string, data: unknown) => {
      storedResources[instance] = data;
      return origWrite(spec, instance, data as Record<string, unknown>);
    },
    readResource: (instance: string) => {
      const data = storedResources[instance];
      if (data) return Promise.resolve({ attributes: data });
      return Promise.resolve(null);
    },
    dataRepository: {
      findBySpec: (modelName: string, specName: string) => {
        const modelData = dataRepo[modelName];
        if (!modelData) return Promise.resolve([]);
        const specData = modelData[specName];
        if (!specData) return Promise.resolve([]);
        return Promise.resolve(specData);
      },
    },
  };

  return { context, getWrittenResources: ctx.getWrittenResources };
}

// deno-lint-ignore no-explicit-any
type ExecuteContext = any;

// =============================================================================
// Test Data
// =============================================================================

const stsIdentity = { Account: "123456789012" };

const hostedZonesResp = {
  HostedZones: [
    {
      Id: "/hostedzone/Z1234",
      Name: "example.com.",
      Config: { PrivateZone: false, Comment: "Main zone" },
      ResourceRecordSetCount: 15,
    },
    {
      Id: "/hostedzone/Z5678",
      Name: "internal.example.com.",
      Config: { PrivateZone: true, Comment: null },
      ResourceRecordSetCount: 5,
    },
  ],
  NextMarker: undefined,
};

const privateZoneDetail = {
  VPCs: [
    { VPCId: "vpc-abc123", VPCRegion: "us-east-1" },
  ],
};

const recordSetsZ1234 = {
  ResourceRecordSets: [
    {
      Name: "example.com.",
      Type: "A",
      AliasTarget: {
        DNSName: "dualstack.my-alb-123.us-east-1.elb.amazonaws.com.",
        HostedZoneId: "Z35SXDOTRQ7X7K",
        EvaluateTargetHealth: true,
      },
    },
    {
      Name: "api.example.com.",
      Type: "CNAME",
      TTL: 300,
      ResourceRecords: [{ Value: "d111111abcdef8.cloudfront.net." }],
    },
    {
      Name: "old.example.com.",
      Type: "A",
      TTL: 60,
      ResourceRecords: [{ Value: "203.0.113.50" }],
    },
    {
      Name: "example.com.",
      Type: "NS",
      TTL: 172800,
      ResourceRecords: [
        { Value: "ns-1.awsdns-01.com." },
        { Value: "ns-2.awsdns-02.net." },
      ],
    },
    {
      Name: "example.com.",
      Type: "SOA",
      TTL: 900,
      ResourceRecords: [
        {
          Value:
            "ns-1.awsdns-01.com. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400",
        },
      ],
    },
  ],
  IsTruncated: false,
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/dns-observation");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region with default", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines expected resources", () => {
  assertEquals("zones" in model.resources, true);
  assertEquals("records" in model.resources, true);
  assertEquals("orphans" in model.resources, true);
});

Deno.test("model defines all expected methods", () => {
  const expected = ["list_zones", "list_records", "detect_orphans"];
  for (const method of expected) {
    assertEquals(method in model.methods, true, `missing method: ${method}`);
  }
});

// =============================================================================
// list_zones Tests
// =============================================================================

Deno.test({
  name: "list_zones returns all zones with metadata",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sts: () => stsIdentity,
      route53: (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "ListHostedZonesCommand") return hostedZonesResp;
        if (name === "GetHostedZoneCommand") return privateZoneDetail;
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_zones.execute(
        { includePrivate: true },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "zones");

      const data = resources[0].data as {
        zones: Array<{
          id: string;
          name: string;
          isPrivate: boolean;
          vpcAssociations: Array<{ vpcId: string }>;
        }>;
        summary: { totalZones: number; publicZones: number };
      };
      assertEquals(data.zones.length, 2);
      assertEquals(data.summary.totalZones, 2);
      assertEquals(data.summary.publicZones, 1);
      assertEquals(data.zones[0].id, "Z1234");
      assertEquals(data.zones[0].name, "example.com");
      assertEquals(data.zones[1].isPrivate, true);
      assertEquals(data.zones[1].vpcAssociations.length, 1);
      assertEquals(data.zones[1].vpcAssociations[0].vpcId, "vpc-abc123");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_zones excludes private zones when includePrivate is false",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sts: () => stsIdentity,
      route53: () => hostedZonesResp,
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_zones.execute(
        { includePrivate: false },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const data = resources[0].data as {
        zones: Array<{ isPrivate: boolean }>;
      };
      assertEquals(data.zones.length, 1);
      assertEquals(data.zones[0].isPrivate, false);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_records Tests
// =============================================================================

Deno.test({
  name: "list_records fetches records across zones",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sts: () => stsIdentity,
      route53: (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "ListHostedZonesCommand") return hostedZonesResp;
        if (name === "ListResourceRecordSetsCommand") return recordSetsZ1234;
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_records.execute(
        {},
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "records");

      const data = resources[0].data as {
        records: Array<{
          name: string;
          type: string;
          aliasTarget: { dnsName: string } | null;
          values: string[];
        }>;
        summary: { totalRecords: number; zonesScanned: number };
      };
      // 5 records from zone Z1234 * 2 zones (same mock for both) = 10
      assertEquals(data.summary.zonesScanned, 2);
      assertEquals(data.records.length, 10);

      // Verify alias target parsing
      const aliasRecord = data.records[0];
      assertExists(aliasRecord.aliasTarget);
      assertEquals(
        aliasRecord.aliasTarget.dnsName,
        "dualstack.my-alb-123.us-east-1.elb.amazonaws.com",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_records respects typeFilter",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sts: () => stsIdentity,
      route53: (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "ListHostedZonesCommand") {
          return {
            HostedZones: [{
              Id: "/hostedzone/Z1234",
              Name: "example.com.",
              Config: { PrivateZone: false },
              ResourceRecordSetCount: 5,
            }],
            NextMarker: undefined,
          };
        }
        if (name === "ListResourceRecordSetsCommand") return recordSetsZ1234;
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_records.execute(
        { typeFilter: ["A"] },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const data = resources[0].data as {
        records: Array<{ type: string }>;
      };
      for (const r of data.records) {
        assertEquals(r.type, "A");
      }
    } finally {
      restore();
    }
  },
});

// =============================================================================
// detect_orphans Tests
// =============================================================================

Deno.test({
  name: "detect_orphans warns when no record data exists",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({ sts: () => stsIdentity });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.detect_orphans.execute(
        {
          inventoryModelName: "aws-inventory",
          adoptModelName: "aws-adopt",
          skipTypes: ["TXT", "MX", "SRV"],
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        orphans: unknown[];
        summary: { totalOrphans: number };
      };
      assertEquals(data.orphans.length, 0);
      assertEquals(data.summary.totalOrphans, 0);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "detect_orphans finds orphaned A records not in inventory",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({ sts: () => stsIdentity });
    try {
      const { context, getWrittenResources } = makeContext({
        "aws-inventory": {
          "scan": [
            {
              attributes: {
                ec2: [{ publicIpAddress: "10.0.0.1", arn: "arn:..." }],
              },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      });

      // Pre-populate records via writeResource
      await context.writeResource("records", "record-scan", {
        fetchedAt: "2026-06-27T10:00:00Z",
        accountId: "123456789012",
        records: [
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "old.example.com",
            type: "A",
            ttl: 60,
            values: ["203.0.113.50"],
            aliasTarget: null,
          },
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "valid.example.com",
            type: "A",
            ttl: 60,
            values: ["10.0.0.1"],
            aliasTarget: null,
          },
        ],
        summary: { totalRecords: 2, zonesScanned: 1, byType: { A: 2 } },
      });

      await model.methods.detect_orphans.execute(
        {
          inventoryModelName: "aws-inventory",
          adoptModelName: "aws-adopt",
          skipTypes: ["TXT", "MX", "SRV"],
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const orphanReport = resources.find((r) => r.specName === "orphans");
      assertExists(orphanReport);

      const data = orphanReport.data as {
        orphans: Array<{
          recordName: string;
          target: string;
          reason: string;
        }>;
        summary: { totalOrphans: number; recordsAnalyzed: number };
      };
      assertEquals(data.summary.totalOrphans, 1);
      assertEquals(data.orphans[0].recordName, "old.example.com");
      assertEquals(data.orphans[0].target, "203.0.113.50");
      assertEquals(data.orphans[0].reason, "a_record_ip_not_in_inventory");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "detect_orphans finds orphaned ELB alias targets",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({ sts: () => stsIdentity });
    try {
      const { context, getWrittenResources } = makeContext({
        "aws-inventory": {
          "scan": [
            {
              attributes: {
                elbv2: [
                  {
                    dnsName: "active-alb.us-east-1.elb.amazonaws.com",
                    arn: "arn:...",
                  },
                ],
              },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      });

      await context.writeResource("records", "record-scan", {
        fetchedAt: "2026-06-27T10:00:00Z",
        accountId: "123456789012",
        records: [
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "app.example.com",
            type: "A",
            ttl: null,
            values: [],
            aliasTarget: {
              dnsName: "dualstack.deleted-alb.us-east-1.elb.amazonaws.com",
              hostedZoneId: "Z35SXDOTRQ7X7K",
              evaluateTargetHealth: true,
            },
          },
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "api.example.com",
            type: "A",
            ttl: null,
            values: [],
            aliasTarget: {
              dnsName: "dualstack.active-alb.us-east-1.elb.amazonaws.com",
              hostedZoneId: "Z35SXDOTRQ7X7K",
              evaluateTargetHealth: true,
            },
          },
        ],
        summary: { totalRecords: 2, zonesScanned: 1, byType: { A: 2 } },
      });

      await model.methods.detect_orphans.execute(
        {
          inventoryModelName: "aws-inventory",
          adoptModelName: "aws-adopt",
          skipTypes: ["TXT", "MX", "SRV"],
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const orphanReport = resources.find((r) => r.specName === "orphans");
      assertExists(orphanReport);

      const data = orphanReport.data as {
        orphans: Array<{ recordName: string; reason: string }>;
        summary: { totalOrphans: number };
      };
      assertEquals(data.summary.totalOrphans, 1);
      assertEquals(data.orphans[0].recordName, "app.example.com");
      assertEquals(data.orphans[0].reason, "alias_target_elb_not_found");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "detect_orphans skips RFC 1918 addresses",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({ sts: () => stsIdentity });
    try {
      const { context, getWrittenResources } = makeContext({
        "aws-inventory": {
          "scan": [
            {
              attributes: {
                ec2: [{ publicIpAddress: "54.1.2.3", arn: "arn:..." }],
              },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      });

      await context.writeResource("records", "record-scan", {
        fetchedAt: "2026-06-27T10:00:00Z",
        accountId: "123456789012",
        records: [
          {
            zoneId: "Z1234",
            zoneName: "internal.example.com",
            name: "db.internal.example.com",
            type: "A",
            ttl: 60,
            values: ["10.0.1.50"],
            aliasTarget: null,
          },
          {
            zoneId: "Z1234",
            zoneName: "internal.example.com",
            name: "cache.internal.example.com",
            type: "A",
            ttl: 60,
            values: ["172.16.0.10"],
            aliasTarget: null,
          },
          {
            zoneId: "Z1234",
            zoneName: "internal.example.com",
            name: "local.internal.example.com",
            type: "A",
            ttl: 60,
            values: ["192.168.1.1"],
            aliasTarget: null,
          },
        ],
        summary: { totalRecords: 3, zonesScanned: 1, byType: { A: 3 } },
      });

      await model.methods.detect_orphans.execute(
        {
          inventoryModelName: "aws-inventory",
          adoptModelName: "aws-adopt",
          skipTypes: ["TXT", "MX", "SRV"],
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const orphanReport = resources.find((r) => r.specName === "orphans");
      assertExists(orphanReport);

      const data = orphanReport.data as {
        orphans: unknown[];
        summary: { totalOrphans: number };
      };
      // RFC 1918 addresses should not be flagged as orphans
      assertEquals(data.summary.totalOrphans, 0);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "detect_orphans does not false-positive when inventory absent but adopt present",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({ sts: () => stsIdentity });
    try {
      // Only adopt data, no inventory — ec2PublicIps will be empty
      const { context, getWrittenResources } = makeContext({
        "aws-adopt": {
          "discovery": [
            {
              attributes: {
                elasticIps: [{ publicIp: "52.1.2.3" }],
              },
              updatedAt: "2026-06-27T10:00:00Z",
            },
          ],
        },
      });

      await context.writeResource("records", "record-scan", {
        fetchedAt: "2026-06-27T10:00:00Z",
        accountId: "123456789012",
        records: [
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "app.example.com",
            type: "A",
            ttl: 60,
            values: ["203.0.113.50"],
            aliasTarget: null,
          },
        ],
        summary: { totalRecords: 1, zonesScanned: 1, byType: { A: 1 } },
      });

      await model.methods.detect_orphans.execute(
        {
          inventoryModelName: "aws-inventory",
          adoptModelName: "aws-adopt",
          skipTypes: ["TXT", "MX", "SRV"],
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const orphanReport = resources.find((r) => r.specName === "orphans");
      assertExists(orphanReport);

      const data = orphanReport.data as {
        orphans: Array<{ recordName: string }>;
        summary: { totalOrphans: number };
      };
      // Should flag as orphan since elasticIps has data but IP doesn't match
      assertEquals(data.summary.totalOrphans, 1);
      assertEquals(data.orphans[0].recordName, "app.example.com");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_records resolves zone names with zoneFilter",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sts: () => stsIdentity,
      route53: (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "GetHostedZoneCommand") {
          return {
            HostedZone: {
              Id: "/hostedzone/Z1234",
              Name: "example.com.",
            },
          };
        }
        if (name === "ListResourceRecordSetsCommand") return recordSetsZ1234;
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_records.execute(
        { zoneFilter: ["Z1234"] },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const data = resources[0].data as {
        records: Array<{ zoneName: string }>;
      };
      // All records should have the zone name, not their own FQDN
      for (const r of data.records) {
        assertEquals(r.zoneName, "example.com");
      }
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "detect_orphans skips NS and SOA records",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({ sts: () => stsIdentity });
    try {
      const { context, getWrittenResources } = makeContext();

      await context.writeResource("records", "record-scan", {
        fetchedAt: "2026-06-27T10:00:00Z",
        accountId: "123456789012",
        records: [
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "example.com",
            type: "NS",
            ttl: 172800,
            values: ["ns-1.awsdns-01.com."],
            aliasTarget: null,
          },
          {
            zoneId: "Z1234",
            zoneName: "example.com",
            name: "example.com",
            type: "SOA",
            ttl: 900,
            values: ["ns-1.awsdns-01.com. hostmaster 1 7200 900 1209600 86400"],
            aliasTarget: null,
          },
        ],
        summary: {
          totalRecords: 2,
          zonesScanned: 1,
          byType: { NS: 1, SOA: 1 },
        },
      });

      await model.methods.detect_orphans.execute(
        {
          inventoryModelName: "aws-inventory",
          adoptModelName: "aws-adopt",
          skipTypes: ["TXT", "MX", "SRV"],
        },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      const orphanReport = resources.find((r) => r.specName === "orphans");
      assertExists(orphanReport);

      const data = orphanReport.data as {
        summary: { totalOrphans: number; recordsAnalyzed: number };
      };
      assertEquals(data.summary.totalOrphans, 0);
      // NS/SOA are skipped at the loop level, not counted as analyzed
      assertEquals(data.summary.recordsAnalyzed, 0);
    } finally {
      restore();
    }
  },
});
