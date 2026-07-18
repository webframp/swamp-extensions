// AWS Service Quotas Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import {
  ServiceQuotasClient,
} from "npm:@aws-sdk/client-service-quotas@3.1090.0";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1090.0";
import { STSClient } from "npm:@aws-sdk/client-sts@3.1090.0";
import { SupportClient } from "npm:@aws-sdk/client-support@3.1090.0";
import { model } from "./service-quotas.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

// deno-lint-ignore no-explicit-any
function mockSTS(handler: (command: any) => unknown): () => void {
  const original = STSClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  STSClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    STSClient.prototype.send = original;
  };
}

// deno-lint-ignore no-explicit-any
function mockQuotas(handler: (command: any) => unknown): () => void {
  const original = ServiceQuotasClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  ServiceQuotasClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    ServiceQuotasClient.prototype.send = original;
  };
}

// deno-lint-ignore no-explicit-any
function mockCloudWatch(handler: (command: any) => unknown): () => void {
  const original = CloudWatchClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  CloudWatchClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    CloudWatchClient.prototype.send = original;
  };
}

// deno-lint-ignore no-explicit-any
function mockSupport(handler: (command: any) => unknown): () => void {
  const original = SupportClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  SupportClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    SupportClient.prototype.send = original;
  };
}

// =============================================================================
// Structure Tests
// =============================================================================

Deno.test("model has correct type", () => {
  assertEquals(model.type, "@webframp/aws/service-quotas");
});

Deno.test("model version matches CalVer", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model has 7 resources", () => {
  assertEquals(Object.keys(model.resources).length, 7);
});

Deno.test("model has 8 methods", () => {
  assertEquals(Object.keys(model.methods).length, 8);
});

// =============================================================================
// get_quota Tests
// =============================================================================

