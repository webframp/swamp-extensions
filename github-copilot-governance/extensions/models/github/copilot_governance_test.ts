// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./copilot_governance.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

// deno-lint-ignore no-explicit-any
type AnyContext = any;

function makeContext() {
  return createModelTestContext({
    globalArgs: {
      enterprise: "test-enterprise",
      org: "test-org",
      token: "ghp_test_token",
      apiVersion: "2026-03-10",
    },
    definition: {
      id: "test-id",
      name: "copilot-gov-test",
      version: 1,
      tags: {},
    },
  });
}

let fetchMock: ((url: string, opts: RequestInit) => Promise<Response>) | null =
  null;

function mockFetch(
  handler: (
    url: string,
    opts: RequestInit,
  ) => { status: number; body: unknown },
): () => void {
  const originalFetch = globalThis.fetch;
  fetchMock = (url: string, opts: RequestInit) => {
    const { status, body } = handler(url, opts);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
    fetchMock = null;
  };
}

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model type and version are correct", () => {
  assertEquals(model.type, "@webframp/github-copilot-governance");
  assertEquals(model.version, "2026.06.01.1");
});

Deno.test("model has all expected methods", () => {
  const expected = [
    "list_budgets",
    "get_budget",
    "create_budget",
    "update_budget",
    "delete_budget",
    "get_usage_summary",
    "get_premium_usage",
    "diff_usage",
    "list_seats",
    "get_copilot_settings",
    "get_model_policies",
    "sync_tier_budgets",
  ];
  for (const m of expected) {
    assertEquals(m in model.methods, true, `Missing method: ${m}`);
  }
});

// =============================================================================
// list_budgets Tests
// =============================================================================

