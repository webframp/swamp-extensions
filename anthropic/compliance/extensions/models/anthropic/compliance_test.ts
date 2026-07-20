// Claude Enterprise Compliance Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
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
    if (path.endsWith("/groups")) {
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
        const afterId = url.searchParams.get("after_id");
        if (!afterId) {
          return Response.json({
            data: [MOCK_USERS[0]],
            has_more: true,
          });
        }
        return Response.json({
          data: [MOCK_USERS[1]],
          has_more: false,
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
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/compliance/activities") {
        for (const [k, v] of url.searchParams) captured[k] = v;
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
          activity_types: "user.login,conversation.create",
          since: "2026-07-01T00:00:00Z",
          limit: "500",
        },
        context as unknown as Parameters<
          typeof model.methods.collect_activities.execute
        >[1],
      );
      assertEquals(
        captured["activity_types"],
        "user.login,conversation.create",
      );
      assertEquals(captured["created_at.gte"], "2026-07-01T00:00:00Z");
      assertEquals(captured["limit"], "500");
    } finally {
      uninstall();
      await server.shutdown();
    }
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
