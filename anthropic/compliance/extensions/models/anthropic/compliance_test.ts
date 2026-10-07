// Claude Enterprise Compliance Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { model } from "./compliance.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("compliance model: has correct type", () => {
  assertEquals(model.type, "@webframp/anthropic/compliance");
});

Deno.test("compliance model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("compliance model: has globalArguments with complianceKey", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.complianceKey);
  assertExists(shape.orgId);
});

Deno.test("compliance model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.activities);
  assertExists(model.resources.organizations);
  assertExists(model.resources.users);
  assertExists(model.resources.roles);
  assertExists(model.resources.groups);
  assertExists(model.resources.groupMembers);
  assertExists(model.resources.effectiveSettings);
});

Deno.test("compliance model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.collect_activities);
  assertExists(model.methods.sync_organizations);
  assertExists(model.methods.sync_users);
  assertExists(model.methods.sync_roles);
  assertExists(model.methods.sync_groups);
  assertExists(model.methods.get_group_members);
  assertExists(model.methods.sync_effective_settings);
  assertExists(model.methods.sync_directory);
});

Deno.test("compliance model: all resources have lifetime and gc", () => {
  for (
    const [name, spec] of Object.entries(model.resources) as [
      string,
      { lifetime: string; garbageCollection: number },
    ][]
  ) {
    assertExists(spec.lifetime, `${name} missing lifetime`);
    assertExists(spec.garbageCollection, `${name} missing garbageCollection`);
  }
});

// ---------------------------------------------------------------------------
// Mock Anthropic Compliance API Server
// ---------------------------------------------------------------------------

const MOCK_ORG = {
  uuid: "a1b2c3d4-5678-9abc-def0-123456789abc",
  id: "org_abc123",
  name: "Test Org",
  type: "enterprise",
};

const MOCK_USERS = [
  {
    id: "user_1",
    email: "alice@example.com",
    name: "Alice",
    role: "primary_owner",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "user_2",
    email: "bob@example.com",
    name: "Bob",
    role: "user",
    created_at: "2025-02-01T00:00:00Z",
  },
];

const MOCK_ROLES = [
  { id: "role_1", name: "admin", description: "Full access" },
  { id: "role_2", name: "user", description: "Standard access" },
];

const MOCK_GROUPS = [
  {
    id: "grp_1",
    name: "Engineering",
    description: "Eng team",
    member_count: 5,
  },
];

const MOCK_GROUP_MEMBERS = [
  {
    id: "user_1",
    email: "alice@example.com",
    name: "Alice",
    source_type: "scim",
  },
  {
    id: "user_3",
    email: "carol@example.com",
    name: "Carol",
    source_type: "direct",
  },
];

const MOCK_ACTIVITIES = [
  {
    id: "act_1",
    type: "user.login",
    created_at: "2026-07-01T10:00:00Z",
    actor: {
      type: "user",
      id: "user_1",
      email: "alice@example.com",
      name: "Alice",
    },
    organization_id: "org_abc123",
    details: null,
  },
  {
    id: "act_2",
    type: "conversation.create",
    created_at: "2026-07-01T11:00:00Z",
    actor: {
      type: "user",
      id: "user_2",
      email: "bob@example.com",
      name: "Bob",
    },
    organization_id: "org_abc123",
    details: { conversation_id: "conv_xyz" },
  },
];

const MOCK_SETTINGS = [
  { name: "data_retention_periods", value: { chat: 365, file: 365 } },
  { name: "content_redaction_enabled", value: false },
  { name: "ip_allowlist_enabled", value: true },
  { name: "sso_provisioning_mode", value: "jit" },
];

