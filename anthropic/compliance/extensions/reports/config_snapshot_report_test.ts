// Config Snapshot Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "@systeminit/swamp-testing";
import { report } from "./config_snapshot_report.ts";

const MODEL_TYPE = "@webframp/anthropic/compliance";
const MODEL_ID = "claude-compliance-id";

// deno-lint-ignore no-explicit-any
function artifact(dataName: string, content: Record<string, unknown>): any {
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  return {
    modelType: MODEL_TYPE,
    modelId: MODEL_ID,
    data: {
      name: dataName,
      kind: "resource",
      dataId: `data-${dataName}`,
      version: 1,
      size: bytes.length,
      contentType: "application/json",
    },
    content: bytes,
  };
}

function createContext(
  // deno-lint-ignore no-explicit-any
  dataArtifacts: any[] = [],
  modelType: string = MODEL_TYPE,
) {
  const { context } = createReportTestContext({
    scope: "method",
    modelType,
    modelId: MODEL_ID,
    methodName: "sync_effective_settings",
    executionStatus: "succeeded",
    globalArgs: { orgId: "org-123" },
    methodArgs: {},
    dataHandles: [],
    dataArtifacts,
  });
  return context;
}

// ============================================================
// Export structure
// ============================================================

Deno.test("report has correct name", () => {
  assertEquals(report.name, "@webframp/compliance-config-snapshot");
});

Deno.test("report has method scope", () => {
  assertEquals(report.scope, "method");
});

// ============================================================
// Skip behavior: non-compliance model
// ============================================================

Deno.test("skips report for a non-compliance model type", async () => {
  const context = createContext([], "@webframp/aws/ec2");
  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);
  assertEquals(result.json.skipped, true);
  assertEquals(result.json.reason, "not-compliance-model");
});

// ============================================================
// Aggregation: all specs present
// ============================================================

Deno.test("aggregates effectiveSettings, roles, groups, organizations, and user count", async () => {
  const context = createContext([
    artifact("effectiveSettings", {
      orgId: "org-123",
      settings: [
        { name: "sso_enabled", value: true },
        { name: "ip_allowlist_enabled", value: false },
      ],
      count: 2,
      fetchedAt: "2026-07-10T00:00:00.000Z",
    }),
    artifact("roles", {
      orgId: "org-123",
      roles: [
        { id: "role_2", name: "user", description: "Standard access" },
        { id: "role_1", name: "admin", description: "Full access" },
      ],
      count: 2,
      has_more: false,
      fetchedAt: "2026-07-12T00:00:00.000Z",
    }),
    artifact("groups", {
      orgId: "org-123",
      groups: [
        {
          id: "grp_1",
          name: "Engineering",
          description: "Eng team",
          member_count: 12,
        },
      ],
      count: 1,
      has_more: false,
      fetchedAt: "2026-07-11T00:00:00.000Z",
    }),
    artifact("all", {
      organizations: [
        { id: "org-123", name: "Acme Corp", type: "enterprise" },
      ],
      count: 1,
      fetchedAt: "2026-07-09T00:00:00.000Z",
    }),
    artifact("users", {
      orgId: "org-123",
      users: [
        {
          id: "user_1",
          email: "alice@example.com",
          name: "Alice",
          role: "primary_owner",
          created_at: "2025-01-01T00:00:00Z",
        },
      ],
      count: 483,
      has_more: false,
      fetchedAt: "2026-07-16T00:00:00.000Z",
    }),
  ]);

  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);

  assertEquals(result.json.orgId, "org-123");
  assertEquals(result.json.effectiveSettings, {
    settings: [
      { name: "ip_allowlist_enabled", value: false },
      { name: "sso_enabled", value: true },
    ],
  });
  assertEquals(result.json.roles, [
    { id: "role_1", name: "admin", description: "Full access" },
    { id: "role_2", name: "user", description: "Standard access" },
  ]);
  assertEquals(result.json.groups, [
    {
      id: "grp_1",
      name: "Engineering",
      description: "Eng team",
      member_count: 12,
    },
  ]);
  assertEquals(result.json.organizations, [
    { id: "org-123", name: "Acme Corp", type: "enterprise" },
  ]);
  assertEquals(result.json.directoryUserCount, {
    count: 483,
    asOf: "2026-07-16T00:00:00.000Z",
  });
  assertEquals(result.json.capturedAt, "2026-07-16T00:00:00.000Z");
  assertStringIncludes(result.markdown, "Config Snapshot");
});

// ============================================================
// Privacy: never expose the users roster
// ============================================================

Deno.test("never includes the raw users array, only the count", async () => {
  const context = createContext([
    artifact("users", {
      orgId: "org-123",
      users: [
        { id: "user_1", email: "alice@example.com", name: "Alice" },
      ],
      count: 1,
      has_more: false,
      fetchedAt: "2026-07-16T00:00:00.000Z",
    }),
  ]);

  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);

  assertEquals(result.json.users, undefined);
  assertEquals(result.json.directoryUserCount, {
    count: 1,
    asOf: "2026-07-16T00:00:00.000Z",
  });
  const asString = JSON.stringify(result.json);
  assertEquals(asString.includes("alice@example.com"), false);
});

// ============================================================
// Missing specs are omitted, not fabricated
// ============================================================

Deno.test("omits specs that have never been synced", async () => {
  const context = createContext([
    artifact("effectiveSettings", {
      orgId: "org-123",
      settings: [{ name: "sso_enabled", value: true }],
      count: 1,
      fetchedAt: "2026-07-10T00:00:00.000Z",
    }),
  ]);

  // deno-lint-ignore no-explicit-any
  const result = await report.execute(context as any);

  assertEquals(result.json.roles, undefined);
  assertEquals(result.json.groups, undefined);
  assertEquals(result.json.organizations, undefined);
  assertEquals(result.json.directoryUserCount, undefined);
  assertEquals(result.json.capturedAt, "2026-07-10T00:00:00.000Z");
});
