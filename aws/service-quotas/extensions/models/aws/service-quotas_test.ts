// AWS Service Quotas Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import {
  ServiceQuotasClient,
} from "npm:@aws-sdk/client-service-quotas@3.1069.0";
import { CloudWatchClient } from "npm:@aws-sdk/client-cloudwatch@3.1069.0";
import { STSClient } from "npm:@aws-sdk/client-sts@3.1069.0";
import { SupportClient } from "npm:@aws-sdk/client-support@3.1069.0";
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

Deno.test("model has 6 resources", () => {
  assertEquals(Object.keys(model.resources).length, 6);
});

Deno.test("model has 7 methods", () => {
  assertEquals(Object.keys(model.methods).length, 7);
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