function startMockServer(
  overrides?: Record<string, unknown>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/v1/compliance/organizations") {
      return Response.json({ data: [MOCK_ORG], has_more: false });
    }
    if (path.endsWith("/users")) {
      return Response.json({ data: MOCK_USERS, has_more: false });
    }
    if (path.endsWith("/roles")) {
      return Response.json({ data: MOCK_ROLES, has_more: false });
    }
    if (path.match(/\/groups\/[^/]+\/members/)) {
      return Response.json({ data: MOCK_GROUP_MEMBERS, has_more: false });
    }
    // Groups listing is top-level (/v1/compliance/groups), not org-scoped
    if (path === "/v1/compliance/groups") {
      return Response.json({ data: MOCK_GROUPS, has_more: false });
    }
    if (path.endsWith("/settings")) {
      return Response.json({ data: MOCK_SETTINGS });
    }
    if (path === "/v1/compliance/activities") {
      return Response.json({
        data: overrides?.activities ?? MOCK_ACTIVITIES,
        has_more: false,
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
    });
  });

  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

function installFetchMock(mockUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof Request
      ? input.url
      : input.toString();
    const newUrl = reqUrl.replace("https://api.anthropic.com", mockUrl);
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// Method Execution Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "compliance: sync_organizations discovers orgs",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.sync_organizations.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_organizations.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "organizations");
      const data = resources[0].data as { organizations: typeof MOCK_ORG[] };
      assertEquals(data.organizations.length, 1);
      assertEquals(
        data.organizations[0].id,
        "a1b2c3d4-5678-9abc-def0-123456789abc",
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_users paginates and writes user list",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.sync_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_users.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "users");
      assertEquals(resources[0].name, "users");
      const data = resources[0].data as {
        users: typeof MOCK_USERS;
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.users[0].email, "alice@example.com");
      assertEquals(data.users[1].role, "user");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_roles writes role list",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.sync_roles.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_roles.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "roles");
      assertEquals(resources[0].name, "roles");
      const data = resources[0].data as {
        roles: typeof MOCK_ROLES;
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.roles[0].name, "admin");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_groups writes group list",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.sync_groups.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_groups.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "groups");
      assertEquals(resources[0].name, "groups");
      const data = resources[0].data as {
        groups: typeof MOCK_GROUPS;
        count: number;
      };
      assertEquals(data.count, 1);
      assertEquals(data.groups[0].name, "Engineering");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: get_group_members returns members with source type",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.get_group_members.execute(
        { groupId: "grp_1" },
        context as unknown as Parameters<
          typeof model.methods.get_group_members.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "groupMembers");
      assertEquals(resources[0].name, "member:grp_1");
      const data = resources[0].data as {
        members: typeof MOCK_GROUP_MEMBERS;
        groupName: string;
      };
      assertEquals(data.members.length, 2);
      assertEquals(data.members[0].source_type, "scim");
      assertEquals(data.members[1].source_type, "direct");
      assertEquals(data.groupName, "Engineering");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "compliance: get_group_members namespaces groupId so it can't collide with a fixed spec literal",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      // "users" is also the fixed instance name sync_users writes to. If a
      // group happened to have this ID, get_group_members must not land on
      // the same data name.
      await model.methods.get_group_members.execute(
        { groupId: "users" },
        context as unknown as Parameters<
          typeof model.methods.get_group_members.execute
        >[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "groupMembers");
      assertEquals(resources[0].name, "member:users");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_effective_settings writes settings array",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.sync_effective_settings.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_effective_settings.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "effectiveSettings");
      assertEquals(resources[0].name, "effectiveSettings");
      const data = resources[0].data as {
        settings: { name: string; value: unknown }[];
        count: number;
      };
      assertEquals(data.count, 4);
      assertEquals(data.settings[0].name, "data_retention_periods");
      assertEquals(data.settings[2].name, "ip_allowlist_enabled");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: collect_activities writes activity feed",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.collect_activities.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_activities.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "activities");
      const data = resources[0].data as {
        activities: typeof MOCK_ACTIVITIES;
        count: number;
        has_more: boolean;
        newest_id: string;
        oldest_id: string;
      };
      assertEquals(data.count, 2);
      assertEquals(data.has_more, false);
      assertEquals(data.newest_id, "act_1");
      assertEquals(data.oldest_id, "act_2");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_directory writes users, roles, and groups",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.sync_directory.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_directory.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 3);
      const resources = getWrittenResources();
      const specNames = resources.map((r) => r.specName).sort();
      assertEquals(specNames, ["groups", "roles", "users"]);
      // Each spec must write to a distinct instance name — a shared name
      // (e.g. orgId, or any other single literal reused across specs) causes
      // sync methods to overwrite each other's data, since swamp's storage
      // key is (modelId, name) and does not include specName.
      const names = resources.map((r) => r.name).sort();
      assertEquals(names, ["groups", "roles", "users"]);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Auto-Discovery & Pagination Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "compliance: resolveOrgId auto-discovers org when orgId omitted",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await model.methods.sync_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_users.execute
        >[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "users");
      assertEquals(resources[0].name, "users");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: paginateAll handles multi-page responses",
  sanitizeResources: false,
  fn: async () => {
    let requestCount = 0;
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/v1/compliance/organizations") {
        return Response.json({ data: [MOCK_ORG], has_more: false });
      }
      if (path.endsWith("/users")) {
        requestCount++;
        // The real directory endpoints reject the activity feed's cursor.
        if (url.searchParams.has("after_id")) {
          return Response.json({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Unknown query parameter: 'after_id'.",
            },
          }, { status: 400 });
        }
        const pageToken = url.searchParams.get("page");
        if (!pageToken) {
          return Response.json({
            data: [MOCK_USERS[0]],
            has_more: true,
            next_page: "page_tok_2",
          });
        }
        if (pageToken !== "page_tok_2") {
          return new Response("bad page token", { status: 400 });
        }
        return Response.json({
          data: [MOCK_USERS[1]],
          has_more: false,
          next_page: null,
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await model.methods.sync_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_users.execute
        >[1],
      );
      assertEquals(requestCount, 2);
      const resources = getWrittenResources();
      const data = resources[0].data as { users: unknown[]; count: number };
      assertEquals(data.count, 2);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: collect_activities passes filter arguments",
  sanitizeResources: false,
  fn: async () => {
    const captured: Record<string, string> = {};
    let capturedTypes: string[] = [];
    let sawBareTypes = true;
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/compliance/activities") {
        for (const [k, v] of url.searchParams) captured[k] = v;
        capturedTypes = url.searchParams.getAll("activity_types[]");
        sawBareTypes = url.searchParams.has("activity_types");
        return Response.json({ data: MOCK_ACTIVITIES, has_more: false });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_activities.execute(
        {
          activity_types: "claude_chat_created, github_integration_updated,,",
          since: "2026-07-01T00:00:00Z",
          limit: "500",
        },
        context as unknown as Parameters<
          typeof model.methods.collect_activities.execute
        >[1],
      );
      // Repeated `activity_types[]` keys, trimmed, with empties dropped; the
      // bare `activity_types` key is what the API rejects with HTTP 400.
      assertEquals(capturedTypes, [
        "claude_chat_created",
        "github_integration_updated",
      ]);
      assertEquals(sawBareTypes, false);
      assertEquals(captured["created_at.gte"], "2026-07-01T00:00:00.000Z");
      assertEquals(captured["limit"], "500");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "compliance: collect_activities omits activity_types[] when unset or blank",
  sanitizeResources: false,
  fn: async () => {
    const seen: string[] = [];
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/compliance/activities") {
        seen.push(url.search);
        return Response.json({ data: MOCK_ACTIVITIES, has_more: false });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      const ctx = context as unknown as Parameters<
        typeof model.methods.collect_activities.execute
      >[1];
      await model.methods.collect_activities.execute({}, ctx);
      await model.methods.collect_activities.execute(
        { activity_types: " , " },
        ctx,
      );
      assertEquals(seen.length, 2);
      for (const search of seen) {
        assertEquals(search.includes("activity_types"), false);
      }
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: collect_activities rejects a malformed since timestamp",
  sanitizeResources: false,
  fn: async () => {
    const { context } = createModelTestContext({
      globalArgs: { complianceKey: "sk-ant-api01-test" },
      definition: {
        id: "test-id",
        name: "test-compliance",
        version: 1,
        tags: {},
      },
    });
    await assertRejects(
      () =>
        model.methods.collect_activities.execute(
          { since: "not-a-timestamp" },
          context as unknown as Parameters<
            typeof model.methods.collect_activities.execute
          >[1],
        ),
      Error,
      "not a valid ISO-8601 timestamp",
    );
  },
});

Deno.test({
  name: "compliance: sync_effective_settings handles object-style response",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/v1/compliance/organizations") {
        return Response.json({ data: [MOCK_ORG], has_more: false });
      }
      if (path.endsWith("/settings")) {
        return Response.json({
          data_retention_days: 365,
          sso_mode: "jit",
          ip_allowlist_enabled: true,
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          complianceKey: "sk-ant-api01-test",
          orgId: "org_abc123",
        },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await model.methods.sync_effective_settings.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_effective_settings.execute
        >[1],
      );
      const resources = getWrittenResources();
      const data = resources[0].data as {
        settings: { name: string; value: unknown }[];
        count: number;
      };
      assertEquals(data.count, 3);
      const names = data.settings.map((s) => s.name).sort();
      assertEquals(names, [
        "data_retention_days",
        "ip_allowlist_enabled",
        "sso_mode",
      ]);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Error Handling Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "compliance: API error throws with status and body",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, () => {
      return new Response(
        JSON.stringify({ error: { message: "Invalid API key" } }),
        { status: 401 },
      );
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-bad" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await assertRejects(
        () =>
          model.methods.sync_organizations.execute(
            {},
            context as unknown as Parameters<
              typeof model.methods.sync_organizations.execute
            >[1],
          ),
        Error,
        "401",
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "compliance: org ID auto-discovery fails with descriptive error on empty response",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/compliance/organizations") {
        return Response.json({ data: [], has_more: false });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await assertRejects(
        () =>
          model.methods.sync_users.execute(
            {},
            context as unknown as Parameters<
              typeof model.methods.sync_users.execute
            >[1],
          ),
        Error,
        "Could not discover org ID",
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_users maps full_name and organization_role",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/users")) {
        return Response.json({
          data: [{
            id: "user_01XyDMpzjS89pFZXqSFUBDr6",
            full_name: "Priya Sharma",
            email: "priya@example.com",
            organization_role: "admin",
            created_at: "2025-06-01T10:00:00Z",
          }],
          has_more: false,
          next_page: null,
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test", orgId: "org_abc123" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await model.methods.sync_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_users.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        users: { name: string | null; role: string }[];
      };
      assertEquals(data.users[0].name, "Priya Sharma");
      assertEquals(data.users[0].role, "admin");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: sync_roles follows next_page",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/roles")) {
        return url.searchParams.get("page") === "r2"
          ? Response.json({
            data: [MOCK_ROLES[0]],
            has_more: false,
            next_page: null,
          })
          : Response.json({
            data: [MOCK_ROLES[0]],
            has_more: true,
            next_page: "r2",
          });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test", orgId: "org_abc123" },
        definition: {
          id: "test-id",
          name: "test-compliance",
          version: 1,
          tags: {},
        },
      });
      await model.methods.sync_roles.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.sync_roles.execute
        >[1],
      );
      const data = getWrittenResources()[0].data as {
        count: number;
        has_more: boolean;
      };
      assertEquals(data.count, 2);
      assertEquals(data.has_more, false);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: collect_activities sends actor_ids[] and until",
  sanitizeResources: false,
  fn: async () => {
    let actorIds: string[] = [];
    let sawBare = true;
    let until: string | null = null;
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      actorIds = url.searchParams.getAll("actor_ids[]");
      sawBare = url.searchParams.has("actor_ids");
      until = url.searchParams.get("created_at.lte");
      return Response.json({ data: MOCK_ACTIVITIES, has_more: false });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: { id: "t", name: "t", version: 1, tags: {} },
      });
      await model.methods.collect_activities.execute(
        {
          actor_ids: " user_01a, user_01b,,",
          until: "2026-09-30T00:00:00Z",
        },
        context as unknown as Parameters<
          typeof model.methods.collect_activities.execute
        >[1],
      );
      assertEquals(actorIds, ["user_01a", "user_01b"]);
      assertEquals(sawBare, false);
      assertEquals(until, "2026-09-30T00:00:00.000Z");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "compliance: collect_activities follows last_id via after_id",
  sanitizeResources: false,
  fn: async () => {
    const cursors: (string | null)[] = [];
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      const after = url.searchParams.get("after_id");
      cursors.push(after);
      if (!after) {
        return Response.json({
          data: [MOCK_ACTIVITIES[0]],
          has_more: true,
          first_id: "act_1",
          last_id: "act_1",
        });
      }
      return Response.json({
        data: [MOCK_ACTIVITIES[1]],
        has_more: false,
        first_id: "act_2",
        last_id: "act_2",
      });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test" },
        definition: { id: "t", name: "t", version: 1, tags: {} },
      });
      const run = (args: Record<string, string>) =>
        model.methods.collect_activities.execute(
          args,
          context as unknown as Parameters<
            typeof model.methods.collect_activities.execute
          >[1],
        );

      // Default: one page, with a cursor to resume from.
      await run({});
      let data = getWrittenResources().at(-1)!.data as {
        count: number;
        has_more: boolean;
        next_cursor: string | null;
      };
      assertEquals(cursors, [null]);
      assertEquals(data.count, 1);
      assertEquals(data.has_more, true);
      assertEquals(data.next_cursor, "act_1");

      // max_pages follows last_id as after_id until has_more is false.
      cursors.length = 0;
      await run({ max_pages: "5" });
      data = getWrittenResources().at(-1)!.data as typeof data;
      assertEquals(cursors, [null, "act_1"]);
      assertEquals(data.count, 2);
      assertEquals(data.has_more, false);
      assertEquals(data.next_cursor, null);

      // Resume from a stored cursor.
      cursors.length = 0;
      await run({ after_id: "act_1" });
      assertEquals(cursors, ["act_1"]);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Review hardening: pagination edge cases and argument validation
// ---------------------------------------------------------------------------

type Handler = (req: Request, url: URL) => Response;

async function withMock(
  handler: Handler,
  fn: (
    run: <T extends keyof typeof model.methods>(
      method: T,
      args: Record<string, unknown>,
    ) => Promise<void>,
    written: () => { specName: string; name: string; data: any }[],
  ) => Promise<void>,
): Promise<void> {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    return handler(req, new URL(req.url));
  });
  const addr = server.addr as Deno.NetAddr;
  const uninstall = installFetchMock(`http://localhost:${addr.port}`);
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { complianceKey: "sk-ant-api01-test", orgId: "org_abc123" },
      definition: { id: "t", name: "t", version: 1, tags: {} },
    });
    await fn(
      async (method, args) => {
        // deno-lint-ignore no-explicit-any
        await (model.methods[method] as any).execute(args, context);
      },
      // deno-lint-ignore no-explicit-any
      () => getWrittenResources() as any,
    );
  } finally {
    uninstall();
    await server.shutdown();
  }
}

