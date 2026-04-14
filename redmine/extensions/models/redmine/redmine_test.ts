// Redmine Model Tests
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./redmine.ts";

// ---------------------------------------------------------------------------
// Mock Server Helpers
// ---------------------------------------------------------------------------

function startMockRedmine(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

function installFetchMock(
  realHost: string,
  mockUrl: string,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof Request
      ? input.url
      : String(input);
    const newUrl = reqUrl.replace(realHost, mockUrl);
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// Structure Tests
// ---------------------------------------------------------------------------

Deno.test("redmine model: has correct type", () => {
  assertEquals(model.type, "@webframp/redmine");
});

Deno.test("redmine model: has valid CalVer version", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("redmine model: globalArguments validates host, apiKey, project", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.host);
  assertExists(shape.apiKey);
  assertExists(shape.project);

  // Valid parse
  const result = model.globalArguments.parse({
    host: "https://redmine.example.com",
    apiKey: "a".repeat(40),
    project: "my-project",
  });
  assertEquals(result.host, "https://redmine.example.com");
  assertEquals(result.project, "my-project");
});

Deno.test("redmine model: has all 7 resources", () => {
  assertExists(model.resources);
  const names = Object.keys(model.resources);
  assertEquals(names.length, 7);
  assertExists(model.resources.issues);
  assertExists(model.resources.issue_detail);
  assertExists(model.resources.projects);
  assertExists(model.resources.statuses);
  assertExists(model.resources.trackers);
  assertExists(model.resources.users);
  assertExists(model.resources.custom_fields);
});

Deno.test("redmine model: has all 9 methods", () => {
  assertExists(model.methods);
  const names = Object.keys(model.methods);
  assertEquals(names.length, 9);
  assertExists(model.methods.list_statuses);
  assertExists(model.methods.list_trackers);
  assertExists(model.methods.list_projects);
  assertExists(model.methods.list_users);
  assertExists(model.methods.list_custom_fields);
  assertExists(model.methods.list_issues);
  assertExists(model.methods.get_issue);
  assertExists(model.methods.create_issue);
  assertExists(model.methods.update_issue);
});

// ---------------------------------------------------------------------------
// Lookup Method Tests
// ---------------------------------------------------------------------------

const TEST_HOST = "https://redmine.example.com";
const TEST_API_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TEST_PROJECT = "test-project";

function makeContext() {
  return createModelTestContext({
    globalArgs: {
      host: TEST_HOST,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
    },
    definition: { id: "test-id", name: "test-redmine", version: 1, tags: {} },
  });
}

Deno.test({
  name: "redmine model: list_statuses fetches and writes statuses resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/issue_statuses.json") {
        return Response.json({
          issue_statuses: [
            { id: 1, name: "New", is_closed: false },
            { id: 2, name: "In Progress", is_closed: false },
            { id: 5, name: "Closed", is_closed: true },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installFetchMock(TEST_HOST, url);

    try {
      const { context, getWrittenResources } = makeContext();
      const result = await model.methods.list_statuses.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_statuses.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "statuses");
      assertEquals(resources[0].name, "all");

      const data = resources[0].data as {
        statuses: Array<{ id: number; name: string; isClosed: boolean }>;
      };
      assertEquals(data.statuses.length, 3);
      assertEquals(data.statuses[0].name, "New");
      assertEquals(data.statuses[0].isClosed, false);
      assertEquals(data.statuses[2].name, "Closed");
      assertEquals(data.statuses[2].isClosed, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmine model: list_trackers fetches and writes trackers resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/trackers.json") {
        return Response.json({
          trackers: [
            {
              id: 1,
              name: "Bug",
              default_status: { id: 1, name: "New" },
              description: "Bug reports",
            },
            {
              id: 2,
              name: "Feature",
              default_status: { id: 1, name: "New" },
              description: "Feature requests",
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installFetchMock(TEST_HOST, url);

    try {
      const { context, getWrittenResources } = makeContext();
      const result = await model.methods.list_trackers.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_trackers.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "trackers");
      assertEquals(resources[0].name, "all");

      const data = resources[0].data as {
        trackers: Array<{
          id: number;
          name: string;
          defaultStatus: { id: number; name: string };
          description: string;
        }>;
      };
      assertEquals(data.trackers.length, 2);
      assertEquals(data.trackers[0].name, "Bug");
      assertEquals(data.trackers[0].defaultStatus.id, 1);
      assertEquals(data.trackers[1].description, "Feature requests");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmine model: list_projects fetches and writes projects resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/projects.json") {
        return Response.json({
          projects: [
            {
              id: 1,
              name: "Project Alpha",
              identifier: "alpha",
              description: "Alpha project",
              status: 1,
              is_public: true,
              created_on: "2024-01-01T00:00:00Z",
              updated_on: "2024-06-01T00:00:00Z",
            },
            {
              id: 2,
              name: "Project Beta",
              identifier: "beta",
              description: "Beta project",
              status: 1,
              is_public: false,
              created_on: "2024-03-01T00:00:00Z",
              updated_on: "2024-07-01T00:00:00Z",
            },
          ],
          total_count: 2,
          offset: 0,
          limit: 25,
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installFetchMock(TEST_HOST, url);

    try {
      const { context, getWrittenResources } = makeContext();
      const result = await model.methods.list_projects.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_projects.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "projects");
      assertEquals(resources[0].name, "all");

      const data = resources[0].data as {
        projects: Array<{
          id: number;
          name: string;
          identifier: string;
          description: string;
          status: number;
          isPublic: boolean;
          createdOn: string;
          updatedOn: string;
        }>;
        fetchedAt: string;
      };
      assertEquals(data.projects.length, 2);
      assertEquals(data.projects[0].name, "Project Alpha");
      assertEquals(data.projects[0].identifier, "alpha");
      assertEquals(data.projects[0].isPublic, true);
      assertEquals(data.projects[1].isPublic, false);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmine model: list_users fetches and writes users resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((req) => {
      const u = new URL(req.url);
      if (u.pathname === `/projects/${TEST_PROJECT}/memberships.json`) {
        return Response.json({
          memberships: [
            {
              id: 1,
              project: { id: 1, name: "Test Project" },
              user: { id: 10, name: "Alice Smith" },
              roles: [{ id: 3, name: "Manager" }],
            },
            {
              id: 2,
              project: { id: 1, name: "Test Project" },
              group: { id: 20, name: "Developers" },
              roles: [{ id: 4, name: "Developer" }],
            },
          ],
          total_count: 2,
          offset: 0,
          limit: 25,
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installFetchMock(TEST_HOST, url);

    try {
      const { context, getWrittenResources } = makeContext();
      const result = await model.methods.list_users.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_users.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "users");
      assertEquals(resources[0].name, TEST_PROJECT);

      const data = resources[0].data as {
        members: Array<{
          id: number;
          name: string;
          type: string;
          roles: Array<{ id: number; name: string }>;
        }>;
        project: string;
        fetchedAt: string;
      };
      assertEquals(data.members.length, 2);
      assertEquals(data.members[0].name, "Alice Smith");
      assertEquals(data.members[0].type, "user");
      assertEquals(data.members[1].name, "Developers");
      assertEquals(data.members[1].type, "group");
      assertEquals(data.project, TEST_PROJECT);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "redmine model: list_custom_fields fetches and writes custom_fields resource",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/custom_fields.json") {
        return Response.json({
          custom_fields: [
            {
              id: 1,
              name: "Sprint",
              customized_type: "issue",
              field_format: "list",
              is_required: false,
              is_filter: true,
              multiple: false,
              default_value: "",
              possible_values: [{ value: "Sprint 1" }, { value: "Sprint 2" }],
              trackers: [{ id: 1, name: "Bug" }],
            },
            {
              id: 2,
              name: "Story Points",
              customized_type: "issue",
              field_format: "int",
              is_required: false,
              is_filter: true,
              multiple: false,
              default_value: "0",
              possible_values: [],
              trackers: [{ id: 2, name: "Feature" }],
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const uninstall = installFetchMock(TEST_HOST, url);

    try {
      const { context, getWrittenResources } = makeContext();
      const result = await model.methods.list_custom_fields.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_custom_fields.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "custom_fields");
      assertEquals(resources[0].name, "all");

      const data = resources[0].data as {
        customFields: Array<{
          id: number;
          name: string;
          fieldFormat: string;
          possibleValues: Array<{ value: string }>;
        }>;
        fetchedAt: string;
      };
      assertEquals(data.customFields.length, 2);
      assertEquals(data.customFields[0].name, "Sprint");
      assertEquals(data.customFields[0].fieldFormat, "list");
      assertEquals(data.customFields[0].possibleValues.length, 2);
      assertEquals(data.customFields[1].name, "Story Points");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Stub Method Tests
// ---------------------------------------------------------------------------

Deno.test("redmine model: stub methods throw Not implemented", () => {
  const { context } = makeContext();
  const ctx = context as unknown as Parameters<
    typeof model.methods.list_issues.execute
  >[1];

  assertThrows(
    () => model.methods.list_issues.execute({}, ctx),
    Error,
    "Not implemented",
  );
  assertThrows(
    () =>
      model.methods.get_issue.execute(
        { issueId: 1 },
        ctx as unknown as Parameters<
          typeof model.methods.get_issue.execute
        >[1],
      ),
    Error,
    "Not implemented",
  );
  assertThrows(
    () =>
      model.methods.create_issue.execute(
        { subject: "test" },
        ctx as unknown as Parameters<
          typeof model.methods.create_issue.execute
        >[1],
      ),
    Error,
    "Not implemented",
  );
  assertThrows(
    () =>
      model.methods.update_issue.execute(
        { issueId: 1 },
        ctx as unknown as Parameters<
          typeof model.methods.update_issue.execute
        >[1],
      ),
    Error,
    "Not implemented",
  );
});