Deno.test({
  name: "list_budgets returns budgets from API",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch((url) => {
      if (url.includes("/settings/billing/budgets")) {
        return {
          status: 200,
          body: {
            budgets: [
              {
                id: "b1",
                budget_scope: "enterprise",
                budget_amount: 1000,
                budget_product_skus: ["copilot"],
                prevent_further_usage: true,
                budget_alerting: {
                  will_alert: true,
                  alert_recipients: ["admin"],
                },
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_budgets.execute(
        { scope: undefined },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.totalCount, 1);
      assertEquals(data.budgets[0].id, "b1");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// create_budget Tests
// =============================================================================

Deno.test({
  name: "create_budget returns existing budget on upsert match",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch((url) => {
      if (url.includes("/settings/billing/budgets")) {
        return {
          status: 200,
          body: {
            budgets: [
              {
                id: "existing-1",
                budget_scope: "cost_center",
                budget_entity_name: "dev-team",
                budget_amount: 500,
                budget_product_skus: ["copilot"],
                prevent_further_usage: true,
                budget_alerting: { will_alert: false, alert_recipients: [] },
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.create_budget.execute({
        budgetAmount: 500,
        preventFurtherUsage: true,
        alertRecipients: [],
        budgetScope: "cost_center",
        entityName: "dev-team",
        productSku: "copilot",
        dryRun: false,
      }, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.id, "existing-1");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "create_budget creates new when no match",
  sanitizeResources: false,
  fn: async () => {
    let postCalled = false;
    const restore = mockFetch((url, opts) => {
      if (url.includes("/settings/billing/budgets") && opts.method === "GET") {
        return { status: 200, body: { budgets: [] } };
      }
      if (url.includes("/settings/billing/budgets") && opts.method === "POST") {
        postCalled = true;
        return { status: 200, body: { id: "new-1", budget_amount: 100 } };
      }
      return { status: 404, body: {} };
    });
    try {
      const { context } = makeContext();
      await model.methods.create_budget.execute({
        budgetAmount: 100,
        preventFurtherUsage: true,
        alertRecipients: ["admin"],
        budgetScope: "organization",
        entityName: "my-org",
        productSku: "copilot",
        dryRun: false,
      }, context as AnyContext);
      assertEquals(postCalled, true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// delete_budget Tests
// =============================================================================

Deno.test({
  name: "delete_budget succeeds on 404 (idempotent)",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch((_url, opts) => {
      if (opts.method === "DELETE") {
        return { status: 404, body: { message: "Not Found" } };
      }
      return { status: 200, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.delete_budget.execute(
        { budgetId: "gone-id", dryRun: false },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.deleted, true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_usage_summary Tests
// =============================================================================

Deno.test({
  name: "get_usage_summary stores billing period and warns on missing fields",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 200,
      body: { total_ai_credits: 450, total_cost_usd: 4.50 },
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_usage_summary.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.totalAiCredits, 450);
      assertEquals(data.billingPeriod.start, "");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// diff_usage Tests
// =============================================================================

Deno.test({
  name: "diff_usage detects cycle boundary and suppresses",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        billing_period_start: "2026-06-01",
        billing_period_end: "2026-06-30",
        total_ai_credits: 100,
      },
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      // Inject previous with different period
      // deno-lint-ignore no-explicit-any
      (context as any).readResource = () =>
        Promise.resolve({
          billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
          totalAiCredits: 500,
        });
      await model.methods.diff_usage.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const resources = getWrittenResources() as any[];
      const diff = resources.find((r) => r.specName === "usage-diff")?.data;
      assertEquals(diff.cycleBoundary, true);
      assertEquals(diff.totalDelta, 0);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_seats Tests
// =============================================================================

Deno.test({
  name: "list_seats returns seats with reporting lag note",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        seats: [
          {
            assignee: { login: "user1" },
            created_at: "2026-01-01",
            last_activity_at: "2026-05-30",
            plan_type: "business",
          },
        ],
      },
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_seats.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.totalSeats, 1);
      assertStringIncludes(data.reportingLagNote, "24-48 hours");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// sync_tier_budgets Tests
// =============================================================================

Deno.test({
  name: "sync_tier_budgets creates budget when none exists",
  sanitizeResources: false,
  fn: async () => {
    let postCalled = false;
    const restore = mockFetch((url, opts) => {
      if (url.includes("/billing/budgets") && opts.method === "GET") {
        return { status: 200, body: { budgets: [] } };
      }
      if (url.includes("/billing/budgets") && opts.method === "POST") {
        postCalled = true;
        return { status: 200, body: { id: "new-tier-budget" } };
      }
      if (url.includes("/teams/") && url.includes("/members")) {
        return {
          status: 200,
          body: [{ login: "u1" }, { login: "u2" }, { login: "u3" }],
        };
      }
      return { status: 200, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.sync_tier_budgets.execute({
        tiers: [{
          teamSlug: "tier-50",
          perUserBudget: 50,
          costCenterName: "dev-standard",
          productSku: "copilot",
        }],
        dryRun: false,
      }, context as AnyContext);
      assertEquals(postCalled, true);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.tiers[0].action, "created");
      assertEquals(data.tiers[0].memberCount, 3);
      assertEquals(data.tiers[0].targetAmount, 150);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "sync_tier_budgets updates when amount differs",
  sanitizeResources: false,
  fn: async () => {
    let patchCalled = false;
    const restore = mockFetch((url, opts) => {
      if (url.includes("/billing/budgets") && opts.method === "GET") {
        return {
          status: 200,
          body: {
            budgets: [
              {
                id: "existing-b",
                budget_scope: "cost_center",
                budget_entity_name: "dev-standard",
                budget_amount: 100,
                budget_product_skus: ["copilot"],
              },
            ],
          },
        };
      }
      if (
        url.includes("/billing/budgets/existing-b") && opts.method === "PATCH"
      ) {
        patchCalled = true;
        return { status: 200, body: {} };
      }
      if (url.includes("/teams/") && url.includes("/members")) {
        return {
          status: 200,
          body: [{ login: "u1" }, { login: "u2" }, { login: "u3" }],
        };
      }
      return { status: 200, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.sync_tier_budgets.execute({
        tiers: [{
          teamSlug: "tier-50",
          perUserBudget: 50,
          costCenterName: "dev-standard",
          productSku: "copilot",
        }],
        dryRun: false,
      }, context as AnyContext);
      assertEquals(patchCalled, true);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data;
      assertEquals(data.tiers[0].action, "updated");
      assertEquals(data.tiers[0].targetAmount, 150);
      assertEquals(data.tiers[0].currentAmount, 100);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "sync_tier_budgets dry run does not call POST or PATCH",
  sanitizeResources: false,
  fn: async () => {
    let mutationCalled = false;
    const restore = mockFetch((url, opts) => {
      if (opts.method === "POST" || opts.method === "PATCH") {
        mutationCalled = true;
      }
      if (url.includes("/billing/budgets") && opts.method === "GET") {
        return { status: 200, body: { budgets: [] } };
      }
      if (url.includes("/teams/") && url.includes("/members")) {
        return { status: 200, body: [{ login: "u1" }] };
      }
      return { status: 200, body: {} };
    });
    try {
      const { context } = makeContext();
      await model.methods.sync_tier_budgets.execute({
        tiers: [{
          teamSlug: "tier-50",
          perUserBudget: 50,
          costCenterName: "dev-standard",
          productSku: "copilot",
        }],
        dryRun: true,
      }, context as AnyContext);
      assertEquals(mutationCalled, false);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// Auth Error Tests
// =============================================================================

Deno.test({
  name: "401 produces actionable token-expired error",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 401,
      body: { message: "Bad credentials" },
    }));
    try {
      const { context } = makeContext();
      let error = "";
      try {
        await model.methods.list_budgets.execute(
          { scope: undefined },
          context as AnyContext,
        );
      } catch (e) {
        error = (e as Error).message;
      }
      assertStringIncludes(error, "expired");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "403 produces actionable permission error",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 403,
      body: { message: "Forbidden" },
    }));
    try {
      const { context } = makeContext();
      let error = "";
      try {
        await model.methods.list_budgets.execute(
          { scope: undefined },
          context as AnyContext,
        );
      } catch (e) {
        error = (e as Error).message;
      }
      assertStringIncludes(error, "permission denied");
    } finally {
      restore();
    }
  },
});