Deno.test({
  name:
    "compliance: get_group_members pages members, resolves name from a later groups page, encodes the id",
  sanitizeResources: false,
  fn: async () => {
    const paths: string[] = [];
    await withMock((_req, url) => {
      paths.push(url.pathname + url.search);
      if (url.pathname === "/v1/compliance/groups") {
        return url.searchParams.get("page") === "g2"
          ? Response.json({
            data: [{ id: "grp/2", name: "Second page group" }],
            has_more: false,
            next_page: null,
          })
          : Response.json({
            data: [{ id: "grp_1", name: "First" }],
            has_more: true,
            next_page: "g2",
          });
      }
      if (url.pathname.endsWith("/members")) {
        return url.searchParams.get("page") === "m2"
          ? Response.json({
            data: [{ user_id: "user_2", email: "b@example.com" }],
            has_more: false,
            next_page: null,
          })
          : Response.json({
            data: [{ user_id: "user_1", email: "a@example.com" }],
            has_more: true,
            next_page: "m2",
          });
      }
      return new Response("Not found", { status: 404 });
    }, async (run, written) => {
      await run("get_group_members", { groupId: "grp/2" });
      const data = written()[0].data;
      assertEquals(data.count, 2);
      assertEquals(data.has_more, false);
      assertEquals(data.groupName, "Second page group");
      assertEquals(data.members.map((m: any) => m.id), ["user_1", "user_2"]);
      // The slash in the ID must not change the request path.
      assertEquals(
        paths.some((p) =>
          p.startsWith("/v1/compliance/groups/grp%2F2/members")
        ),
        true,
      );
    });
  },
});