Deno.test({
  name: "get_quota returns quota with usage from CloudWatch",
  // SDK clients open connection pools that outlive the test
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas((command) => {
      const name = command.constructor.name;
      if (name === "GetServiceQuotaCommand") {
        return {
          Quota: {
            ServiceName: "AWS Identity and Access Management (IAM)",
            QuotaCode: "L-FE177D64",
            QuotaName: "Roles per account",
            Value: 1000,
            Unit: "None",
            Adjustable: true,
            GlobalQuota: true,
            UsageMetric: {
              MetricNamespace: "AWS/Usage",
              MetricName: "ResourceCount",
              MetricDimensions: { Service: "IAM", Resource: "Role" },
            },
          },
        };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [850] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.get_quota.execute(
        { serviceCode: "iam", quotaCode: "L-FE177D64" },
        context as unknown as Parameters<
          typeof model.methods.get_quota.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "quota");

      const data = resources[0].data as {
        accountId: string;
        quota: {
          value: number;
          usageValue: number | null;
          utilizationPct: number | null;
          adjustable: boolean;
        };
      };
      assertEquals(data.accountId, "123456789012");
      assertEquals(data.quota.value, 1000);
      assertEquals(data.quota.usageValue, 850);
      assertEquals(data.quota.utilizationPct, 85);
      assertEquals(data.quota.adjustable, true);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "get_quota handles missing CloudWatch metric gracefully",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas(() => ({
      Quota: {
        ServiceName: "IAM",
        QuotaCode: "L-FE177D64",
        QuotaName: "Roles per account",
        Value: 1000,
        Unit: "None",
        Adjustable: true,
        GlobalQuota: false,
        UsageMetric: null,
      },
    }));
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.get_quota.execute(
        { serviceCode: "iam", quotaCode: "L-FE177D64" },
        context as unknown as Parameters<
          typeof model.methods.get_quota.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        quota: { usageValue: number | null; utilizationPct: number | null };
      };
      assertEquals(data.quota.usageValue, null);
      assertEquals(data.quota.utilizationPct, null);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

// =============================================================================
// list_quotas Tests
// =============================================================================

Deno.test({
  name: "list_quotas paginates and returns all quotas",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    let callCount = 0;
    const restoreQuotas = mockQuotas((command) => {
      const name = command.constructor.name;
      if (name === "ListServiceQuotasCommand") {
        callCount++;
        if (callCount === 1) {
          return {
            Quotas: [
              {
                QuotaCode: "L-FE177D64",
                QuotaName: "Roles",
                ServiceName: "IAM",
                Value: 1000,
                Unit: "None",
                Adjustable: true,
                GlobalQuota: true,
              },
            ],
            NextToken: "page2",
          };
        }
        return {
          Quotas: [
            {
              QuotaCode: "L-E95E4862",
              QuotaName: "Policies",
              ServiceName: "IAM",
              Value: 1500,
              Unit: "None",
              Adjustable: true,
              GlobalQuota: true,
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.list_quotas.execute(
        { serviceCode: "iam" },
        context as unknown as Parameters<
          typeof model.methods.list_quotas.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "quotas");
      const data = resources[0].data as {
        quotas: Array<{ quotaCode: string }>;
        truncated: boolean;
      };
      assertEquals(data.quotas.length, 2);
      assertEquals(data.quotas[0].quotaCode, "L-FE177D64");
      assertEquals(data.quotas[1].quotaCode, "L-E95E4862");
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

// =============================================================================
// list_services Tests
// =============================================================================

Deno.test({
  name: "list_services returns available services",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas(() => ({
      Services: [
        { ServiceCode: "iam", ServiceName: "IAM" },
        { ServiceCode: "lambda", ServiceName: "Lambda" },
      ],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.list_services.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_services.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "services");
      const data = resources[0].data as {
        services: Array<{ serviceCode: string }>;
        truncated: boolean;
      };
      assertEquals(data.services.length, 2);
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

// =============================================================================
// check_utilization Tests
// =============================================================================

Deno.test({
  name: "check_utilization reports quotas above threshold",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas(() => ({
      Quotas: [
        {
          QuotaCode: "L-FE177D64",
          QuotaName: "Roles",
          ServiceName: "IAM",
          Value: 1000,
          Adjustable: true,
          UsageMetric: {
            MetricNamespace: "AWS/Usage",
            MetricName: "ResourceCount",
            MetricDimensions: { Service: "IAM" },
          },
        },
        {
          QuotaCode: "L-E95E4862",
          QuotaName: "Policies",
          ServiceName: "IAM",
          Value: 1500,
          Adjustable: true,
          UsageMetric: {
            MetricNamespace: "AWS/Usage",
            MetricName: "ResourceCount",
            MetricDimensions: { Service: "IAM" },
          },
        },
      ],
    }));
    let cwCallCount = 0;
    const restoreCw = mockCloudWatch(() => {
      cwCallCount++;
      // First call: Roles at 900/1000 (90%), second: Policies at 300/1500 (20%)
      if (cwCallCount === 1) return { MetricDataResults: [{ Values: [900] }] };
      return { MetricDataResults: [{ Values: [300] }] };
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "iam", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "utilization");
      const data = resources[0].data as {
        entries: Array<{ quotaCode: string; utilizationPct: number }>;
        truncated: boolean;
      };
      // Only Roles (90%) should be above 80% threshold
      assertEquals(data.entries.length, 1);
      assertEquals(data.entries[0].quotaCode, "L-FE177D64");
      assertEquals(data.entries[0].utilizationPct, 90);
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization sweeps multiple serviceCodes into one resource each",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    // Return one over-threshold quota per service, keyed by the requested code.
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        const code = command.input?.ServiceCode;
        return {
          Quotas: [
            {
              QuotaCode: `L-${code}`,
              QuotaName: `${code} quota`,
              ServiceName: code,
              Value: 100,
              Adjustable: true,
              UsageMetric: {
                MetricNamespace: "AWS/Usage",
                MetricName: "ResourceCount",
                MetricDimensions: { Service: code },
              },
            },
          ],
        };
      }
      return {};
    });
    // Every quota reads 95/100 = 95%, above the 0.8 threshold.
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [95] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCodes: ["ec2", "vpc", "eks"], threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const resources = getWrittenResources();
      // One utilization resource per service code.
      assertEquals(resources.length, 3);
      const byService = new Map(
        resources.map((r) => [
          (r.data as { serviceCode: string }).serviceCode,
          r.data as {
            serviceCode: string;
            entries: Array<{ serviceCode: string; utilizationPct: number }>;
          },
        ]),
      );
      for (const code of ["ec2", "vpc", "eks"]) {
        const res = byService.get(code);
        assertEquals(res?.entries.length, 1);
        assertEquals(res?.entries[0].serviceCode, code);
        assertEquals(res?.entries[0].utilizationPct, 95);
      }
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization back-compat: single serviceCode writes one resource",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        return {
          Quotas: [
            {
              QuotaCode: "L-1216C47A",
              QuotaName: "Running On-Demand Standard vCPUs",
              ServiceName: "ec2",
              Value: 100,
              Adjustable: true,
              UsageMetric: {
                MetricNamespace: "AWS/Usage",
                MetricName: "ResourceCount",
                MetricDimensions: { Service: "EC2" },
              },
            },
          ],
        };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [90] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "utilization");
      const data = resources[0].data as {
        serviceCode: string;
        threshold: number;
        entries: Array<{ quotaCode: string; utilizationPct: number }>;
      };
      assertEquals(data.serviceCode, "ec2");
      assertEquals(data.threshold, 0.8);
      assertEquals(data.entries.length, 1);
      assertEquals(data.entries[0].utilizationPct, 90);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization throws when no service code is given",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas(() => ({}));
    try {
      const { context } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      let threw = false;
      try {
        await model.methods.check_utilization.execute(
          {},
          context as unknown as Parameters<
            typeof model.methods.check_utilization.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("serviceCode"),
          true,
        );
      }
      assertEquals(threw, true);
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

Deno.test({
  name: "check_utilization accumulates entries across paginated pages",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    let listCall = 0;
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        listCall++;
        const q = (code: string) => ({
          QuotaCode: code,
          QuotaName: code,
          ServiceName: "ec2",
          Value: 100,
          Adjustable: true,
          UsageMetric: {
            MetricNamespace: "AWS/Usage",
            MetricName: "ResourceCount",
            MetricDimensions: { Service: "EC2" },
          },
        });
        if (listCall === 1) return { Quotas: [q("L-A")], NextToken: "page2" };
        return { Quotas: [q("L-B")] };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [95] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        entries: Array<{ quotaCode: string }>;
        truncated: boolean;
      };
      assertEquals(data.entries.length, 2);
      assertEquals(data.entries.map((e) => e.quotaCode), ["L-A", "L-B"]);
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization flags truncated when MAX_PAGES is exceeded",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    // Always return a NextToken so pagination never terminates on its own.
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        return {
          Quotas: [
            {
              QuotaCode: "L-loop",
              QuotaName: "loop",
              ServiceName: "ec2",
              Value: 100,
              Adjustable: true,
              UsageMetric: {
                MetricNamespace: "AWS/Usage",
                MetricName: "ResourceCount",
                MetricDimensions: { Service: "EC2" },
              },
            },
          ],
          NextToken: "always-more",
        };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [95] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        entries: Array<{ quotaCode: string }>;
        truncated: boolean;
      };
      // Capped at MAX_PAGES (20) iterations, one entry per page.
      assertEquals(data.entries.length, 20);
      assertEquals(data.truncated, true);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization skips a failing profile and still writes a snapshot",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    // Second profile's STS identity call throws (e.g. expired creds).
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) throw new Error("ExpiredToken: creds are stale");
      return { Account: "111111111111" };
    });
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        return {
          Quotas: [
            {
              QuotaCode: "L-1216C47A",
              QuotaName: "vCPUs",
              ServiceName: "ec2",
              Value: 100,
              Adjustable: true,
              UsageMetric: {
                MetricNamespace: "AWS/Usage",
                MetricName: "ResourceCount",
                MetricDimensions: { Service: "EC2" },
              },
            },
          ],
        };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [95] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          profiles: ["good", "bad"],
          defaultRegion: "us-east-1",
        },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        entries: Array<{ profile: string }>;
        failedProfiles: Array<{ profile: string; error: string }>;
      };
      // Only the healthy profile contributed entries.
      assertEquals(data.entries.length, 1);
      assertEquals(data.entries[0].profile, "good");
      assertEquals(data.failedProfiles.length, 1);
      assertEquals(data.failedProfiles[0].profile, "bad");
      assertMatch(data.failedProfiles[0].error, /ExpiredToken/);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name:
    "check_utilization redacts ARNs and account ids from failedProfiles errors",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) {
        throw new Error(
          "User: arn:aws:iam::123456789012:user/alice is not authorized to perform: servicequotas:ListServiceQuotas",
        );
      }
      return { Account: "111111111111" };
    });
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        return { Quotas: [] };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({ MetricDataResults: [] }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["good", "bad"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        failedProfiles: Array<{ profile: string; error: string }>;
      };
      const err = data.failedProfiles[0].error;
      // Identifiers stripped, actionable text retained.
      assertEquals(err.includes("arn:aws"), false);
      assertEquals(err.includes("123456789012"), false);
      assertEquals(err.includes("alice"), false);
      assertMatch(err, /not authorized/);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization strips URLs from failedProfiles errors",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) {
        throw new Error(
          "endpoint https://quota.internal.example.com/v2 returned 500",
        );
      }
      return { Account: "111111111111" };
    });
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        return { Quotas: [] };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({ MetricDataResults: [] }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["good", "bad"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        failedProfiles: Array<{ error: string }>;
      };
      const err = data.failedProfiles[0].error;
      assertEquals(err.includes("https://"), false);
      assertEquals(err.includes("internal.example.com"), false);
      assertMatch(err, /returned 500/); // non-URL context retained
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

Deno.test({
  name: "check_utilization collapses SSO login errors to a short code",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) {
        // Real granted/AWS SSO credential-process failure shape: embeds the
        // org SSO portal URL and ANSI color codes.
        throw new Error(
          "Command failed: granted credential-process --profile acme/ReadOnlyPlus\n" +
            "[0;31m[✘] error when retrieving credentials from custom process. " +
            "please login using 'granted sso login --sso-start-url " +
            "https://acme.awsapps.com/start/# --sso-region us-east-1'[0m\n",
        );
      }
      return { Account: "111111111111" };
    });
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        return { Quotas: [] };
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({ MetricDataResults: [] }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["good", "bad"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCode: "ec2", threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        failedProfiles: Array<{ error: string }>;
      };
      const err = data.failedProfiles[0].error;
      assertEquals(err, "sso-login-required");
      // No portal URL, no ANSI escapes leaked.
      assertEquals(err.includes("awsapps.com"), false);
      assertEquals(err.includes(String.fromCharCode(27)), false);
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

// Shared harness for redaction cases: profile #2 throws `err`, and we return
// the resulting failedProfiles[0].error.
async function runFailingSweep(err: Error): Promise<string> {
  let stsCall = 0;
  const restoreSts = mockSTS(() => {
    stsCall++;
    if (stsCall === 2) throw err;
    return { Account: "111111111111" };
  });
  const restoreQuotas = mockQuotas((command) => {
    if (command.constructor.name === "ListServiceQuotasCommand") {
      return { Quotas: [] };
    }
    return {};
  });
  const restoreCw = mockCloudWatch(() => ({ MetricDataResults: [] }));
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { profiles: ["good", "bad"], defaultRegion: "us-east-1" },
    });
    await model.methods.check_utilization.execute(
      { serviceCode: "ec2", threshold: 0.8 },
      context as unknown as Parameters<
        typeof model.methods.check_utilization.execute
      >[1],
    );
    const data = getWrittenResources()[0].data as {
      failedProfiles: Array<{ error: string }>;
    };
    return data.failedProfiles[0].error;
  } finally {
    restoreSts();
    restoreQuotas();
    restoreCw();
  }
}

Deno.test({
  name: "redaction strips a scheme-less internal hostname (VPC endpoint)",
  sanitizeResources: false,
  fn: async () => {
    const err = await runFailingSweep(
      new Error(
        "getaddrinfo ENOTFOUND vpce-0abc123def.servicequotas.us-east-1.vpce.amazonaws.com",
      ),
    );
    assertEquals(err.includes("amazonaws.com"), false);
    assertEquals(err.includes("vpce-0abc123def"), false);
    assertEquals(err.includes("<host>"), true);
    assertMatch(err, /ENOTFOUND/); // real cause retained
    assertEquals(err === "sso-login-required", false); // not misclassified
  },
});

Deno.test({
  name: "redaction strips a hyphen-grouped account id",
  sanitizeResources: false,
  fn: async () => {
    const err = await runFailingSweep(
      new Error("assume-role failed for account 1234-5678-9012"),
    );
    assertEquals(err.includes("1234-5678-9012"), false);
    assertMatch(err, /assume-role failed/);
  },
});

Deno.test({
  name: "a non-login credential-process failure is NOT collapsed to sso code",
  sanitizeResources: false,
  fn: async () => {
    const err = await runFailingSweep(
      new Error(
        'Command failed: granted credential-process --profile acme/ReadOnlyPlus: exec: "granted": executable file not found in $PATH',
      ),
    );
    // Must keep the real cause, not hide it behind a re-login prompt.
    assertEquals(err === "sso-login-required", false);
    assertMatch(err, /not found/);
  },
});

Deno.test({
  name: "a generic session/token-expired error is NOT collapsed to sso code",
  sanitizeResources: false,
  fn: async () => {
    // TLS/DB/STS 'session expired' shares the word 'expired' but is a
    // different fault — must not be mislabeled as an SSO re-login prompt.
    const err = await runFailingSweep(
      new Error("STS session has expired; the request cannot be retried"),
    );
    assertEquals(err === "sso-login-required", false);
    assertMatch(err, /expired/); // real cause retained
  },
});

Deno.test({
  name:
    "check_utilization keeps earlier-service entries when a later service fails",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "111111111111" }));
    let listCall = 0;
    const restoreQuotas = mockQuotas((command) => {
      if (command.constructor.name === "ListServiceQuotasCommand") {
        listCall++;
        // First service (ec2) succeeds; second (vpc) throttles.
        if (listCall === 1) {
          return {
            Quotas: [
              {
                QuotaCode: "L-1216C47A",
                QuotaName: "vCPUs",
                ServiceName: "ec2",
                Value: 100,
                Adjustable: true,
                UsageMetric: {
                  MetricNamespace: "AWS/Usage",
                  MetricName: "ResourceCount",
                  MetricDimensions: { Service: "EC2" },
                },
              },
            ],
          };
        }
        throw new Error("ThrottlingException: rate exceeded");
      }
      return {};
    });
    const restoreCw = mockCloudWatch(() => ({
      MetricDataResults: [{ Values: [95] }],
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["solo"], defaultRegion: "us-east-1" },
      });

      await model.methods.check_utilization.execute(
        { serviceCodes: ["ec2", "vpc"], threshold: 0.8 },
        context as unknown as Parameters<
          typeof model.methods.check_utilization.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 2);
      const byService = new Map(
        resources.map((r) => [
          (r.data as { serviceCode: string }).serviceCode,
          r.data as {
            entries: unknown[];
            failedProfiles: Array<{ profile: string }>;
          },
        ]),
      );
      // ec2 succeeded before the vpc failure, so its entry survives.
      assertEquals(byService.get("ec2")?.entries.length, 1);
      assertEquals(byService.get("vpc")?.entries.length, 0);
      // The profile is flagged failed in every resource for this run.
      assertEquals(byService.get("ec2")?.failedProfiles[0].profile, "solo");
      assertEquals(byService.get("vpc")?.failedProfiles[0].profile, "solo");
    } finally {
      restoreSts();
      restoreQuotas();
      restoreCw();
    }
  },
});

