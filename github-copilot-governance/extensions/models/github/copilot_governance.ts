/**
 * GitHub Copilot Governance Model — manage budgets, monitor AI credit usage,
 * and automate tier-based governance for Enterprise Cloud organizations.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  enterprise: z.string().describe("Enterprise slug"),
  org: z.string().describe("Organization name for usage/seat queries"),
  token: z.string().meta({ sensitive: true })
    .describe(
      "vault:// reference to classic PAT with enterprise billing scope",
    ),
  apiVersion: z.string().default("2026-03-10")
    .describe("GitHub API version for billing endpoints"),
});

const BudgetAlertingSchema = z.object({
  will_alert: z.boolean(),
  alert_recipients: z.array(z.string()),
});

const BudgetSchema = z.object({
  id: z.string(),
  budget_type: z.string(),
  budget_product_skus: z.array(z.string()),
  budget_scope: z.string(),
  budget_entity_name: z.string().optional(),
  budget_amount: z.number(),
  prevent_further_usage: z.boolean(),
  budget_alerting: BudgetAlertingSchema,
});

const BudgetListSchema = z.object({
  enterprise: z.string(),
  fetchedAt: z.string(),
  budgets: z.array(BudgetSchema),
  totalCount: z.number(),
});

const UsageSummarySchema = z.object({
  org: z.string(),
  fetchedAt: z.string(),
  billingPeriod: z.object({
    start: z.string(),
    end: z.string(),
  }),
  totalAiCredits: z.number(),
  totalCostUsd: z.number(),
  byUser: z.array(z.object({
    username: z.string(),
    aiCredits: z.number(),
    costUsd: z.number(),
    lastActive: z.string().optional(),
  })),
  byModel: z.array(z.object({
    model: z.string(),
    aiCredits: z.number(),
    requestCount: z.number(),
  })),
});

const UsageDiffSchema = z.object({
  currentPeriod: z.object({ start: z.string(), end: z.string() }),
  previousPeriod: z.object({ start: z.string(), end: z.string() }),
  cycleBoundary: z.boolean(),
  fetchedAt: z.string(),
  totalDelta: z.number(),
  byUser: z.array(z.object({
    username: z.string(),
    previousCredits: z.number(),
    currentCredits: z.number(),
    delta: z.number(),
  })),
});

const SeatsSchema = z.object({
  org: z.string(),
  fetchedAt: z.string(),
  totalSeats: z.number(),
  seats: z.array(
    z.object({
      assignee: z.object({ login: z.string() }),
      created_at: z.string(),
      last_activity_at: z.string().nullable(),
      last_activity_editor: z.string().nullable(),
      plan_type: z.string(),
      pending_cancellation_date: z.string().nullable(),
    }),
  ),
  reportingLagNote: z.string(),
});

const TierSyncSchema = z.object({
  fetchedAt: z.string(),
  dryRun: z.boolean(),
  tiers: z.array(z.object({
    teamSlug: z.string(),
    costCenterName: z.string(),
    memberCount: z.number(),
    perUserBudget: z.number(),
    targetAmount: z.number(),
    currentAmount: z.number().nullable(),
    budgetId: z.string().nullable(),
    action: z.enum(["created", "updated", "unchanged", "error"]),
    error: z.string().optional(),
  })),
});

// =============================================================================
// HTTP Client Helper
// =============================================================================

interface ApiOptions {
  token: string;
  apiVersion: string;
}

/**
 * Make an authenticated GitHub API request. Handles versioning per-endpoint
 * and provides clear error messages for auth failures.
 */
async function githubApi(
  method: string,
  path: string,
  opts: ApiOptions,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": opts.apiVersion,
  };

  const fetchOpts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, fetchOpts);
  const status = resp.status;

  if (status === 401) {
    throw new Error(
      "GitHub API authentication failed (401). Token may be expired or invalid. " +
        "Refresh the token in your vault and retry.",
    );
  }
  if (status === 403) {
    throw new Error(
      "GitHub API permission denied (403). The token lacks required scope. " +
        "Budget endpoints require enterprise admin or billing manager permissions.",
    );
  }

  let data: unknown = null;
  const text = await resp.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (status === 404) {
    throw new Error(
      `GitHub API resource not found (404): ${path}. ` +
        "The enterprise may not exist, or the enhanced billing platform may not be enabled.",
    );
  }
  if (status >= 400) {
    const msg = typeof data === "object" && data !== null
      ? JSON.stringify(data)
      : String(data);
    throw new Error(`GitHub API error (${status}): ${msg}`);
  }

  return { status, data };
}