Deno.test({
  name:
    "compliance: sync_directory follows next_page for users, roles and groups",
  sanitizeResources: false,
  fn: async () => {
    const two = (items: [unknown, unknown], page: string | null) =>
      page === "p2"
        ? Response.json({ data: [items[1]], has_more: false, next_page: null })
        : Response.json({ data: [items[0]], has_more: true, next_page: "p2" });
    await withMock((_req, url) => {
      const page = url.searchParams.get("page");
      if (url.pathname.endsWith("/users")) {
        return two([MOCK_USERS[0], MOCK_USERS[1]], page);
      }
      if (url.pathname.endsWith("/roles")) {
        return two(
          [{ id: "role_a", name: "A" }, { id: "role_b", name: "B" }],
          page,
        );
      }
      if (url.pathname === "/v1/compliance/groups") {
        return two(
          [{ id: "grp_a", name: "A" }, { id: "grp_b", name: "B" }],
          page,
        );
      }
      return new Response("Not found", { status: 404 });
    }, async (run, written) => {
      await run("sync_directory", {});
      const byName = Object.fromEntries(
        written().map((r) => [r.specName, r.data]),
      );
      assertEquals(byName.users.count, 2);
      assertEquals(byName.roles.roles.map((r: any) => r.id), [
        "role_a",
        "role_b",
      ]);
      assertEquals(byName.groups.groups.map((g: any) => g.id), [
        "grp_a",
        "grp_b",
      ]);
      for (const k of ["users", "roles", "groups"]) {
        assertEquals(byName[k].has_more, false);
      }
    });
  },
});