// =============================================================================
// request_increase Tests
// =============================================================================

Deno.test({
  name: "request_increase submits and records the request",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas((command) => {
      const name = command.constructor.name;
      if (name === "GetServiceQuotaCommand") {
        return {
          Quota: { QuotaName: "Roles per account", Value: 1000 },
        };
      }
      if (name === "RequestServiceQuotaIncreaseCommand") {
        return {
          RequestedQuota: {
            Id: "req-abc123",
            Status: "PENDING",
          },
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.request_increase.execute(
        { serviceCode: "iam", quotaCode: "L-FE177D64", desiredValue: 2000 },
        context as unknown as Parameters<
          typeof model.methods.request_increase.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "increaseRequest");
      const data = resources[0].data as {
        requestId: string;
        desiredValue: number;
        previousValue: number;
        status: string;
      };
      assertEquals(data.requestId, "req-abc123");
      assertEquals(data.desiredValue, 2000);
      assertEquals(data.previousValue, 1000);
      assertEquals(data.status, "PENDING");
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

// =============================================================================
// get_request_status Tests
// =============================================================================

Deno.test({
  name: "get_request_status returns current request state",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "891377232878" }));
    const restoreQuotas = mockQuotas(() => ({
      RequestedQuota: {
        Id: "1cff7e34-test-request-id",
        ServiceCode: "chime",
        QuotaCode: "L-7F583998",
        QuotaName: "Amazon Chime SDK media pipeline - Maximum pipelines",
        DesiredValue: 400,
        QuotaValue: 200,
        Status: "CASE_OPENED",
        Created: new Date("2026-07-04T14:56:43.939Z"),
      },
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.get_request_status.execute(
        { requestId: "1cff7e34-test-request-id" },
        context as unknown as Parameters<
          typeof model.methods.get_request_status.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "increaseRequest");
      const data = resources[0].data as {
        requestId: string;
        status: string;
        desiredValue: number;
        previousValue: number;
        serviceCode: string;
        quotaCode: string;
        requestedAt: string | null;
      };
      assertEquals(data.requestId, "1cff7e34-test-request-id");
      assertEquals(data.status, "CASE_OPENED");
      assertEquals(data.desiredValue, 400);
      assertEquals(data.previousValue, 0);
      assertEquals(data.serviceCode, "chime");
      assertEquals(data.quotaCode, "L-7F583998");
      assertEquals(data.requestedAt, "2026-07-04T14:56:43.939Z");
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

Deno.test({
  name: "get_request_status uses null when Created is absent",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas(() => ({
      RequestedQuota: {
        Id: "req-no-date",
        ServiceCode: "iam",
        QuotaCode: "L-FE177D64",
        QuotaName: "Roles",
        DesiredValue: 2000,
        QuotaValue: 1000,
        Status: "PENDING",
        Created: undefined,
      },
    }));

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.get_request_status.execute(
        { requestId: "req-no-date" },
        context as unknown as Parameters<
          typeof model.methods.get_request_status.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as { requestedAt: string | null };
      assertEquals(data.requestedAt, null);
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

// =============================================================================
// list_pending_requests Tests
// =============================================================================

Deno.test({
  name:
    "list_pending_requests aggregates PENDING and CASE_OPENED across profiles",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreQuotas = mockQuotas((command) => {
      if (
        command.constructor.name ===
          "ListRequestedServiceQuotaChangeHistoryCommand"
      ) {
        const status = command.input?.Status;
        if (status === "PENDING") {
          return {
            RequestedQuotas: [
              {
                Id: "req-pending-1",
                ServiceCode: "ec2",
                QuotaCode: "L-1216C47A",
                QuotaName: "Running On-Demand Standard vCPUs",
                DesiredValue: 200,
                Status: "PENDING",
                Created: new Date("2026-07-08T00:00:00.000Z"),
                CaseId: "",
              },
            ],
          };
        }
        if (status === "CASE_OPENED") {
          return {
            RequestedQuotas: [
              {
                Id: "req-case-1",
                ServiceCode: "vpc",
                QuotaCode: "L-F678F1CE",
                QuotaName: "VPCs per Region",
                DesiredValue: 10,
                Status: "CASE_OPENED",
                Created: new Date("2026-07-07T00:00:00.000Z"),
                CaseId: "case-xyz",
              },
            ],
          };
        }
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          profiles: ["acctA", "acctB"],
          defaultRegion: "us-east-1",
        },
      });

      await model.methods.list_pending_requests.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_pending_requests.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "pendingRequests");
      const data = resources[0].data as {
        entries: Array<
          {
            profile: string;
            requestId: string;
            status: string;
            caseId: string | null;
            requestedAt: string | null;
          }
        >;
        statuses: string[];
        profilesChecked: number;
        truncated: boolean;
      };
      // 2 profiles x (1 PENDING + 1 CASE_OPENED) = 4 entries
      assertEquals(data.entries.length, 4);
      assertEquals(data.profilesChecked, 2);
      assertEquals(data.statuses, ["PENDING", "CASE_OPENED"]);
      assertEquals(data.truncated, false);

      const pending = data.entries.find((e) => e.requestId === "req-pending-1");
      assertEquals(pending?.status, "PENDING");
      assertEquals(pending?.caseId, null); // empty CaseId normalized to null
      assertEquals(pending?.requestedAt, "2026-07-08T00:00:00.000Z");

      const opened = data.entries.find((e) => e.requestId === "req-case-1");
      assertEquals(opened?.status, "CASE_OPENED");
      assertEquals(opened?.caseId, "case-xyz");
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

Deno.test({
  name:
    "list_pending_requests skips a failing profile and still writes a snapshot",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) throw new Error("AccessDenied: no quota perms");
      return { Account: "111111111111" };
    });
    const restoreQuotas = mockQuotas((command) => {
      if (
        command.constructor.name ===
          "ListRequestedServiceQuotaChangeHistoryCommand"
      ) {
        return {
          RequestedQuotas: [
            {
              Id: "req-1",
              ServiceCode: "ec2",
              QuotaCode: "L-1216C47A",
              QuotaName: "vCPUs",
              DesiredValue: 200,
              Status: command.input?.Status ?? "PENDING",
              Created: new Date("2026-07-08T00:00:00.000Z"),
              CaseId: "",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          profiles: ["good", "bad"],
          defaultRegion: "us-east-1",
        },
      });

      await model.methods.list_pending_requests.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_pending_requests.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        entries: Array<{ profile: string }>;
        failedProfiles: Array<{ profile: string; error: string }>;
        profilesChecked: number;
      };
      // Good profile: 2 statuses x 1 = 2 entries; bad profile contributes none.
      assertEquals(data.entries.length, 2);
      assertEquals(data.entries.every((e) => e.profile === "good"), true);
      assertEquals(data.failedProfiles.length, 1);
      assertEquals(data.failedProfiles[0].profile, "bad");
      assertMatch(data.failedProfiles[0].error, /AccessDenied/);
    } finally {
      restoreSts();
      restoreQuotas();
    }
  },
});

// =============================================================================
// get_case_communications Tests
// =============================================================================

Deno.test({
  name: "get_case_communications retrieves case and communications",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "891377232878" }));
    const restoreSupport = mockSupport((command) => {
      const name = command.constructor.name;
      if (name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-891377232878-muen-2026-5de2a9d5d40652c8",
              displayId: "178317700500245",
              subject: "Quota Increase: Chime",
              status: "opened",
              severityCode: "critical",
              serviceCode: "service-limit-increase",
            },
          ],
        };
      }
      if (name === "DescribeCommunicationsCommand") {
        return {
          communications: [
            {
              body: "We have escalated your request.",
              submittedBy: "Amazon Web Services",
              timeCreated: "2026-07-04T16:21:06.147Z",
            },
            {
              body: "This is causing an urgent production outage.",
              submittedBy: "admin@example.com",
              timeCreated: "2026-07-04T15:05:01.937Z",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      await model.methods.get_case_communications.execute(
        { displayId: "178317700500245" },
        context as unknown as Parameters<
          typeof model.methods.get_case_communications.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "caseCommunications");
      const data = resources[0].data as {
        caseId: string;
        displayId: string;
        subject: string;
        status: string;
        severityCode: string;
        communications: Array<{ body: string; submittedBy: string }>;
        truncated: boolean;
      };
      assertEquals(
        data.caseId,
        "case-891377232878-muen-2026-5de2a9d5d40652c8",
      );
      assertEquals(data.displayId, "178317700500245");
      assertEquals(data.subject, "Quota Increase: Chime");
      assertEquals(data.status, "opened");
      assertEquals(data.severityCode, "critical");
      assertEquals(data.communications.length, 2);
      assertEquals(
        data.communications[0].submittedBy,
        "Amazon Web Services",
      );
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "get_case_communications throws when case has no internal ID",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      const name = command.constructor.name;
      if (name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: undefined,
              displayId: "999999999",
              subject: "Test",
              status: "opened",
              severityCode: "low",
              serviceCode: "general-info",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      let threw = false;
      try {
        await model.methods.get_case_communications.execute(
          { displayId: "999999999" },
          context as unknown as Parameters<
            typeof model.methods.get_case_communications.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("no internal case ID"),
          true,
        );
      }
      assertEquals(threw, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "get_case_communications throws when case not found",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      const name = command.constructor.name;
      if (name === "DescribeCasesCommand") {
        return { cases: [] };
      }
      return {};
    });

    try {
      const { context } = createModelTestContext({
        globalArgs: { profiles: ["default"], defaultRegion: "us-east-1" },
      });

      let threw = false;
      try {
        await model.methods.get_case_communications.execute(
          { displayId: "000000000" },
          context as unknown as Parameters<
            typeof model.methods.get_case_communications.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("No support case found"),
          true,
        );
      }
      assertEquals(threw, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});