/** Paginate a GitHub API list endpoint. */
async function paginateAll(
  path: string,
  opts: ApiOptions,
  dataKey: string,
  maxPages = 20,
  perPage = 100,
): Promise<unknown[]> {
  const results: unknown[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await githubApi(
      "GET",
      `${path}${separator}page=${page}&per_page=${perPage}`,
      opts,
    );
    // Handle both object-wrapped responses ({key: [...]}) and direct arrays
    let items: unknown[];
    if (dataKey && typeof data === "object" && data !== null) {
      items = (data as Record<string, unknown>)[dataKey] as unknown[] ?? [];
    } else if (Array.isArray(data)) {
      items = data;
    } else {
      items = [];
    }
    if (Array.isArray(items) && items.length > 0) {
      results.push(...items);
      // Stop if we got fewer items than requested (last page)
      if (items.length < perPage) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }
  return results;
}

// =============================================================================
// Context type
// =============================================================================

type MethodContext = {
  globalArgs: {
    enterprise: string;
    org: string;
    token: string;
    apiVersion: string;
  };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource?: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn?: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

/** GitHub Copilot Governance model for enterprise budget and usage management. */
export const model = {
  type: "@webframp/github-copilot-governance",
  version: "2026.06.01.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    budget: {
      description: "Budget configuration state",
      schema: BudgetListSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    "usage-summary": {
      description: "Aggregated AI credit usage per billing period",
      schema: UsageSummarySchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    "usage-diff": {
      description: "Usage comparison between periods",
      schema: UsageDiffSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    seats: {
      description: "Copilot seat assignments and activity",
      schema: SeatsSchema,
      lifetime: "24h" as const,
      garbageCollection: 5,
    },
    "tier-sync": {
      description: "Result of tier budget synchronization",
      schema: TierSyncSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    config: {
      description: "Copilot configuration and policy data",
      schema: z.object({}).passthrough(),
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    list_budgets: {
      description:
        "List all budgets for the enterprise, optionally filtered by scope",
      arguments: z.object({
        scope: z.enum([
          "enterprise",
          "organization",
          "repository",
          "cost_center",
        ])
          .optional()
          .describe("Filter by budget scope"),
      }),
      execute: async (
        args: { scope?: string },
        context: MethodContext,
      ) => {
        const { enterprise, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };
        let path = `/enterprises/${enterprise}/settings/billing/budgets`;
        if (args.scope) path += `?scope=${args.scope}`;

        context.logger.info("Listing budgets for {enterprise}", { enterprise });
        const budgets = await paginateAll(path, opts, "budgets", 10, 10);

        const handle = await context.writeResource("budget", "all", {
          enterprise,
          fetchedAt: new Date().toISOString(),
          budgets,
          totalCount: budgets.length,
        });

        context.logger.info("Found {count} budgets", { count: budgets.length });
        return { dataHandles: [handle] };
      },
    },

    get_budget: {
      description: "Get a specific budget by ID",
      arguments: z.object({
        budgetId: z.string().describe("Budget UUID"),
      }),
      execute: async (
        args: { budgetId: string },
        context: MethodContext,
      ) => {
        const { enterprise, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };
        const path =
          `/enterprises/${enterprise}/settings/billing/budgets/${args.budgetId}`;

        const { data } = await githubApi("GET", path, opts);
        const handle = await context.writeResource(
          "budget",
          args.budgetId,
          data as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    create_budget: {
      description:
        "Create a budget (upsert — returns existing if matching scope/entity/sku found)",
      arguments: z.object({
        budgetAmount: z.number().int().min(0)
          .describe("Budget in whole dollars"),
        preventFurtherUsage: z.boolean().default(true)
          .describe("Hard stop when exceeded"),
        alertRecipients: z.array(z.string()).default([])
          .describe("Usernames to receive alerts"),
        budgetScope: z.enum([
          "enterprise",
          "organization",
          "repository",
          "cost_center",
        ]).describe("Scope of the budget"),
        entityName: z.string().default("")
          .describe("Entity name (org, repo, or cost center)"),
        productSku: z.string().default("copilot")
          .describe("Product SKU to budget"),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        args: {
          budgetAmount: number;
          preventFurtherUsage: boolean;
          alertRecipients: string[];
          budgetScope: string;
          entityName: string;
          productSku: string;
          dryRun: boolean;
        },
        context: MethodContext,
      ) => {
        const { enterprise, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };

        // Check for existing budget with same scope/entity/sku (upsert)
        const existing = await paginateAll(
          `/enterprises/${enterprise}/settings/billing/budgets?scope=${args.budgetScope}`,
          opts,
          "budgets",
          10,
          10,
        ) as Array<Record<string, unknown>>;

        const match = existing.find((b) =>
          b.budget_scope === args.budgetScope &&
          // Only match on entity name when it's non-empty (enterprise-scope
          // budgets have no entity name and should match by scope+sku alone)
          (args.entityName === ""
            ? (!b.budget_entity_name || b.budget_entity_name === "")
            : b.budget_entity_name === args.entityName) &&
          Array.isArray(b.budget_product_skus) &&
          b.budget_product_skus.includes(args.productSku)
        );

        if (match) {
          context.logger.info(
            "Budget already exists for {scope}/{entity}/{sku}, returning existing",
            {
              scope: args.budgetScope,
              entity: args.entityName,
              sku: args.productSku,
            },
          );
          const handle = await context.writeResource(
            "budget",
            match.id as string,
            match,
          );
          return { dataHandles: [handle] };
        }

        if (args.dryRun) {
          context.logger.info(
            "Dry run: would create budget {scope}/{entity} = ${amount}",
            {
              scope: args.budgetScope,
              entity: args.entityName,
              amount: args.budgetAmount,
            },
          );
          const handle = await context.writeResource("budget", "dry-run", {
            dryRun: true,
            wouldCreate: {
              budget_amount: args.budgetAmount,
              budget_scope: args.budgetScope,
              budget_entity_name: args.entityName,
              budget_product_sku: args.productSku,
            },
          });
          return { dataHandles: [handle] };
        }

        const body = {
          budget_amount: args.budgetAmount,
          prevent_further_usage: args.preventFurtherUsage,
          budget_alerting: {
            will_alert: args.alertRecipients.length > 0,
            alert_recipients: args.alertRecipients,
          },
          budget_scope: args.budgetScope,
          budget_entity_name: args.entityName,
          budget_type: "ProductPricing",
          budget_product_sku: args.productSku,
        };

        const { data } = await githubApi(
          "POST",
          `/enterprises/${enterprise}/settings/billing/budgets`,
          opts,
          body,
        );

        context.logger.info("Created budget for {scope}/{entity}", {
          scope: args.budgetScope,
          entity: args.entityName,
        });

        const result = data as Record<string, unknown>;
        const handle = await context.writeResource(
          "budget",
          (result.id as string) ?? "created",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    update_budget: {
      description: "Update an existing budget",
      arguments: z.object({
        budgetId: z.string().describe("Budget UUID"),
        budgetAmount: z.number().int().min(0).optional(),
        preventFurtherUsage: z.boolean().optional(),
        alertRecipients: z.array(z.string()).optional(),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        args: {
          budgetId: string;
          budgetAmount?: number;
          preventFurtherUsage?: boolean;
          alertRecipients?: string[];
          dryRun: boolean;
        },
        context: MethodContext,
      ) => {
        const { enterprise, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };
        const path =
          `/enterprises/${enterprise}/settings/billing/budgets/${args.budgetId}`;

        const body: Record<string, unknown> = {};
        if (args.budgetAmount !== undefined) {
          body.budget_amount = args.budgetAmount;
        }
        if (args.preventFurtherUsage !== undefined) {
          body.prevent_further_usage = args.preventFurtherUsage;
        }
        if (args.alertRecipients !== undefined) {
          body.budget_alerting = {
            will_alert: args.alertRecipients.length > 0,
            alert_recipients: args.alertRecipients,
          };
        }

        if (Object.keys(body).length === 0) {
          throw new Error(
            "update_budget: at least one field (budgetAmount, preventFurtherUsage, alertRecipients) must be provided",
          );
        }

        if (args.dryRun) {
          context.logger.info("Dry run: would update budget {id}", {
            id: args.budgetId,
            changes: body,
          });
          const handle = await context.writeResource("budget", "dry-run", {
            dryRun: true,
            budgetId: args.budgetId,
            wouldApply: body,
          });
          return { dataHandles: [handle] };
        }

        const { data } = await githubApi("PATCH", path, opts, body);
        context.logger.info("Updated budget {id}", { id: args.budgetId });

        const handle = await context.writeResource(
          "budget",
          args.budgetId,
          data as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    delete_budget: {
      description: "Delete a budget (idempotent — succeeds if already gone)",
      arguments: z.object({
        budgetId: z.string().describe("Budget UUID"),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        args: { budgetId: string; dryRun: boolean },
        context: MethodContext,
      ) => {
        const { enterprise, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };

        if (args.dryRun) {
          context.logger.info("Dry run: would delete budget {id}", {
            id: args.budgetId,
          });
          const handle = await context.writeResource("budget", "dry-run", {
            dryRun: true,
            wouldDelete: args.budgetId,
          });
          return { dataHandles: [handle] };
        }

        const path =
          `/enterprises/${enterprise}/settings/billing/budgets/${args.budgetId}`;
        try {
          await githubApi("DELETE", path, opts);
          context.logger.info("Deleted budget {id}", { id: args.budgetId });
        } catch (e) {
          if ((e as Error).message.includes("404")) {
            context.logger.info("Budget {id} already deleted", {
              id: args.budgetId,
            });
          } else {
            throw e;
          }
        }

        const handle = await context.writeResource("budget", args.budgetId, {
          id: args.budgetId,
          deleted: true,
          deletedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    get_usage_summary: {
      description:
        "Get org-level AI credit usage summary for current billing period",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { org, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };

        context.logger.info("Fetching usage summary for {org}", { org });
        const { data } = await githubApi(
          "GET",
          `/organizations/${org}/settings/billing/usage/summary`,
          opts,
        );

        const raw = data as Record<string, unknown>;

        // Warn if expected fields are missing (API is in preview, fields may change)
        for (const f of ["billing_period_start", "billing_period_end"]) {
          if (!(f in raw) && context.logger.warn) {
            context.logger.warn(
              "Usage response missing expected field: {field}",
              { field: f },
            );
          }
        }

        const handle = await context.writeResource(
          "usage-summary",
          "usage-latest",
          {
            org,
            fetchedAt: new Date().toISOString(),
            billingPeriod: {
              start: raw.billing_period_start ?? "",
              end: raw.billing_period_end ?? "",
            },
            totalAiCredits: raw.total_ai_credits ?? 0,
            totalCostUsd: raw.total_cost_usd ?? 0,
            byUser: raw.by_user ?? [],
            byModel: raw.by_model ?? [],
            raw,
          },
        );

        context.logger.info("Usage summary fetched for {org}", { org });
        return { dataHandles: [handle] };
      },
    },

    get_premium_usage: {
      description: "Get premium request / AI credit usage breakdown by model",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { org, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };

        context.logger.info("Fetching premium usage for {org}", { org });
        const { data } = await githubApi(
          "GET",
          `/organizations/${org}/settings/billing/premium_request/usage`,
          opts,
        );

        const handle = await context.writeResource(
          "usage-summary",
          "premium",
          {
            org,
            fetchedAt: new Date().toISOString(),
            data,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    diff_usage: {
      description:
        "Compare current usage against previous snapshot (cycle-aware, suppresses on boundary)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { org, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };

        // Read previous usage
        let previousSummary: Record<string, unknown> | null = null;
        if (context.readResource) {
          try {
            previousSummary = await context.readResource("usage-latest");
          } catch { /* no previous */ }
        }

        // Fetch current
        const { data } = await githubApi(
          "GET",
          `/organizations/${org}/settings/billing/usage/summary`,
          opts,
        );
        const current = data as Record<string, unknown>;

        const currentPeriod = {
          start: (current.billing_period_start as string) ?? "",
          end: (current.billing_period_end as string) ?? "",
        };

        const previousPeriod = previousSummary
          ? {
            start: ((previousSummary.billingPeriod as Record<string, string>)
              ?.start) ?? "",
            end: ((previousSummary.billingPeriod as Record<string, string>)
              ?.end) ?? "",
          }
          : { start: "", end: "" };

        // Detect cycle boundary
        const cycleBoundary = previousPeriod.start !== "" &&
          previousPeriod.start !== currentPeriod.start;

        const totalDelta = cycleBoundary
          ? 0
          : ((current.total_ai_credits as number) ?? 0) -
            ((previousSummary?.totalAiCredits as number) ?? 0);

        const handle = await context.writeResource("usage-diff", "result", {
          currentPeriod,
          previousPeriod,
          cycleBoundary,
          fetchedAt: new Date().toISOString(),
          totalDelta: cycleBoundary ? 0 : totalDelta,
          byUser: [],
        });

        // Update the stored summary for next diff
        await context.writeResource("usage-summary", "usage-latest", {
          org,
          fetchedAt: new Date().toISOString(),
          billingPeriod: currentPeriod,
          totalAiCredits: current.total_ai_credits ?? 0,
          totalCostUsd: current.total_cost_usd ?? 0,
          byUser: current.by_user ?? [],
          byModel: current.by_model ?? [],
        });

        context.logger.info(
          "Usage diff: delta={delta} credits (cycleBoundary={boundary})",
          { delta: totalDelta, boundary: cycleBoundary },
        );
        return { dataHandles: [handle] };
      },
    },

    list_seats: {
      description: "List all Copilot seat assignments with activity data",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { org, token } = context.globalArgs;
        const opts = { token, apiVersion: "2022-11-28" };

        context.logger.info("Listing Copilot seats for {org}", { org });
        const seats = await paginateAll(
          `/orgs/${org}/copilot/billing/seats`,
          opts,
          "seats",
        );

        const handle = await context.writeResource("seats", "current", {
          org,
          fetchedAt: new Date().toISOString(),
          totalSeats: seats.length,
          seats,
          reportingLagNote:
            "Activity data may lag 24-48 hours. Do not revoke seats based solely on recent inactivity.",
        });

        context.logger.info("Found {count} Copilot seats", {
          count: seats.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_copilot_settings: {
      description: "Get org-level Copilot configuration",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { org, token } = context.globalArgs;
        const opts = { token, apiVersion: "2022-11-28" };

        const { data } = await githubApi(
          "GET",
          `/orgs/${org}/copilot/billing`,
          opts,
        );

        const handle = await context.writeResource(
          "config",
          "copilot-settings",
          {
            org,
            fetchedAt: new Date().toISOString(),
            ...(data as Record<string, unknown>),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_model_policies: {
      description: "Get enterprise Copilot model access policies",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { enterprise, token, apiVersion } = context.globalArgs;
        const opts = { token, apiVersion };

        const { data } = await githubApi(
          "GET",
          `/enterprises/${enterprise}/copilot/policies/coding_agent`,
          opts,
        );

        const handle = await context.writeResource(
          "config",
          "model-policies",
          {
            enterprise,
            fetchedAt: new Date().toISOString(),
            policies: data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    sync_tier_budgets: {
      description:
        "Reconcile cost center budgets based on team membership × per-user amount (idempotent)",
      arguments: z.object({
        tiers: z.array(z.object({
          teamSlug: z.string().describe("GitHub team slug"),
          perUserBudget: z.number().describe("Dollars per user in this tier"),
          costCenterName: z.string().describe("Cost center entity name"),
          productSku: z.string().default("copilot"),
        })).describe("Tier definitions"),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        args: {
          tiers: Array<{
            teamSlug: string;
            perUserBudget: number;
            costCenterName: string;
            productSku: string;
          }>;
          dryRun: boolean;
        },
        context: MethodContext,
      ) => {
        const { enterprise, org, token, apiVersion } = context.globalArgs;
        const billingOpts = { token, apiVersion };
        const teamOpts = { token, apiVersion: "2022-11-28" };

        context.logger.info("Syncing {count} tier budgets", {
          count: args.tiers.length,
        });

        // Fetch all existing cost_center budgets
        const existingBudgets = await paginateAll(
          `/enterprises/${enterprise}/settings/billing/budgets?scope=cost_center`,
          billingOpts,
          "budgets",
          10,
          10,
        ) as Array<Record<string, unknown>>;

        const results: Array<Record<string, unknown>> = [];

        for (const tier of args.tiers) {
          try {
            // Get team member count (paginated for teams >100)
            const teamMembers = await paginateAll(
              `/orgs/${org}/teams/${tier.teamSlug}/members`,
              teamOpts,
              "",
            );
            const memberCount = teamMembers.length;
            const targetAmount = memberCount * tier.perUserBudget;

            // Find existing budget for this cost center + sku
            const match = existingBudgets.find((b) =>
              b.budget_scope === "cost_center" &&
              b.budget_entity_name === tier.costCenterName &&
              Array.isArray(b.budget_product_skus) &&
              (b.budget_product_skus as string[]).includes(tier.productSku)
            );

            if (match) {
              const currentAmount = match.budget_amount as number;
              if (currentAmount === targetAmount) {
                results.push({
                  teamSlug: tier.teamSlug,
                  costCenterName: tier.costCenterName,
                  memberCount,
                  perUserBudget: tier.perUserBudget,
                  targetAmount,
                  currentAmount,
                  budgetId: match.id,
                  action: "unchanged",
                });
              } else {
                if (!args.dryRun) {
                  await githubApi(
                    "PATCH",
                    `/enterprises/${enterprise}/settings/billing/budgets/${match.id}`,
                    billingOpts,
                    { budget_amount: targetAmount },
                  );
                }
                results.push({
                  teamSlug: tier.teamSlug,
                  costCenterName: tier.costCenterName,
                  memberCount,
                  perUserBudget: tier.perUserBudget,
                  targetAmount,
                  currentAmount,
                  budgetId: match.id,
                  action: "updated",
                });
              }
            } else {
              if (!args.dryRun) {
                await githubApi(
                  "POST",
                  `/enterprises/${enterprise}/settings/billing/budgets`,
                  billingOpts,
                  {
                    budget_amount: targetAmount,
                    prevent_further_usage: true,
                    budget_alerting: {
                      will_alert: false,
                      alert_recipients: [],
                    },
                    budget_scope: "cost_center",
                    budget_entity_name: tier.costCenterName,
                    budget_type: "ProductPricing",
                    budget_product_sku: tier.productSku,
                  },
                );
              }
              results.push({
                teamSlug: tier.teamSlug,
                costCenterName: tier.costCenterName,
                memberCount,
                perUserBudget: tier.perUserBudget,
                targetAmount,
                currentAmount: null,
                budgetId: null,
                action: "created",
              });
            }
          } catch (e) {
            results.push({
              teamSlug: tier.teamSlug,
              costCenterName: tier.costCenterName,
              memberCount: 0,
              perUserBudget: tier.perUserBudget,
              targetAmount: 0,
              currentAmount: null,
              budgetId: null,
              action: "error",
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const handle = await context.writeResource("tier-sync", "result", {
          fetchedAt: new Date().toISOString(),
          dryRun: args.dryRun,
          tiers: results,
        });

        const created = results.filter((r) => r.action === "created").length;
        const updated = results.filter((r) => r.action === "updated").length;
        const errors = results.filter((r) => r.action === "error").length;
        context.logger.info(
          "Tier sync: {created} created, {updated} updated, {errors} errors (dryRun={dryRun})",
          { created, updated, errors, dryRun: args.dryRun },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