Deno.test({
  name:
    "compliance: directory pagination reports truncation at the 20-page cap",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock((_req, url) => {
      requests++;
      return Response.json({
        data: [MOCK_USERS[0]],
        has_more: true,
        next_page: `tok_${url.searchParams.get("page") ?? "0"}_${requests}`,
      });
    }, async (run, written) => {
      await run("sync_users", {});
      assertEquals(requests, 20);
      assertEquals(written()[0].data.has_more, true);
      assertEquals(written()[0].data.count, 20);
    });
  },
});

Deno.test({
  name:
    "compliance: directory pagination reports has_more when next_page is missing",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return Response.json({
        data: MOCK_USERS,
        has_more: true,
        next_page: null,
      });
    }, async (run, written) => {
      await run("sync_users", {});
      assertEquals(requests, 1);
      assertEquals(written()[0].data.has_more, true);
    });
  },
});

Deno.test({
  name:
    "compliance: directory pagination follows next_page when has_more is absent",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock((_req, url) => {
      requests++;
      return url.searchParams.get("page") === "p2"
        ? Response.json({ data: [MOCK_USERS[1]], next_page: null })
        : Response.json({ data: [MOCK_USERS[0]], next_page: "p2" });
    }, async (run, written) => {
      await run("sync_users", {});
      assertEquals(requests, 2);
      assertEquals(written()[0].data.count, 2);
      assertEquals(written()[0].data.has_more, false);
    });
  },
});

