/**
 * AWS Config Compliance Model — observe compliance evaluations from AWS Config
 * as typed queryable data.
 *
 * This model reads evaluation results from AWS Config rules. It does not manage
 * Config rules or recorders — use @swamp/aws/config for infrastructure management.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  ConfigServiceClient,
  DescribeComplianceByConfigRuleCommand,
  DescribeConfigRulesCommand,
  GetComplianceDetailsByConfigRuleCommand,
} from "npm:@aws-sdk/client-config-service@3.1069.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1069.0";

const MAX_PAGES = 20;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z.string().default("us-east-1").describe("AWS region to query"),
});

const ComplianceEvaluationSchema = z.object({
  resourceId: z.string(),
  resourceType: z.string(),
  resourceArn: z.string().nullable(),
  accountId: z.string(),
  region: z.string(),
  complianceType: z.enum([
    "COMPLIANT",
    "NON_COMPLIANT",
    "NOT_APPLICABLE",
    "INSUFFICIENT_DATA",
  ]),
  configRuleName: z.string(),
  annotation: z.string().nullable(),
  evaluatedAt: z.string(),
});

const RuleSummarySchema = z.object({
  configRuleName: z.string(),
  complianceType: z.string(),
  compliantCount: z.number(),
  nonCompliantCount: z.number(),
  source: z.string(),
  scope: z.string().nullable(),
});

const ComplianceResultSchema = z.object({
  fetchedAt: z.string(),
  accountId: z.string(),
  region: z.string(),
  evaluations: z.array(ComplianceEvaluationSchema),
  summary: z.object({
    totalRules: z.number(),
    compliantRules: z.number(),
    nonCompliantRules: z.number(),
    totalEvaluations: z.number(),
    nonCompliantResources: z.number(),
  }),
});

const RuleListSchema = z.object({
  fetchedAt: z.string(),
  region: z.string(),
  rules: z.array(RuleSummarySchema),
});

// =============================================================================
// Context type
// =============================================================================

type ConfigComplianceContext = {
  globalArgs: { region: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instance: string,
  ) => Promise<{ attributes: Record<string, unknown> } | null>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
    error: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Helpers
// =============================================================================

async function getAccountId(region: string): Promise<string> {
  const sts = new STSClient({ region });
  try {
    const resp = await sts.send(new GetCallerIdentityCommand({}));
    return resp.Account ?? "unknown";
  } finally {
    sts.destroy();
  }
}

// =============================================================================
// Model
// =============================================================================

/** AWS Config compliance observation model — stores evaluation results as typed queryable data. */
export const model = {
  type: "@webframp/aws/config-compliance",
  version: "2026.06.27.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,
  resources: {
    compliance: {
      description: "Full compliance evaluation results (non-compliant focus)",
      schema: ComplianceResultSchema,
      lifetime: "6h",
      garbageCollection: 5,
    },
    summary: {
      description: "Rule-level compliance summary",
      schema: RuleListSchema,
      lifetime: "1h",
      garbageCollection: 3,
    },
  },
  methods: {
    get_non_compliant: {
      description:
        "Fetch all non-compliant evaluations across Config rules. Primary output for drift-state consumption.",
      arguments: z.object({
        includeCompliant: z.boolean().optional().default(false).describe(
          "Also include COMPLIANT evaluations (larger output)",
        ),
      }),
      execute: async (
        args: { includeCompliant?: boolean },
        context: ConfigComplianceContext,
      ) => {
        const region = context.globalArgs.region;
        const client = new ConfigServiceClient({ region });
        const accountId = await getAccountId(region);

        try {
          // Step 1: Get all non-compliant rules
          const nonCompliantRules: string[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const resp = await client.send(
              new DescribeComplianceByConfigRuleCommand({
                ComplianceTypes: ["NON_COMPLIANT"],
                NextToken: nextToken,
              }),
            );
            for (const rule of resp.ComplianceByConfigRules ?? []) {
              if (rule.ConfigRuleName) {
                nonCompliantRules.push(rule.ConfigRuleName);
              }
            }
            nextToken = resp.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          context.logger.info(
            "Found {count} non-compliant Config rules in {region}",
            { count: nonCompliantRules.length, region },
          );

          // Step 2: Get evaluation details for each non-compliant rule
          const evaluations: z.infer<typeof ComplianceEvaluationSchema>[] = [];

          for (const ruleName of nonCompliantRules) {
            let ruleToken: string | undefined;
            let rulePages = 0;

            do {
              const resp = await client.send(
                new GetComplianceDetailsByConfigRuleCommand({
                  ConfigRuleName: ruleName,
                  ComplianceTypes: args.includeCompliant
                    ? ["NON_COMPLIANT", "COMPLIANT"]
                    : ["NON_COMPLIANT"],
                  NextToken: ruleToken,
                }),
              );

              for (const result of resp.EvaluationResults ?? []) {
                const qualifier = result.EvaluationResultIdentifier
                  ?.EvaluationResultQualifier;
                if (!qualifier?.ResourceId) continue;

                evaluations.push({
                  resourceId: qualifier.ResourceId,
                  resourceType: qualifier.ResourceType ?? "Unknown",
                  resourceArn: null,
                  accountId,
                  region,
                  complianceType: (result.ComplianceType as
                    | "COMPLIANT"
                    | "NON_COMPLIANT"
                    | "NOT_APPLICABLE"
                    | "INSUFFICIENT_DATA") ?? "INSUFFICIENT_DATA",
                  configRuleName: ruleName,
                  annotation: result.Annotation ?? null,
                  evaluatedAt: result.ResultRecordedTime?.toISOString() ??
                    new Date().toISOString(),
                });
              }

              ruleToken = resp.NextToken;
              rulePages++;
            } while (ruleToken && rulePages < MAX_PAGES);
          }

          const nonCompliantCount = evaluations.filter(
            (e) => e.complianceType === "NON_COMPLIANT",
          ).length;

          const result = {
            fetchedAt: new Date().toISOString(),
            accountId,
            region,
            evaluations,
            summary: {
              totalRules: nonCompliantRules.length,
              compliantRules: 0,
              nonCompliantRules: nonCompliantRules.length,
              totalEvaluations: evaluations.length,
              nonCompliantResources: nonCompliantCount,
            },
          };

          const handle = await context.writeResource(
            "compliance",
            "latest",
            result,
          );

          context.logger.info(
            "Stored {count} non-compliant evaluations across {rules} rules",
            { count: nonCompliantCount, rules: nonCompliantRules.length },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_compliance_summary: {
      description: "Get rule-level compliance summary with counts per rule",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ConfigComplianceContext,
      ) => {
        const region = context.globalArgs.region;
        const client = new ConfigServiceClient({ region });

        try {
          // Get all rules with their compliance status
          const rules: z.infer<typeof RuleSummarySchema>[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const resp = await client.send(
              new DescribeComplianceByConfigRuleCommand({
                NextToken: nextToken,
              }),
            );

            for (const rule of resp.ComplianceByConfigRules ?? []) {
              if (!rule.ConfigRuleName) continue;
              const counts = rule.Compliance?.ComplianceContributorCount;
              rules.push({
                configRuleName: rule.ConfigRuleName,
                complianceType: rule.Compliance?.ComplianceType ?? "UNKNOWN",
                compliantCount: counts?.CappedCount ?? 0,
                nonCompliantCount: counts?.CappedCount ?? 0,
                source: "AWS",
                scope: null,
              });
            }
            nextToken = resp.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          // Enrich with rule metadata
          let ruleToken: string | undefined;
          let rulePages = 0;
          const ruleMetadata = new Map<
            string,
            { source: string; scope: string | null }
          >();

          do {
            const resp = await client.send(
              new DescribeConfigRulesCommand({ NextToken: ruleToken }),
            );
            for (const rule of resp.ConfigRules ?? []) {
              if (!rule.ConfigRuleName) continue;
              ruleMetadata.set(rule.ConfigRuleName, {
                source: rule.Source?.Owner ?? "UNKNOWN",
                scope: rule.Scope?.ComplianceResourceTypes?.join(", ") ?? null,
              });
            }
            ruleToken = resp.NextToken;
            rulePages++;
          } while (ruleToken && rulePages < MAX_PAGES);

          for (const rule of rules) {
            const meta = ruleMetadata.get(rule.configRuleName);
            if (meta) {
              rule.source = meta.source;
              rule.scope = meta.scope;
            }
          }

          const result = {
            fetchedAt: new Date().toISOString(),
            region,
            rules,
          };

          const handle = await context.writeResource(
            "summary",
            "latest",
            result,
          );

          context.logger.info("Found {count} Config rules in {region}", {
            count: rules.length,
            region,
          });

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_rules: {
      description: "List active AWS Config rules with their source and scope",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ConfigComplianceContext,
      ) => {
        const region = context.globalArgs.region;
        const client = new ConfigServiceClient({ region });

        try {
          const rules: z.infer<typeof RuleSummarySchema>[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const resp = await client.send(
              new DescribeConfigRulesCommand({ NextToken: nextToken }),
            );
            for (const rule of resp.ConfigRules ?? []) {
              if (!rule.ConfigRuleName) continue;
              rules.push({
                configRuleName: rule.ConfigRuleName,
                complianceType: "UNKNOWN",
                compliantCount: 0,
                nonCompliantCount: 0,
                source: rule.Source?.Owner ?? "UNKNOWN",
                scope: rule.Scope?.ComplianceResourceTypes?.join(", ") ?? null,
              });
            }
            nextToken = resp.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const result = {
            fetchedAt: new Date().toISOString(),
            region,
            rules,
          };

          const handle = await context.writeResource(
            "summary",
            "rules",
            result,
          );

          context.logger.info("Listed {count} Config rules in {region}", {
            count: rules.length,
            region,
          });

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },
  },
};
