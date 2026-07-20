// AWS Config Compliance Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { ConfigServiceClient } from "npm:@aws-sdk/client-config-service@3.1090.0";
import { STSClient } from "npm:@aws-sdk/client-sts@3.1090.0";
import { model } from "./config_compliance.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

function mockClients(overrides: {
  config?: (cmd: unknown) => unknown;
  sts?: (cmd: unknown) => unknown;
}): () => void {
  const originals = {
    config: ConfigServiceClient.prototype.send,
    sts: STSClient.prototype.send,
  };
  if (overrides.config) {
    // deno-lint-ignore no-explicit-any
    ConfigServiceClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.config!(_c));
    } as typeof originals.config;
  }
  if (overrides.sts) {
    // deno-lint-ignore no-explicit-any
    STSClient.prototype.send = function (_c: any) {
      return Promise.resolve(overrides.sts!(_c));
    } as typeof originals.sts;
  }
  return () => {
    ConfigServiceClient.prototype.send = originals.config;
    STSClient.prototype.send = originals.sts;
  };
}

function makeContext() {
  return createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: {
      id: "test-id",
      name: "aws-config-compliance",
      version: 1,
      tags: {},
    },
  });
}

// deno-lint-ignore no-explicit-any
type ExecuteContext = any;

// =============================================================================
// Test Data
// =============================================================================

const stsIdentity = { Account: "123456789012" };

const nonCompliantRulesResp = {
  ComplianceByConfigRules: [
    {
      ConfigRuleName: "s3-bucket-versioning-enabled",
      Compliance: {
        ComplianceType: "NON_COMPLIANT",
        ComplianceContributorCount: { CappedCount: 3 },
      },
    },
    {
      ConfigRuleName: "rds-storage-encrypted",
      Compliance: {
        ComplianceType: "NON_COMPLIANT",
        ComplianceContributorCount: { CappedCount: 1 },
      },
    },
  ],
  NextToken: undefined,
};

const s3EvalResp = {
  EvaluationResults: [
    {
      EvaluationResultIdentifier: {
        EvaluationResultQualifier: {
          ResourceId: "my-bucket-1",
          ResourceType: "AWS::S3::Bucket",
        },
      },
      ComplianceType: "NON_COMPLIANT",
      Annotation: "Versioning is not enabled",
      ResultRecordedTime: new Date("2026-06-25T10:00:00Z"),
    },
    {
      EvaluationResultIdentifier: {
        EvaluationResultQualifier: {
          ResourceId: "my-bucket-2",
          ResourceType: "AWS::S3::Bucket",
        },
      },
      ComplianceType: "NON_COMPLIANT",
      Annotation: "Versioning is not enabled",
      ResultRecordedTime: new Date("2026-06-25T10:00:00Z"),
    },
  ],
  NextToken: undefined,
};

const rdsEvalResp = {
  EvaluationResults: [
    {
      EvaluationResultIdentifier: {
        EvaluationResultQualifier: {
          ResourceId: "mydb",
          ResourceType: "AWS::RDS::DBInstance",
        },
      },
      ComplianceType: "NON_COMPLIANT",
      Annotation: "Storage is not encrypted",
      ResultRecordedTime: new Date("2026-06-25T11:00:00Z"),
    },
  ],
  NextToken: undefined,
};

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/config-compliance");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has region with default", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
});

Deno.test("model defines compliance and summary resources", () => {
  assertEquals("compliance" in model.resources, true);
  assertEquals("summary" in model.resources, true);
});

Deno.test("model defines all expected methods", () => {
  const expected = [
    "get_non_compliant",
    "get_compliance_summary",
    "list_rules",
  ];
  for (const method of expected) {
    assertEquals(method in model.methods, true, `missing method: ${method}`);
  }
});

// =============================================================================
// get_non_compliant Tests
// =============================================================================