Deno.test({
  name: "compliance: directory pagination stops when the page token repeats",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return Response.json({
        data: [MOCK_USERS[0]],
        has_more: true,
        next_page: "same",
      });
    }, async (run, written) => {
      await run("sync_users", {});
      // Page 1 yields "same"; page 2 yields "same" again, which is a repeat.
      assertEquals(requests, 2);
      assertEquals(written()[0].data.has_more, true);
    });
  },
});

Deno.test({
  name:
    "compliance: collect_activities stops on a cursor that does not advance",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return Response.json({ data: [], has_more: true, last_id: "act_1" });
    }, async (run, written) => {
      await run("collect_activities", { after_id: " act_1 ", max_pages: "50" });
      assertEquals(requests, 1);
      const data = written()[0].data;
      // The API claimed more data, so the output must not say "complete".
      assertEquals(data.has_more, true);
      assertEquals(data.stalled, true);
      assertEquals(data.next_cursor, null);
      assertEquals(data.filters.after_id, "act_1");
    });
  },
});

Deno.test({
  name: "compliance: collect_activities treats a blank after_id as no cursor",
  sanitizeResources: false,
  fn: async () => {
    let sawAfter: boolean | null = null;
    await withMock((_req, url) => {
      sawAfter = url.searchParams.has("after_id");
      return Response.json({ data: [], has_more: false });
    }, async (run) => {
      await run("collect_activities", { after_id: "   " });
      assertEquals(sawAfter, false);
    });
  },
});

Deno.test({
  name: "compliance: collect_activities rejects bad numeric and time arguments",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return Response.json({ data: [], has_more: false });
    }, async (run) => {
      const bad: [Record<string, string>, string][] = [
        [{ limit: "-5" }, "limit"],
        [{ limit: "0" }, "limit"],
        [{ limit: "abc" }, "limit"],
        [{ max_pages: "0" }, "max_pages"],
        [{ max_pages: "abc" }, "max_pages"],
        [{ since: "foo 1" }, "since"],
        [{ since: "2026-10-01T10:00:00" }, "no timezone"],
        [{ since: "2026-10-01 10:00" }, "no timezone"],
        [{ since: "2026-02-31" }, "real calendar date"],
        [{ until: "2026-13-45" }, "real calendar date"],
        [{ until: "2026" }, "not a valid ISO-8601 timestamp"],
        [{ since: "0050-01-01" }, "year must be between"],
        [{ until: "2026-10-01T24:00:00Z" }, "not a valid ISO-8601 timestamp"],
        [{ until: "2026-10-01T10:60:00Z" }, "not a valid ISO-8601 timestamp"],
        [{ until: "9999-12-31T23:59:59-05:00" }, "year must be between"],
        [
          { since: "2026-10-01T00:00:00Z", until: "2026-09-01T00:00:00Z" },
          "earlier than since",
        ],
      ];
      for (const [args, text] of bad) {
        await assertRejects(() => run("collect_activities", args), Error, text);
      }
      assertEquals(requests, 0);
    });
  },
});

Deno.test({
  name: "compliance: collect_activities normalizes since/until to UTC ISO",
  sanitizeResources: false,
  fn: async () => {
    let gte: string | null = null;
    let lte: string | null = null;
    await withMock((_req, url) => {
      gte = url.searchParams.get("created_at.gte");
      lte = url.searchParams.get("created_at.lte");
      return Response.json({ data: [], has_more: false });
    }, async (run) => {
      await run("collect_activities", {
        since: "2026-10-01T02:00:00+02:00",
        until: "2026-10-02",
      });
      assertEquals(gte, "2026-10-01T00:00:00.000Z");
      assertEquals(lte, "2026-10-02T00:00:00.000Z");
    });
  },
});

Deno.test({
  name:
    "compliance: collect_activities reports has_more when the API gives no cursor",
  sanitizeResources: false,
  fn: async () => {
    await withMock(() => {
      return Response.json({
        data: [MOCK_ACTIVITIES[0]],
        has_more: true,
        last_id: null,
      });
    }, async (run, written) => {
      // Falls back to the last item's id, which advances from no cursor...
      await run("collect_activities", { max_pages: "1" });
      assertEquals(written()[0].data.has_more, true);
      assertEquals(written()[0].data.next_cursor, "act_1");
    });
    await withMock(() => {
      return Response.json({ data: [], has_more: true });
    }, async (run, written) => {
      // ...but an empty page with has_more and no cursor is a stall.
      await run("collect_activities", {});
      const data = written()[0].data;
      assertEquals(data.has_more, true);
      assertEquals(data.stalled, true);
      assertEquals(data.next_cursor, null);
    });
  },
});

Deno.test({
  name: "compliance: collect_activities ignores a non-string last_id",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return Response.json({ data: [], has_more: true, last_id: 123 });
    }, async (run, written) => {
      await run("collect_activities", { max_pages: "5" });
      assertEquals(requests, 1);
      assertEquals(written()[0].data.stalled, true);
      assertEquals(written()[0].data.next_cursor, null);
    });
  },
});