Deno.test({
  name: "get_non_compliant fetches evaluations across rules",
  sanitizeResources: false,
  fn: async () => {
    let callCount = 0;
    const restore = mockClients({
      sts: () => stsIdentity,
      config: (cmd: unknown) => {
        const name =
          (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "DescribeComplianceByConfigRuleCommand") {
          return nonCompliantRulesResp;
        }
        if (name === "GetComplianceDetailsByConfigRuleCommand") {
          callCount++;
          return callCount === 1 ? s3EvalResp : rdsEvalResp;
        }
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_non_compliant.execute(
        { includeCompliant: false },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "compliance");
      assertEquals(resources[0].name, "latest");

      const data = resources[0].data as {
        accountId: string;
        evaluations: {
          resourceId: string;
          complianceType: string;
          configRuleName: string;
          annotation: string | null;
        }[];
        summary: {
          nonCompliantRules: number;
          nonCompliantResources: number;
        };
      };

      assertEquals(data.accountId, "123456789012");
      assertEquals(data.evaluations.length, 3);
      assertEquals(data.summary.nonCompliantRules, 2);
      assertEquals(data.summary.nonCompliantResources, 3);

      assertEquals(data.evaluations[0].resourceId, "my-bucket-1");
      assertEquals(
        data.evaluations[0].configRuleName,
        "s3-bucket-versioning-enabled",
      );
      assertEquals(data.evaluations[0].annotation, "Versioning is not enabled");

      assertEquals(data.evaluations[2].resourceId, "mydb");
      assertEquals(data.evaluations[2].configRuleName, "rds-storage-encrypted");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_non_compliant handles no non-compliant rules",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      sts: () => stsIdentity,
      config: (cmd: unknown) => {
        const name =
          (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "DescribeComplianceByConfigRuleCommand") {
          return { ComplianceByConfigRules: [], NextToken: undefined };
        }
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_non_compliant.execute(
        { includeCompliant: false },
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        evaluations: unknown[];
        summary: { nonCompliantResources: number };
      };
      assertEquals(data.evaluations.length, 0);
      assertEquals(data.summary.nonCompliantResources, 0);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_compliance_summary Tests
// =============================================================================

Deno.test({
  name: "get_compliance_summary lists rules with metadata",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      config: (cmd: unknown) => {
        const name =
          (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "DescribeComplianceByConfigRuleCommand") {
          return {
            ComplianceByConfigRules: [
              {
                ConfigRuleName: "s3-bucket-versioning-enabled",
                Compliance: {
                  ComplianceType: "NON_COMPLIANT",
                  ComplianceContributorCount: { CappedCount: 2 },
                },
              },
            ],
            NextToken: undefined,
          };
        }
        if (name === "DescribeConfigRulesCommand") {
          return {
            ConfigRules: [
              {
                ConfigRuleName: "s3-bucket-versioning-enabled",
                Source: { Owner: "AWS" },
                Scope: { ComplianceResourceTypes: ["AWS::S3::Bucket"] },
              },
            ],
            NextToken: undefined,
          };
        }
        return {};
      },
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_compliance_summary.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "summary");

      const data = resources[0].data as {
        rules: {
          configRuleName: string;
          source: string;
          scope: string | null;
        }[];
      };
      assertEquals(data.rules.length, 1);
      assertEquals(
        data.rules[0].configRuleName,
        "s3-bucket-versioning-enabled",
      );
      assertEquals(data.rules[0].source, "AWS");
      assertEquals(data.rules[0].scope, "AWS::S3::Bucket");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_rules Tests
// =============================================================================

Deno.test({
  name: "list_rules returns all active rules",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockClients({
      config: () => ({
        ConfigRules: [
          {
            ConfigRuleName: "encrypted-volumes",
            Source: { Owner: "AWS" },
            Scope: { ComplianceResourceTypes: ["AWS::EC2::Volume"] },
          },
          {
            ConfigRuleName: "custom-security-check",
            Source: { Owner: "CUSTOM_LAMBDA" },
            Scope: { ComplianceResourceTypes: [] },
          },
        ],
        NextToken: undefined,
      }),
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_rules.execute(
        {} as Record<string, never>,
        context as ExecuteContext,
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      const data = resources[0].data as {
        rules: { configRuleName: string; source: string }[];
      };
      assertEquals(data.rules.length, 2);
      assertEquals(data.rules[0].source, "AWS");
      assertEquals(data.rules[1].source, "CUSTOM_LAMBDA");
    } finally {
      restore();
    }
  },
});