Deno.test({
  name:
    "compliance: directory pagination is complete when the 20th page ends it",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return requests < 20
        ? Response.json({
          data: [MOCK_USERS[0]],
          has_more: true,
          next_page: `tok_${requests}`,
        })
        : Response.json({
          data: [MOCK_USERS[1]],
          has_more: false,
          next_page: null,
        });
    }, async (run, written) => {
      await run("sync_users", {});
      assertEquals(requests, 20);
      assertEquals(written()[0].data.count, 20);
      assertEquals(written()[0].data.has_more, false);
    });
  },
});

Deno.test({
  name: "compliance: sync_directory writes nothing when a later fetch fails",
  sanitizeResources: false,
  fn: async () => {
    await withMock((_req, url) => {
      if (url.pathname.endsWith("/users")) {
        return Response.json({ data: MOCK_USERS, has_more: false });
      }
      return new Response("rate limited", { status: 429 });
    }, async (run, written) => {
      await assertRejects(() => run("sync_directory", {}), Error, "429");
      assertEquals(written().length, 0);
    });
  },
});

Deno.test({
  name: "compliance: get_group_members reads full_name for member names",
  sanitizeResources: false,
  fn: async () => {
    await withMock((_req, url) => {
      if (url.pathname.endsWith("/members")) {
        return Response.json({
          data: [{
            user_id: "user_1",
            email: "a@example.com",
            full_name: "Ann",
          }],
          has_more: false,
        });
      }
      return Response.json({ data: [], has_more: false });
    }, async (run, written) => {
      await run("get_group_members", { groupId: "grp_x" });
      assertEquals(written()[0].data.members[0].name, "Ann");
      assertEquals(written()[0].data.groupName, "grp_x");
    });
  },
});

Deno.test({
  name: "compliance: collect_activities completes when has_more is absent",
  sanitizeResources: false,
  fn: async () => {
    await withMock(() => {
      return Response.json({ data: [MOCK_ACTIVITIES[0]], last_id: "act_1" });
    }, async (run, written) => {
      await run("collect_activities", { max_pages: "5" });
      const data = written()[0].data;
      assertEquals(data.has_more, false);
      assertEquals(data.stalled, false);
      assertEquals(data.next_cursor, null);
      assertEquals(data.pages, 1);
    });
  },
});

Deno.test({
  name:
    "compliance: collect_activities stalls on a last_id equal to the cursor even with data",
  sanitizeResources: false,
  fn: async () => {
    let requests = 0;
    await withMock(() => {
      requests++;
      return Response.json({
        data: [MOCK_ACTIVITIES[0]],
        has_more: true,
        last_id: "act_1",
      });
    }, async (run, written) => {
      await run("collect_activities", { after_id: "act_1", max_pages: "9" });
      assertEquals(requests, 1);
      const data = written()[0].data;
      assertEquals(data.count, 1);
      assertEquals(data.has_more, true);
      assertEquals(data.stalled, true);
    });
  },
});

Deno.test({
  name:
    "compliance: get_group_members logs when the group list is truncated and the name is not found",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/members")) {
        return Response.json({ data: [], has_more: false });
      }
      // Group list claims more data but gives no usable token.
      return Response.json({
        data: [{ id: "grp_other", name: "Other" }],
        has_more: true,
        next_page: null,
      });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const messages: string[] = [];
      const { context } = createModelTestContext({
        globalArgs: { complianceKey: "sk-ant-api01-test", orgId: "org_abc123" },
        definition: { id: "t", name: "t", version: 1, tags: {} },
      });
      // deno-lint-ignore no-explicit-any
      const logger = (context as any).logger;
      const original = logger.info?.bind(logger);
      logger.info = (msg: string, ...rest: unknown[]) => {
        messages.push(String(msg));
        return original?.(msg, ...rest);
      };
      await model.methods.get_group_members.execute(
        { groupId: "grp_missing" },
        context as unknown as Parameters<
          typeof model.methods.get_group_members.execute
        >[1],
      );
      assertEquals(
        messages.some((m) => m.includes("truncated group list")),
        true,
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
