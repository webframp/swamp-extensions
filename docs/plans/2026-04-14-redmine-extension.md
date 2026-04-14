# Redmine Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `@webframp/redmine` swamp model extension that wraps the Redmine REST API, plus skills for workflow automation, reports for flow metrics, and a scaffold-story workflow.

**Architecture:** Single model extension with an HTTP helper module (`_lib/api.ts`) handling authentication and pagination against the Redmine JSON API. Credentials (host URL + API key) passed as global arguments with sensitive marking. Default project as a global argument with per-method override. Skills are Claude Code guidance files that invoke the model. Reports compute flow metrics from issue history. Workflow orchestrates multi-issue creation.

**Tech Stack:** Deno, TypeScript, Zod 4, `@systeminit/swamp-testing`, Redmine REST API (JSON)

---

## Context

### Redmine API Basics

- Auth: `X-Redmine-API-Key` header with 40-char hex key
- Base URL: `{host}` global arg (e.g., `https://cdredmine.example.org`)
- All endpoints return JSON when accessed as `/endpoint.json`
- Pagination: `offset` + `limit` params, response includes `total_count`, `offset`, `limit`
- Issues support `include=journals,children` for detail views
- Custom fields filtered via `cf_{id}` query params
- Create returns 201 with the created issue; Update returns 204 with no body

### File Structure

```
redmine/
  .swamp.yaml              # repo marker (run swamp repo init)
  manifest.yaml            # extension manifest
  deno.json                # deps + tasks
  extensions/
    models/
      redmine/
        _lib/
          api.ts           # HTTP helper (auth, pagination, error handling)
          api_test.ts      # API helper tests
        redmine.ts         # model definition
        redmine_test.ts    # model tests
    reports/
      flow_metrics_report.ts       # cycle time, lead time, throughput, WIP age
      flow_metrics_report_test.ts  # report tests
      sprint_summary_report.ts     # sprint status summary
      sprint_summary_report_test.ts
  workflows/
    (scaffold-story workflow YAML - created via swamp workflow create)
```

### Existing Patterns to Follow

- **HTTP model**: `cloudflare/extensions/models/cloudflare/zone.ts` + `_lib/api.ts`
- **Test mock**: `cloudflare/extensions/models/cloudflare/zone_test.ts` — local `Deno.serve` + fetch intercept
- **Report**: `sre/extensions/reports/sre_health_report.ts` + `aws/ops/extensions/reports/incident_report.ts`
- **Workflow YAML**: `sre/workflows/workflow-*.yaml` and `aws/ops/workflows/workflow-*.yaml`
- **Manifest**: `cloudflare/manifest.yaml`, `aws/ops/manifest.yaml`

---

### Task 1: Scaffold Extension Directory and Configuration

**Files:**
- Create: `redmine/.swamp.yaml`
- Create: `redmine/manifest.yaml`
- Create: `redmine/deno.json`

**Step 1: Initialize the extension directory**

Create `redmine/deno.json`:
```json
{
  "tasks": {
    "check": "deno check extensions/models/redmine/*.ts extensions/models/redmine/_lib/*.ts",
    "lint": "deno lint extensions/models/ extensions/reports/",
    "fmt": "deno fmt extensions/models/ extensions/reports/",
    "fmt:check": "deno fmt --check extensions/models/ extensions/reports/",
    "test": "deno test --allow-env --allow-net extensions/models/ extensions/reports/"
  },
  "lint": {
    "rules": {
      "exclude": ["no-import-prefix"]
    }
  },
  "imports": {
    "zod": "npm:zod@4.3.6",
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing@0.20260331.5"
  }
}
```

**Step 2: Create the manifest**

Create `redmine/manifest.yaml`:
```yaml
manifestVersion: 1
name: "@webframp/redmine"
version: "2026.04.14.1"
description: |
  Redmine issue tracker integration - manage issues, projects, and workflows.

  Provides model methods for CRUD operations on Redmine issues (themes, stories,
  tasks), project queries, status/tracker/user lookups, and custom field access.
  Includes reports for flow metrics and sprint summaries, plus a scaffold-story
  workflow for creating stories with child tasks.

  ## Quick Start

  ```bash
  swamp extension pull @webframp/redmine
  swamp model create @webframp/redmine tracker \
    --global-arg host=https://your-redmine.example.org \
    --global-arg apiKey=YOUR_API_KEY \
    --global-arg project=your-project
  ```
repository: "https://github.com/webframp/swamp-extensions"
models:
  - redmine/redmine.ts
reports:
  - flow_metrics_report.ts
  - sprint_summary_report.ts
labels:
  - redmine
  - issue-tracker
  - workflow
  - kanban
  - project-management
platforms:
  - linux-x86_64
  - linux-aarch64
  - darwin-x86_64
  - darwin-aarch64
```

**Step 3: Run swamp repo init**

```bash
cd redmine && swamp repo init
```

This generates `.swamp.yaml`. Do NOT commit the generated `CLAUDE.md`.

**Step 4: Commit**

```bash
git add redmine/deno.json redmine/manifest.yaml redmine/.swamp.yaml
git commit -m "feat(redmine): scaffold extension directory and config"
```

---

### Task 2: API Helper Module

**Files:**
- Create: `redmine/extensions/models/redmine/_lib/api.ts`
- Create: `redmine/extensions/models/redmine/_lib/api_test.ts`

**Step 1: Write the API helper tests**

Create `redmine/extensions/models/redmine/_lib/api_test.ts`:
```typescript
// Redmine API Helper Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1";

// We'll import from api.ts once it exists
// For now, test the mock server pattern and basic fetch behavior

// Helper: start a mock Redmine server
function startMockRedmine(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

// Helper: intercept globalThis.fetch to redirect to mock server
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

Deno.test({
  name: "redmineApi sends correct auth header and parses JSON",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((req) => {
      const apiKey = req.headers.get("X-Redmine-API-Key");
      assertEquals(apiKey, "test-key-abc123");
      return Response.json({ issue_statuses: [{ id: 1, name: "New", is_closed: false }] });
    });
    try {
      const { redmineApi } = await import("./api.ts");
      const result = await redmineApi<{ issue_statuses: unknown[] }>(
        url,
        "test-key-abc123",
        "GET",
        "/issue_statuses.json",
      );
      assertEquals(result.issue_statuses.length, 1);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi throws on non-2xx response",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((_req) => {
      return new Response(JSON.stringify({ errors: ["Not found"] }), { status: 404 });
    });
    try {
      const { redmineApi } = await import("./api.ts");
      await assertRejects(
        () => redmineApi(url, "key", "GET", "/issues/99999.json"),
        Error,
        "404",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApiPaginated fetches all pages",
  sanitizeResources: false,
  fn: async () => {
    let callCount = 0;
    const { url, server } = startMockRedmine((req) => {
      const reqUrl = new URL(req.url);
      const offset = parseInt(reqUrl.searchParams.get("offset") || "0");
      callCount++;
      if (offset === 0) {
        return Response.json({
          issues: [{ id: 1 }, { id: 2 }],
          total_count: 3,
          offset: 0,
          limit: 2,
        });
      }
      return Response.json({
        issues: [{ id: 3 }],
        total_count: 3,
        offset: 2,
        limit: 2,
      });
    });
    try {
      const { redmineApiPaginated } = await import("./api.ts");
      const result = await redmineApiPaginated<{ id: number }>(
        url,
        "key",
        "/issues.json",
        "issues",
        {},
        10,
      );
      assertEquals(result.length, 3);
      assertEquals(callCount, 2);
      assertEquals(result[2].id, 3);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApiPaginated respects limit cap",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((_req) => {
      return Response.json({
        issues: [{ id: 1 }, { id: 2 }, { id: 3 }],
        total_count: 100,
        offset: 0,
        limit: 25,
      });
    });
    try {
      const { redmineApiPaginated } = await import("./api.ts");
      // Ask for max 2 items
      const result = await redmineApiPaginated<{ id: number }>(
        url,
        "key",
        "/issues.json",
        "issues",
        {},
        2,
      );
      assertEquals(result.length, 2);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi sends JSON body on POST",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine(async (req) => {
      assertEquals(req.method, "POST");
      assertEquals(req.headers.get("Content-Type"), "application/json");
      const body = await req.json();
      assertEquals(body.issue.subject, "Test issue");
      return new Response(
        JSON.stringify({ issue: { id: 42, subject: "Test issue" } }),
        { status: 201 },
      );
    });
    try {
      const { redmineApi } = await import("./api.ts");
      const result = await redmineApi<{ issue: { id: number } }>(
        url,
        "key",
        "POST",
        "/issues.json",
        { issue: { subject: "Test issue" } },
      );
      assertEquals(result.issue.id, 42);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "redmineApi handles 204 No Content on PUT",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockRedmine((_req) => {
      return new Response(null, { status: 204 });
    });
    try {
      const { redmineApi } = await import("./api.ts");
      const result = await redmineApi(
        url,
        "key",
        "PUT",
        "/issues/1.json",
        { issue: { status_id: 2 } },
      );
      assertEquals(result, null);
    } finally {
      await server.shutdown();
    }
  },
});
```

**Step 2: Run tests to verify they fail**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/_lib/api_test.ts
```
Expected: FAIL — `api.ts` does not exist yet.

**Step 3: Write the API helper**

Create `redmine/extensions/models/redmine/_lib/api.ts`:
```typescript
// Redmine API Helper
// Shared utilities for the Redmine model
// SPDX-License-Identifier: Apache-2.0

/**
 * Make a single Redmine API request.
 * Returns parsed JSON for 2xx responses, null for 204 No Content.
 * Throws on non-2xx with status code and error body.
 */
export async function redmineApi<T = null>(
  host: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${host}${path}`;
  const headers: Record<string, string> = {
    "X-Redmine-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null as T;
  }

  if (!response.ok) {
    let errorMsg: string;
    try {
      const errorBody = await response.json();
      errorMsg = Array.isArray(errorBody.errors)
        ? errorBody.errors.join("; ")
        : JSON.stringify(errorBody);
    } catch {
      errorMsg = response.statusText;
    }
    throw new Error(`Redmine API ${response.status}: ${errorMsg}`);
  }

  return (await response.json()) as T;
}

/**
 * Paginated Redmine API request.
 * Fetches pages until all items are retrieved or maxItems is reached.
 *
 * @param host - Redmine host URL
 * @param apiKey - API key
 * @param path - API path (e.g., "/issues.json")
 * @param resultKey - JSON key containing the array (e.g., "issues")
 * @param params - Additional query parameters
 * @param maxItems - Maximum items to return (default 100, max 500)
 */
export async function redmineApiPaginated<T>(
  host: string,
  apiKey: string,
  path: string,
  resultKey: string,
  params: Record<string, string> = {},
  maxItems: number = 100,
): Promise<T[]> {
  const cap = Math.min(maxItems, 500);
  const allResults: T[] = [];
  let offset = 0;
  const pageSize = Math.min(cap, 100); // Redmine max per page is 100

  while (allResults.length < cap) {
    const queryParams = new URLSearchParams({
      ...params,
      offset: String(offset),
      limit: String(pageSize),
    });

    const url = `${host}${path}?${queryParams}`;
    const response = await fetch(url, {
      headers: {
        "X-Redmine-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      let errorMsg: string;
      try {
        const errorBody = await response.json();
        errorMsg = Array.isArray(errorBody.errors)
          ? errorBody.errors.join("; ")
          : JSON.stringify(errorBody);
      } catch {
        errorMsg = response.statusText;
      }
      throw new Error(`Redmine API ${response.status}: ${errorMsg}`);
    }

    const data = await response.json();
    const items = (data[resultKey] || []) as T[];

    for (const item of items) {
      if (allResults.length >= cap) break;
      allResults.push(item);
    }

    const totalCount = data.total_count as number;
    offset += items.length;

    if (offset >= totalCount || items.length === 0) {
      break;
    }
  }

  return allResults;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/_lib/api_test.ts
```
Expected: All 6 tests PASS.

**Step 5: Run check, lint, fmt**

```bash
cd redmine && deno check extensions/models/redmine/_lib/*.ts
cd redmine && deno lint extensions/models/redmine/_lib/
cd redmine && deno fmt --check extensions/models/redmine/_lib/
```

**Step 6: Commit**

```bash
git add redmine/extensions/models/redmine/_lib/
git commit -m "feat(redmine): add API helper with auth, pagination, and error handling"
```

---

### Task 3: Model Definition — Global Args, Resources, and Lookup Methods

This task creates the model skeleton with global arguments, all resource definitions, and the read-only lookup methods (`list_statuses`, `list_trackers`, `list_projects`, `list_users`, `list_custom_fields`).

**Files:**
- Create: `redmine/extensions/models/redmine/redmine.ts`
- Create: `redmine/extensions/models/redmine/redmine_test.ts`

**Step 1: Write the structure and lookup tests**

Create `redmine/extensions/models/redmine/redmine_test.ts`:
```typescript
// Redmine Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";

// =============================================================================
// Mock Server Helper
// =============================================================================

function startMockRedmine(
  handler: (req: Request) => Response | Promise<Response>,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

function installFetchMock(realHost: string, mockUrl: string): () => void {
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

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", async () => {
  const { model } = await import("./redmine.ts");
  assertEquals(model.type, "@webframp/redmine");
});

Deno.test("model version matches CalVer pattern", async () => {
  const { model } = await import("./redmine.ts");
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments has host, apiKey, and project", async () => {
  const { model } = await import("./redmine.ts");
  const parsed = model.globalArguments.parse({
    host: "https://redmine.example.org",
    apiKey: "abc123",
    project: "my-project",
  });
  assertEquals(parsed.host, "https://redmine.example.org");
  assertEquals(parsed.apiKey, "abc123");
  assertEquals(parsed.project, "my-project");
});

Deno.test("model defines expected resources", async () => {
  const { model } = await import("./redmine.ts");
  assertEquals("issues" in model.resources, true);
  assertEquals("issue_detail" in model.resources, true);
  assertEquals("projects" in model.resources, true);
  assertEquals("statuses" in model.resources, true);
  assertEquals("trackers" in model.resources, true);
  assertEquals("users" in model.resources, true);
  assertEquals("custom_fields" in model.resources, true);
});

Deno.test("model defines expected methods", async () => {
  const { model } = await import("./redmine.ts");
  const methodNames = Object.keys(model.methods);
  for (const name of [
    "list_issues",
    "get_issue",
    "create_issue",
    "update_issue",
    "list_projects",
    "list_statuses",
    "list_trackers",
    "list_users",
    "list_custom_fields",
  ]) {
    assertEquals(methodNames.includes(name), true, `Missing method: ${name}`);
  }
});

// =============================================================================
// list_statuses Tests
// =============================================================================

Deno.test({
  name: "list_statuses returns statuses and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((_req) => {
      return Response.json({
        issue_statuses: [
          { id: 1, name: "New", is_closed: false },
          { id: 2, name: "In Progress", is_closed: false },
          { id: 5, name: "Closed", is_closed: true },
        ],
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_statuses.execute(
        {},
        context as unknown as Parameters<typeof model.methods.list_statuses.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "statuses");
      const data = resources[0].data as { statuses: Array<{ id: number; name: string; isClosed: boolean }> };
      assertEquals(data.statuses.length, 3);
      assertEquals(data.statuses[0].name, "New");
      assertEquals(data.statuses[2].isClosed, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// list_trackers Tests
// =============================================================================

Deno.test({
  name: "list_trackers returns trackers and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((_req) => {
      return Response.json({
        trackers: [
          { id: 1, name: "Story", default_status: { id: 1, name: "New" }, description: null },
          { id: 2, name: "Task", default_status: { id: 1, name: "New" }, description: "Individual work item" },
        ],
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_trackers.execute(
        {},
        context as unknown as Parameters<typeof model.methods.list_trackers.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "trackers");
      const data = resources[0].data as { trackers: Array<{ id: number; name: string }> };
      assertEquals(data.trackers.length, 2);
      assertEquals(data.trackers[0].name, "Story");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// list_projects Tests
// =============================================================================

Deno.test({
  name: "list_projects returns projects and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((_req) => {
      return Response.json({
        projects: [
          { id: 1, name: "App Services", identifier: "appsvc", description: "Main project", status: 1, is_public: false, created_on: "2025-01-01T00:00:00Z", updated_on: "2026-04-14T00:00:00Z" },
        ],
        total_count: 1,
        offset: 0,
        limit: 25,
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_projects.execute(
        {},
        context as unknown as Parameters<typeof model.methods.list_projects.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "projects");
      const data = resources[0].data as { projects: Array<{ identifier: string }> };
      assertEquals(data.projects[0].identifier, "appsvc");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// list_users Tests
// =============================================================================

Deno.test({
  name: "list_users returns project members and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((req) => {
      const reqUrl = new URL(req.url);
      // Verify it hits memberships endpoint
      if (reqUrl.pathname.includes("/memberships.json")) {
        return Response.json({
          memberships: [
            { id: 1, project: { id: 1, name: "Test" }, user: { id: 10, name: "Alice" }, roles: [{ id: 3, name: "Developer" }] },
            { id: 2, project: { id: 1, name: "Test" }, group: { id: 20, name: "Devs" }, roles: [{ id: 3, name: "Developer" }] },
          ],
          total_count: 2,
          offset: 0,
          limit: 25,
        });
      }
      return Response.json({ error: "unexpected path" }, { status: 404 });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_users.execute(
        { project: undefined },
        context as unknown as Parameters<typeof model.methods.list_users.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "users");
      const data = resources[0].data as { members: Array<{ name: string; type: string }> };
      assertEquals(data.members.length, 2);
      assertEquals(data.members[0].name, "Alice");
      assertEquals(data.members[0].type, "user");
      assertEquals(data.members[1].type, "group");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// list_custom_fields Tests
// =============================================================================

Deno.test({
  name: "list_custom_fields returns fields and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((_req) => {
      return Response.json({
        custom_fields: [
          {
            id: 1,
            name: "Category",
            customized_type: "issue",
            field_format: "list",
            is_required: true,
            is_filter: true,
            multiple: false,
            possible_values: [{ value: "BAU" }, { value: "Project" }],
            trackers: [{ id: 1, name: "Story" }],
          },
        ],
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_custom_fields.execute(
        {},
        context as unknown as Parameters<typeof model.methods.list_custom_fields.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "custom_fields");
      const data = resources[0].data as {
        customFields: Array<{ id: number; name: string; fieldFormat: string; possibleValues: Array<{ value: string }> }>;
      };
      assertEquals(data.customFields.length, 1);
      assertEquals(data.customFields[0].name, "Category");
      assertEquals(data.customFields[0].fieldFormat, "list");
      assertEquals(data.customFields[0].possibleValues.length, 2);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
```

**Step 2: Run tests to verify they fail**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/redmine_test.ts
```
Expected: FAIL — `redmine.ts` does not exist yet.

**Step 3: Write the model definition**

Create `redmine/extensions/models/redmine/redmine.ts`. This is a large file — implement it in stages. Start with global args, all resource schemas, and the five lookup methods. Leave `list_issues`, `get_issue`, `create_issue`, and `update_issue` as stubs that throw "not implemented" — they'll be filled in Tasks 4 and 5.

```typescript
// Redmine Issue Tracker Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { redmineApi, redmineApiPaginated } from "./_lib/api.ts";

// =============================================================================
// Global Arguments
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().describe("Redmine instance URL (e.g., https://redmine.example.org)"),
  apiKey: z.string().meta({ sensitive: true }).describe("Redmine API key (40-char hex)"),
  project: z.string().describe("Default project identifier"),
});

// =============================================================================
// Resource Schemas
// =============================================================================

const IdNameSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const IssueSchema = z.object({
  id: z.number(),
  project: IdNameSchema,
  tracker: IdNameSchema,
  status: z.object({ id: z.number(), name: z.string(), isClosed: z.boolean() }),
  priority: IdNameSchema,
  author: IdNameSchema,
  assignedTo: IdNameSchema.nullable(),
  category: IdNameSchema.nullable(),
  subject: z.string(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  doneRatio: z.number(),
  createdOn: z.string(),
  updatedOn: z.string(),
  closedOn: z.string().nullable(),
  customFields: z.array(z.object({
    id: z.number(),
    name: z.string(),
    value: z.union([z.string(), z.array(z.string())]).nullable(),
  })),
});

const IssueDetailSchema = IssueSchema.extend({
  journals: z.array(z.object({
    id: z.number(),
    user: IdNameSchema,
    notes: z.string().nullable(),
    createdOn: z.string(),
    details: z.array(z.object({
      property: z.string(),
      name: z.string(),
      oldValue: z.string().nullable(),
      newValue: z.string().nullable(),
    })),
  })),
  children: z.array(z.object({
    id: z.number(),
    tracker: IdNameSchema,
    subject: z.string(),
  })),
});

const IssuesResourceSchema = z.object({
  issues: z.array(IssueSchema),
  totalCount: z.number(),
  filters: z.record(z.string(), z.unknown()),
  fetchedAt: z.string(),
});

const IssueDetailResourceSchema = z.object({
  issue: IssueDetailSchema,
  fetchedAt: z.string(),
});

const ProjectsResourceSchema = z.object({
  projects: z.array(z.object({
    id: z.number(),
    name: z.string(),
    identifier: z.string(),
    description: z.string().nullable(),
    status: z.number(),
    isPublic: z.boolean(),
    createdOn: z.string(),
    updatedOn: z.string(),
  })),
  fetchedAt: z.string(),
});

const StatusesResourceSchema = z.object({
  statuses: z.array(z.object({
    id: z.number(),
    name: z.string(),
    isClosed: z.boolean(),
  })),
  fetchedAt: z.string(),
});

const TrackersResourceSchema = z.object({
  trackers: z.array(z.object({
    id: z.number(),
    name: z.string(),
    defaultStatus: IdNameSchema.nullable(),
    description: z.string().nullable(),
  })),
  fetchedAt: z.string(),
});

const UsersResourceSchema = z.object({
  members: z.array(z.object({
    id: z.number(),
    name: z.string(),
    type: z.enum(["user", "group"]),
    roles: z.array(z.string()),
  })),
  project: z.string(),
  fetchedAt: z.string(),
});

const CustomFieldsResourceSchema = z.object({
  customFields: z.array(z.object({
    id: z.number(),
    name: z.string(),
    customizedType: z.string(),
    fieldFormat: z.string(),
    isRequired: z.boolean(),
    isFilter: z.boolean(),
    multiple: z.boolean(),
    defaultValue: z.string().nullable(),
    possibleValues: z.array(z.object({ value: z.string() })),
    trackers: z.array(IdNameSchema),
  })),
  fetchedAt: z.string(),
});

// =============================================================================
// Response Mapping Helpers
// =============================================================================

interface RawIssue {
  id: number;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string; is_closed?: boolean };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string } | null;
  category?: { id: number; name: string } | null;
  subject: string;
  description: string | null;
  start_date: string | null;
  due_date: string | null;
  done_ratio: number;
  created_on: string;
  updated_on: string;
  closed_on?: string | null;
  custom_fields?: Array<{ id: number; name: string; value: string | string[] | null }>;
  journals?: Array<{
    id: number;
    user: { id: number; name: string };
    notes: string | null;
    created_on: string;
    details: Array<{
      property: string;
      name: string;
      old_value: string | null;
      new_value: string | null;
    }>;
  }>;
  children?: Array<{
    id: number;
    tracker: { id: number; name: string };
    subject: string;
  }>;
}

function mapIssue(raw: RawIssue) {
  return {
    id: raw.id,
    project: raw.project,
    tracker: raw.tracker,
    status: {
      id: raw.status.id,
      name: raw.status.name,
      isClosed: raw.status.is_closed ?? false,
    },
    priority: raw.priority,
    author: raw.author,
    assignedTo: raw.assigned_to ?? null,
    category: raw.category ?? null,
    subject: raw.subject,
    description: raw.description,
    startDate: raw.start_date,
    dueDate: raw.due_date,
    doneRatio: raw.done_ratio,
    createdOn: raw.created_on,
    updatedOn: raw.updated_on,
    closedOn: raw.closed_on ?? null,
    customFields: (raw.custom_fields || []).map((cf) => ({
      id: cf.id,
      name: cf.name,
      value: cf.value ?? null,
    })),
  };
}

function mapIssueDetail(raw: RawIssue) {
  return {
    ...mapIssue(raw),
    journals: (raw.journals || []).map((j) => ({
      id: j.id,
      user: j.user,
      notes: j.notes,
      createdOn: j.created_on,
      details: (j.details || []).map((d) => ({
        property: d.property,
        name: d.name,
        oldValue: d.old_value,
        newValue: d.new_value,
      })),
    })),
    children: (raw.children || []).map((c) => ({
      id: c.id,
      tracker: c.tracker,
      subject: c.subject,
    })),
  };
}

// =============================================================================
// Model Export
// =============================================================================

export const model = {
  type: "@webframp/redmine",
  version: "2026.04.14.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    issues: {
      description: "List of Redmine issues matching query filters",
      schema: IssuesResourceSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    issue_detail: {
      description: "Single Redmine issue with journals and children",
      schema: IssueDetailResourceSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    projects: {
      description: "List of accessible Redmine projects",
      schema: ProjectsResourceSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    statuses: {
      description: "Available issue statuses",
      schema: StatusesResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    trackers: {
      description: "Available tracker types (Milestone, Theme, Story, Task, etc.)",
      schema: TrackersResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    users: {
      description: "Project members (users and groups)",
      schema: UsersResourceSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    custom_fields: {
      description: "Custom field definitions with possible values",
      schema: CustomFieldsResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
  },

  methods: {
    // --- Lookup Methods ---

    list_statuses: {
      description: "List all available issue statuses",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { host: string; apiKey: string; project: string };
          writeResource: (spec: string, name: string, data: unknown) => Promise<{ name: string; dataId: string; version: number }>;
          logger: { info: (msg: string, props: Record<string, unknown>) => void };
        },
      ) => {
        const { host, apiKey } = context.globalArgs;
        const raw = await redmineApi<{
          issue_statuses: Array<{ id: number; name: string; is_closed: boolean }>;
        }>(host, apiKey, "GET", "/issue_statuses.json");

        const data = {
          statuses: raw.issue_statuses.map((s) => ({
            id: s.id,
            name: s.name,
            isClosed: s.is_closed,
          })),
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("statuses", "all", data);
        context.logger.info("Fetched issue statuses", { count: data.statuses.length });
        return { dataHandles: [handle] };
      },
    },

    list_trackers: {
      description: "List all available tracker types",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { host: string; apiKey: string; project: string };
          writeResource: (spec: string, name: string, data: unknown) => Promise<{ name: string; dataId: string; version: number }>;
          logger: { info: (msg: string, props: Record<string, unknown>) => void };
        },
      ) => {
        const { host, apiKey } = context.globalArgs;
        const raw = await redmineApi<{
          trackers: Array<{
            id: number;
            name: string;
            default_status: { id: number; name: string } | null;
            description: string | null;
          }>;
        }>(host, apiKey, "GET", "/trackers.json");

        const data = {
          trackers: raw.trackers.map((t) => ({
            id: t.id,
            name: t.name,
            defaultStatus: t.default_status,
            description: t.description,
          })),
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("trackers", "all", data);
        context.logger.info("Fetched trackers", { count: data.trackers.length });
        return { dataHandles: [handle] };
      },
    },

    list_projects: {
      description: "List all accessible projects",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { host: string; apiKey: string; project: string };
          writeResource: (spec: string, name: string, data: unknown) => Promise<{ name: string; dataId: string; version: number }>;
          logger: { info: (msg: string, props: Record<string, unknown>) => void };
        },
      ) => {
        const { host, apiKey } = context.globalArgs;

        interface RawProject {
          id: number;
          name: string;
          identifier: string;
          description: string | null;
          status: number;
          is_public: boolean;
          created_on: string;
          updated_on: string;
        }

        const raw = await redmineApiPaginated<RawProject>(
          host,
          apiKey,
          "/projects.json",
          "projects",
        );

        const data = {
          projects: raw.map((p) => ({
            id: p.id,
            name: p.name,
            identifier: p.identifier,
            description: p.description,
            status: p.status,
            isPublic: p.is_public,
            createdOn: p.created_on,
            updatedOn: p.updated_on,
          })),
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("projects", "all", data);
        context.logger.info("Fetched projects", { count: data.projects.length });
        return { dataHandles: [handle] };
      },
    },

    list_users: {
      description: "List members of a project (users and groups with their roles)",
      arguments: z.object({
        project: z.string().optional().describe("Project identifier (overrides global default)"),
      }),
      execute: async (
        args: { project?: string },
        context: {
          globalArgs: { host: string; apiKey: string; project: string };
          writeResource: (spec: string, name: string, data: unknown) => Promise<{ name: string; dataId: string; version: number }>;
          logger: { info: (msg: string, props: Record<string, unknown>) => void };
        },
      ) => {
        const { host, apiKey } = context.globalArgs;
        const project = args.project || context.globalArgs.project;

        interface RawMembership {
          id: number;
          project: { id: number; name: string };
          user?: { id: number; name: string };
          group?: { id: number; name: string };
          roles: Array<{ id: number; name: string }>;
        }

        const raw = await redmineApiPaginated<RawMembership>(
          host,
          apiKey,
          `/projects/${encodeURIComponent(project)}/memberships.json`,
          "memberships",
        );

        const data = {
          members: raw.map((m) => ({
            id: m.user?.id ?? m.group?.id ?? 0,
            name: m.user?.name ?? m.group?.name ?? "Unknown",
            type: m.user ? "user" as const : "group" as const,
            roles: m.roles.map((r) => r.name),
          })),
          project,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("users", project, data);
        context.logger.info("Fetched project members", { project, count: data.members.length });
        return { dataHandles: [handle] };
      },
    },

    list_custom_fields: {
      description: "List all custom field definitions with possible values",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { host: string; apiKey: string; project: string };
          writeResource: (spec: string, name: string, data: unknown) => Promise<{ name: string; dataId: string; version: number }>;
          logger: { info: (msg: string, props: Record<string, unknown>) => void };
        },
      ) => {
        const { host, apiKey } = context.globalArgs;
        const raw = await redmineApi<{
          custom_fields: Array<{
            id: number;
            name: string;
            customized_type: string;
            field_format: string;
            is_required: boolean;
            is_filter: boolean;
            multiple: boolean;
            default_value: string | null;
            possible_values?: Array<{ value: string }>;
            trackers?: Array<{ id: number; name: string }>;
          }>;
        }>(host, apiKey, "GET", "/custom_fields.json");

        const data = {
          customFields: raw.custom_fields.map((cf) => ({
            id: cf.id,
            name: cf.name,
            customizedType: cf.customized_type,
            fieldFormat: cf.field_format,
            isRequired: cf.is_required,
            isFilter: cf.is_filter,
            multiple: cf.multiple,
            defaultValue: cf.default_value,
            possibleValues: cf.possible_values || [],
            trackers: cf.trackers || [],
          })),
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("custom_fields", "all", data);
        context.logger.info("Fetched custom fields", { count: data.customFields.length });
        return { dataHandles: [handle] };
      },
    },

    // --- Issue Methods (stubs for Task 4 & 5) ---

    list_issues: {
      description: "Query issues with filters, auto-paginate up to limit",
      arguments: z.object({
        tracker: z.string().optional().describe("Tracker name or ID"),
        status: z.string().optional().describe("Status name, ID, 'open', or 'closed'"),
        assignee: z.string().optional().describe("Assignee user ID or 'me'"),
        project: z.string().optional().describe("Project identifier (overrides global default)"),
        parentId: z.number().optional().describe("Parent issue ID"),
        sort: z.string().optional().describe("Sort field (e.g., 'updated_on:desc')"),
        limit: z.number().optional().describe("Max results (default 100, max 500)"),
      }),
      execute: async (
        _args: unknown,
        _context: unknown,
      ) => {
        throw new Error("Not implemented — see Task 4");
      },
    },

    get_issue: {
      description: "Get single issue with journals and children",
      arguments: z.object({
        issueId: z.number().describe("Issue ID"),
      }),
      execute: async (
        _args: unknown,
        _context: unknown,
      ) => {
        throw new Error("Not implemented — see Task 4");
      },
    },

    create_issue: {
      description: "Create a new issue with required fields",
      arguments: z.object({
        tracker: z.string().describe("Tracker name (e.g., Story, Task, Theme)"),
        subject: z.string().describe("Issue subject line"),
        description: z.string().optional().describe("Issue description (markdown)"),
        project: z.string().optional().describe("Project identifier (overrides global default)"),
        assigneeId: z.number().optional().describe("Assignee user ID"),
        statusId: z.number().optional().describe("Initial status ID"),
        priorityId: z.number().optional().describe("Priority ID"),
        parentId: z.number().optional().describe("Parent issue ID"),
        startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        customFields: z.array(z.object({
          id: z.number(),
          value: z.union([z.string(), z.array(z.string())]),
        })).optional().describe("Custom field values"),
      }),
      execute: async (
        _args: unknown,
        _context: unknown,
      ) => {
        throw new Error("Not implemented — see Task 5");
      },
    },

    update_issue: {
      description: "Update an existing issue (status, assignee, notes, etc.)",
      arguments: z.object({
        issueId: z.number().describe("Issue ID to update"),
        statusId: z.number().optional().describe("New status ID"),
        subject: z.string().optional().describe("Updated subject line"),
        description: z.string().optional().describe("Updated description"),
        assigneeId: z.number().optional().describe("New assignee user ID"),
        notes: z.string().optional().describe("Comment to add"),
        doneRatio: z.number().optional().describe("Percent done (0-100)"),
        dueDate: z.string().optional().describe("Updated due date (YYYY-MM-DD)"),
        customFields: z.array(z.object({
          id: z.number(),
          value: z.union([z.string(), z.array(z.string())]),
        })).optional().describe("Custom field values to update"),
      }),
      execute: async (
        _args: unknown,
        _context: unknown,
      ) => {
        throw new Error("Not implemented — see Task 5");
      },
    },
  },
};
```

**Step 4: Run tests to verify they pass**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/redmine_test.ts
```
Expected: All 10 tests PASS (structure tests + 5 lookup method tests). The stub methods aren't tested yet.

**Step 5: Run check, lint, fmt**

```bash
cd redmine && deno check extensions/models/redmine/*.ts extensions/models/redmine/_lib/*.ts
cd redmine && deno lint extensions/models/
cd redmine && deno fmt --check extensions/models/
```

**Step 6: Commit**

```bash
git add redmine/extensions/models/redmine/
git commit -m "feat(redmine): add model with global args, resources, and lookup methods"
```

---

### Task 4: Issue Query Methods — `list_issues` and `get_issue`

**Files:**
- Modify: `redmine/extensions/models/redmine/redmine.ts` (replace `list_issues` and `get_issue` stubs)
- Modify: `redmine/extensions/models/redmine/redmine_test.ts` (add tests)

**Step 1: Add tests for `list_issues` and `get_issue`**

Append to `redmine/extensions/models/redmine/redmine_test.ts`:
```typescript
// =============================================================================
// list_issues Tests
// =============================================================================

const mockIssue1 = {
  id: 100,
  project: { id: 1, name: "App Services" },
  tracker: { id: 3, name: "Story" },
  status: { id: 2, name: "In Progress", is_closed: false },
  priority: { id: 2, name: "Normal" },
  author: { id: 1, name: "Admin" },
  assigned_to: { id: 10, name: "Alice" },
  category: null,
  subject: "ADDS | LDAP | Implement Geographic Redundancy",
  description: "Background: ...",
  start_date: "2026-04-01",
  due_date: "2026-04-14",
  done_ratio: 50,
  created_on: "2026-04-01T08:00:00Z",
  updated_on: "2026-04-10T12:00:00Z",
  closed_on: null,
  custom_fields: [{ id: 1, name: "Category", value: "Project" }],
};

const mockIssue2 = {
  id: 101,
  project: { id: 1, name: "App Services" },
  tracker: { id: 4, name: "Task" },
  status: { id: 1, name: "New", is_closed: false },
  priority: { id: 2, name: "Normal" },
  author: { id: 10, name: "Alice" },
  assigned_to: null,
  category: null,
  subject: "Write unit tests for LDAP module",
  description: null,
  start_date: null,
  due_date: null,
  done_ratio: 0,
  created_on: "2026-04-10T08:00:00Z",
  updated_on: "2026-04-10T08:00:00Z",
  closed_on: null,
  custom_fields: [],
};

Deno.test({
  name: "list_issues returns filtered issues and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((req) => {
      const reqUrl = new URL(req.url);
      // Verify project_id filter is applied
      assertEquals(reqUrl.searchParams.get("project_id"), "test-proj");
      return Response.json({
        issues: [mockIssue1, mockIssue2],
        total_count: 2,
        offset: 0,
        limit: 25,
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_issues.execute(
        {
          tracker: undefined,
          status: undefined,
          assignee: undefined,
          project: undefined,
          parentId: undefined,
          sort: undefined,
          limit: undefined,
        },
        context as unknown as Parameters<typeof model.methods.list_issues.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "issues");
      const data = resources[0].data as {
        issues: Array<{ id: number; subject: string; assignedTo: { name: string } | null }>;
        totalCount: number;
      };
      assertEquals(data.totalCount, 2);
      assertEquals(data.issues.length, 2);
      assertEquals(data.issues[0].subject, "ADDS | LDAP | Implement Geographic Redundancy");
      assertEquals(data.issues[0].assignedTo?.name, "Alice");
      assertEquals(data.issues[1].assignedTo, null);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "list_issues applies tracker and status filters",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((req) => {
      const reqUrl = new URL(req.url);
      assertEquals(reqUrl.searchParams.get("tracker_id"), "Story");
      assertEquals(reqUrl.searchParams.get("status_id"), "open");
      return Response.json({
        issues: [mockIssue1],
        total_count: 1,
        offset: 0,
        limit: 25,
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.list_issues.execute(
        {
          tracker: "Story",
          status: "open",
          assignee: undefined,
          project: undefined,
          parentId: undefined,
          sort: undefined,
          limit: undefined,
        },
        context as unknown as Parameters<typeof model.methods.list_issues.execute>[1],
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// get_issue Tests
// =============================================================================

Deno.test({
  name: "get_issue returns issue detail with journals and children",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine((req) => {
      const reqUrl = new URL(req.url);
      assertEquals(reqUrl.searchParams.get("include"), "journals,children");
      return Response.json({
        issue: {
          ...mockIssue1,
          journals: [
            {
              id: 1,
              user: { id: 10, name: "Alice" },
              notes: "Started work on this",
              created_on: "2026-04-02T09:00:00Z",
              details: [
                { property: "attr", name: "status_id", old_value: "1", new_value: "2" },
              ],
            },
          ],
          children: [
            { id: 101, tracker: { id: 4, name: "Task" }, subject: "Write unit tests" },
          ],
        },
      });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.get_issue.execute(
        { issueId: 100 },
        context as unknown as Parameters<typeof model.methods.get_issue.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "issue_detail");
      assertEquals(resources[0].name, "100");
      const data = resources[0].data as {
        issue: {
          id: number;
          journals: Array<{ notes: string | null; details: Array<{ name: string }> }>;
          children: Array<{ id: number; subject: string }>;
        };
      };
      assertEquals(data.issue.id, 100);
      assertEquals(data.issue.journals.length, 1);
      assertEquals(data.issue.journals[0].notes, "Started work on this");
      assertEquals(data.issue.journals[0].details[0].name, "status_id");
      assertEquals(data.issue.children.length, 1);
      assertEquals(data.issue.children[0].subject, "Write unit tests");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
```

**Step 2: Run tests to verify the new ones fail**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/redmine_test.ts
```
Expected: New `list_issues` and `get_issue` tests FAIL with "Not implemented".

**Step 3: Implement `list_issues` and `get_issue`**

Replace the `list_issues` and `get_issue` stubs in `redmine/extensions/models/redmine/redmine.ts` with full implementations. The `list_issues` method should:

1. Build query params from args: `project_id` (from args.project or globalArgs.project), `tracker_id`, `status_id`, `assigned_to_id`, `parent_id`, `sort`
2. Call `redmineApiPaginated` with resultKey `"issues"` and the caller's limit (default 100)
3. Map each raw issue through `mapIssue()`
4. Write to the `issues` resource with instance name based on filters (e.g., `"open-stories"` or `"all"`)

The `get_issue` method should:

1. Call `redmineApi` with `GET /issues/{id}.json?include=journals,children`
2. Map through `mapIssueDetail()`
3. Write to the `issue_detail` resource with instance name = the issue ID as string

Refer to the `mapIssue()` and `mapIssueDetail()` helpers already defined in the model file.

**Step 4: Run tests to verify they pass**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/redmine_test.ts
```
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add redmine/extensions/models/redmine/
git commit -m "feat(redmine): implement list_issues and get_issue methods"
```

---

### Task 5: Issue Mutation Methods — `create_issue` and `update_issue`

**Files:**
- Modify: `redmine/extensions/models/redmine/redmine.ts` (replace `create_issue` and `update_issue` stubs)
- Modify: `redmine/extensions/models/redmine/redmine_test.ts` (add tests)

**Step 1: Add tests for `create_issue` and `update_issue`**

Append to `redmine/extensions/models/redmine/redmine_test.ts`:
```typescript
// =============================================================================
// create_issue Tests
// =============================================================================

Deno.test({
  name: "create_issue sends correct POST body and writes resource",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    const { url, server } = startMockRedmine(async (req) => {
      assertEquals(req.method, "POST");
      const body = await req.json();
      assertEquals(body.issue.subject, "ADDS | LDAP | Implement Redundancy");
      assertEquals(body.issue.tracker_id, "Story");
      assertEquals(body.issue.project_id, "test-proj");
      assertEquals(body.issue.parent_issue_id, 50);
      assertEquals(body.issue.custom_fields[0].id, 1);
      assertEquals(body.issue.custom_fields[0].value, "Project");
      return new Response(
        JSON.stringify({
          issue: {
            ...mockIssue1,
            id: 200,
            subject: "ADDS | LDAP | Implement Redundancy",
            journals: [],
            children: [],
          },
        }),
        { status: 201 },
      );
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.create_issue.execute(
        {
          tracker: "Story",
          subject: "ADDS | LDAP | Implement Redundancy",
          description: "Background: ...",
          project: undefined,
          assigneeId: undefined,
          statusId: undefined,
          priorityId: undefined,
          parentId: 50,
          startDate: undefined,
          dueDate: undefined,
          customFields: [{ id: 1, value: "Project" }],
        },
        context as unknown as Parameters<typeof model.methods.create_issue.execute>[1],
      );
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "issue_detail");
      assertEquals(resources[0].name, "200");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// =============================================================================
// update_issue Tests
// =============================================================================

Deno.test({
  name: "update_issue sends PUT and re-fetches issue detail",
  sanitizeResources: false,
  fn: async () => {
    const { model } = await import("./redmine.ts");
    const host = "https://mock-redmine.test";
    let putCalled = false;
    const { url, server } = startMockRedmine(async (req) => {
      const reqUrl = new URL(req.url);
      if (req.method === "PUT") {
        putCalled = true;
        const body = await req.json();
        assertEquals(body.issue.status_id, 3);
        assertEquals(body.issue.notes, "Moving to Ready");
        return new Response(null, { status: 204 });
      }
      // GET after PUT to re-fetch
      if (req.method === "GET" && reqUrl.pathname.includes("/issues/100")) {
        return Response.json({
          issue: {
            ...mockIssue1,
            status: { id: 3, name: "Ready", is_closed: false },
            journals: [],
            children: [],
          },
        });
      }
      return Response.json({}, { status: 404 });
    });
    const uninstall = installFetchMock(host, url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { host, apiKey: "test-key", project: "test-proj" },
      });
      await model.methods.update_issue.execute(
        {
          issueId: 100,
          statusId: 3,
          subject: undefined,
          description: undefined,
          assigneeId: undefined,
          notes: "Moving to Ready",
          doneRatio: undefined,
          dueDate: undefined,
          customFields: undefined,
        },
        context as unknown as Parameters<typeof model.methods.update_issue.execute>[1],
      );
      assertEquals(putCalled, true);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "issue_detail");
      const data = resources[0].data as { issue: { status: { name: string } } };
      assertEquals(data.issue.status.name, "Ready");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
```

**Step 2: Run tests to verify the new ones fail**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/redmine_test.ts
```
Expected: `create_issue` and `update_issue` tests FAIL with "Not implemented".

**Step 3: Implement `create_issue` and `update_issue`**

Replace the stubs in `redmine.ts`:

`create_issue` should:
1. Build the issue creation payload: `{ issue: { project_id, tracker_id, subject, description, assigned_to_id, status_id, priority_id, parent_issue_id, start_date, due_date, custom_fields } }`
2. Use the tracker name directly as `tracker_id` (Redmine accepts names for tracker_id)
3. POST to `/issues.json`
4. Map the returned issue through `mapIssueDetail()`
5. Write to `issue_detail` resource with the new issue ID as instance name

`update_issue` should:
1. Build the update payload with only non-undefined fields: `{ issue: { status_id, subject, description, assigned_to_id, notes, done_ratio, due_date, custom_fields } }`
2. PUT to `/issues/{issueId}.json`
3. Re-fetch the issue via GET `/issues/{issueId}.json?include=journals,children` to get updated state
4. Map through `mapIssueDetail()` and write to `issue_detail` resource

**Step 4: Run tests to verify they pass**

```bash
cd redmine && deno test --allow-env --allow-net extensions/models/redmine/redmine_test.ts
```
Expected: All tests PASS.

**Step 5: Run full check suite**

```bash
cd redmine && deno check extensions/models/redmine/*.ts extensions/models/redmine/_lib/*.ts
cd redmine && deno lint extensions/models/
cd redmine && deno fmt --check extensions/models/
```

**Step 6: Commit**

```bash
git add redmine/extensions/models/redmine/
git commit -m "feat(redmine): implement create_issue and update_issue methods"
```

---

### Task 6: Flow Metrics Report

Computes cycle time, lead time, throughput, and WIP age from issue journal history. Scoped to the Redmine model.

**Files:**
- Create: `redmine/extensions/reports/flow_metrics_report.ts`
- Create: `redmine/extensions/reports/flow_metrics_report_test.ts`

**Step 1: Write the report tests**

Create `redmine/extensions/reports/flow_metrics_report_test.ts`:
```typescript
// Flow Metrics Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./flow_metrics_report.ts";

// Helper: write mock data file to temp dir
async function writeMockData(
  tmpDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
  data: unknown,
): Promise<void> {
  const dir = `${tmpDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/raw`, JSON.stringify(data));
}

function createReportContext(
  tmpDir: string,
  stepExecutions: Array<{
    jobName: string;
    stepName: string;
    modelName: string;
    modelType: string;
    modelId: string;
    methodName: string;
    status: string;
    dataHandles: Array<{ name: string; dataId: string; version: number }>;
  }>,
) {
  return {
    workflowId: "test-wf",
    workflowRunId: "test-run",
    workflowName: "flow-metrics",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: { info: (_msg: string, _props: Record<string, unknown>) => {} },
  };
}

Deno.test("report has correct name and scope", () => {
  assertEquals(report.name, "@webframp/flow-metrics-report");
  assertEquals(report.scope, "workflow");
});

Deno.test({
  name: "report computes cycle time from journal status transitions",
  sanitizeResources: false,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      // Issue with journals showing status transitions:
      // New (Apr 1) -> In Progress (Apr 3) -> Review (Apr 8) -> Closed (Apr 10)
      const issueData = {
        issues: [
          {
            id: 100,
            subject: "Test story",
            tracker: { id: 3, name: "Story" },
            status: { id: 5, name: "Closed", isClosed: true },
            createdOn: "2026-04-01T08:00:00Z",
            closedOn: "2026-04-10T08:00:00Z",
            customFields: [],
          },
        ],
        totalCount: 1,
        filters: {},
        fetchedAt: "2026-04-14T00:00:00Z",
      };

      const detailData = {
        issue: {
          id: 100,
          subject: "Test story",
          tracker: { id: 3, name: "Story" },
          status: { id: 5, name: "Closed", isClosed: true },
          createdOn: "2026-04-01T08:00:00Z",
          closedOn: "2026-04-10T08:00:00Z",
          customFields: [],
          journals: [
            {
              id: 1,
              user: { id: 1, name: "Admin" },
              notes: null,
              createdOn: "2026-04-03T08:00:00Z",
              details: [
                { property: "attr", name: "status_id", oldValue: "1", newValue: "4" },
              ],
            },
            {
              id: 2,
              user: { id: 1, name: "Admin" },
              notes: null,
              createdOn: "2026-04-08T08:00:00Z",
              details: [
                { property: "attr", name: "status_id", oldValue: "4", newValue: "6" },
              ],
            },
            {
              id: 3,
              user: { id: 1, name: "Admin" },
              notes: null,
              createdOn: "2026-04-10T08:00:00Z",
              details: [
                { property: "attr", name: "status_id", oldValue: "6", newValue: "5" },
              ],
            },
          ],
          children: [],
        },
        fetchedAt: "2026-04-14T00:00:00Z",
      };

      await writeMockData(tmpDir, "redmine", "tracker", "issues-all", 1, issueData);
      await writeMockData(tmpDir, "redmine", "tracker", "issue-100", 1, detailData);

      const context = createReportContext(tmpDir, [
        {
          jobName: "gather",
          stepName: "list-issues",
          modelName: "tracker",
          modelType: "redmine",
          modelId: "tracker",
          methodName: "list_issues",
          status: "completed",
          dataHandles: [{ name: "issues-all", dataId: "d1", version: 1 }],
        },
        {
          jobName: "gather",
          stepName: "get-issue-100",
          modelName: "tracker",
          modelType: "redmine",
          modelId: "tracker",
          methodName: "get_issue",
          status: "completed",
          dataHandles: [{ name: "issue-100", dataId: "d2", version: 1 }],
        },
      ]);

      const result = await report.execute(context);
      assertEquals(typeof result.markdown, "string");
      assertEquals(result.markdown.includes("Flow Metrics"), true);
      // Lead time: Apr 1 to Apr 10 = 9 days
      assertEquals(result.markdown.includes("9"), true);
      // Cycle time: Apr 3 (In Progress) to Apr 10 (Closed) = 7 days
      assertEquals(result.markdown.includes("7"), true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report handles no data gracefully",
  sanitizeResources: false,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = createReportContext(tmpDir, []);
      const result = await report.execute(context);
      assertEquals(typeof result.markdown, "string");
      assertEquals(result.markdown.includes("No issue data"), true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
```

**Step 2: Run tests to verify they fail**

```bash
cd redmine && deno test --allow-env --allow-net --allow-read --allow-write extensions/reports/flow_metrics_report_test.ts
```
Expected: FAIL — file does not exist yet.

**Step 3: Implement the flow metrics report**

Create `redmine/extensions/reports/flow_metrics_report.ts`. The report should:

1. Find issue list data from step executions (model `"tracker"`, method `"list_issues"`)
2. Find issue detail data for each closed issue (to access journals)
3. Compute for each closed issue:
   - **Lead time**: `closedOn - createdOn` in days
   - **Cycle time**: time from first "In Progress"-like status transition to `closedOn` in days (scan journals for `status_id` changes)
4. Compute aggregates:
   - **Avg/median/p90 lead time** across all closed issues
   - **Avg/median/p90 cycle time** across all closed issues
   - **Throughput**: count of closed issues per week
5. For open issues in "In Progress" state:
   - **WIP age**: `now - date of transition to In Progress` in days
6. Output markdown with tables and a JSON summary

Follow the pattern from `aws/ops/extensions/reports/incident_report.ts` for data access (use `findStepData` + `getData` helpers reading from `{repoDir}/.swamp/data/{modelType}/{modelId}/{dataName}/{version}/raw`).

**Step 4: Run tests to verify they pass**

```bash
cd redmine && deno test --allow-env --allow-net --allow-read --allow-write extensions/reports/flow_metrics_report_test.ts
```
Expected: All tests PASS.

**Step 5: Run check, lint, fmt**

```bash
cd redmine && deno check extensions/reports/flow_metrics_report.ts
cd redmine && deno lint extensions/reports/
cd redmine && deno fmt --check extensions/reports/
```

**Step 6: Commit**

```bash
git add redmine/extensions/reports/
git commit -m "feat(redmine): add flow metrics report (cycle time, lead time, throughput, WIP age)"
```

---

### Task 7: Sprint Summary Report

Summarizes current sprint status — work by state, tracker, assignee; blocked items; recently completed.

**Files:**
- Create: `redmine/extensions/reports/sprint_summary_report.ts`
- Create: `redmine/extensions/reports/sprint_summary_report_test.ts`

**Step 1: Write the report tests**

Create `redmine/extensions/reports/sprint_summary_report_test.ts`:
```typescript
// Sprint Summary Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1";
import { report } from "./sprint_summary_report.ts";

async function writeMockData(
  tmpDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
  data: unknown,
): Promise<void> {
  const dir = `${tmpDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/raw`, JSON.stringify(data));
}

function createReportContext(
  tmpDir: string,
  stepExecutions: Array<{
    jobName: string;
    stepName: string;
    modelName: string;
    modelType: string;
    modelId: string;
    methodName: string;
    status: string;
    dataHandles: Array<{ name: string; dataId: string; version: number }>;
  }>,
) {
  return {
    workflowId: "test-wf",
    workflowRunId: "test-run",
    workflowName: "sprint-summary",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: { info: (_msg: string, _props: Record<string, unknown>) => {} },
  };
}

Deno.test("report has correct name and scope", () => {
  assertEquals(report.name, "@webframp/sprint-summary-report");
  assertEquals(report.scope, "workflow");
});

Deno.test({
  name: "report summarizes issues by status, tracker, and assignee",
  sanitizeResources: false,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const issueData = {
        issues: [
          {
            id: 1, subject: "Story A", tracker: { id: 3, name: "Story" },
            status: { id: 4, name: "In Progress", isClosed: false },
            assignedTo: { id: 10, name: "Alice" },
            createdOn: "2026-04-01T00:00:00Z", closedOn: null, customFields: [],
          },
          {
            id: 2, subject: "[blocked] Story B", tracker: { id: 3, name: "Story" },
            status: { id: 4, name: "In Progress", isClosed: false },
            assignedTo: { id: 11, name: "Bob" },
            createdOn: "2026-04-02T00:00:00Z", closedOn: null, customFields: [],
          },
          {
            id: 3, subject: "Task C", tracker: { id: 4, name: "Task" },
            status: { id: 5, name: "Closed", isClosed: true },
            assignedTo: { id: 10, name: "Alice" },
            createdOn: "2026-04-01T00:00:00Z", closedOn: "2026-04-05T00:00:00Z", customFields: [],
          },
          {
            id: 4, subject: "Task D", tracker: { id: 4, name: "Task" },
            status: { id: 1, name: "New", isClosed: false },
            assignedTo: null,
            createdOn: "2026-04-10T00:00:00Z", closedOn: null, customFields: [],
          },
        ],
        totalCount: 4,
        filters: {},
        fetchedAt: "2026-04-14T00:00:00Z",
      };

      await writeMockData(tmpDir, "redmine", "tracker", "issues-sprint", 1, issueData);

      const context = createReportContext(tmpDir, [
        {
          jobName: "gather",
          stepName: "list-sprint-issues",
          modelName: "tracker",
          modelType: "redmine",
          modelId: "tracker",
          methodName: "list_issues",
          status: "completed",
          dataHandles: [{ name: "issues-sprint", dataId: "d1", version: 1 }],
        },
      ]);

      const result = await report.execute(context);

      // Verify markdown content
      assertEquals(result.markdown.includes("Sprint Summary"), true);
      assertEquals(result.markdown.includes("Alice"), true);
      assertEquals(result.markdown.includes("Bob"), true);

      // Verify JSON summary
      const json = result.json as {
        byStatus: Record<string, number>;
        byTracker: Record<string, number>;
        blocked: number;
        completed: number;
        total: number;
      };
      assertEquals(json.total, 4);
      assertEquals(json.completed, 1);
      assertEquals(json.blocked, 1);
      assertEquals(json.byTracker["Story"], 2);
      assertEquals(json.byTracker["Task"], 2);
      assertEquals(json.byStatus["In Progress"], 2);
      assertEquals(json.byStatus["Closed"], 1);
      assertEquals(json.byStatus["New"], 1);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "report handles no data gracefully",
  sanitizeResources: false,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    try {
      const context = createReportContext(tmpDir, []);
      const result = await report.execute(context);
      assertEquals(result.markdown.includes("No issue data"), true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
```

**Step 2: Run tests to verify they fail**

```bash
cd redmine && deno test --allow-env --allow-net --allow-read --allow-write extensions/reports/sprint_summary_report_test.ts
```
Expected: FAIL — file does not exist yet.

**Step 3: Implement the sprint summary report**

Create `redmine/extensions/reports/sprint_summary_report.ts`. The report should:

1. Find issue list data from step executions
2. Compute:
   - **By status**: count of issues per status name
   - **By tracker**: count per tracker name
   - **By assignee**: count per assignee, with in-progress and completed breakdown
   - **Blocked**: count of issues whose subject starts with `[blocked]`
   - **Completed**: count of issues with `isClosed: true`
   - **Unassigned**: count of issues with null assignee
3. Output markdown with:
   - Status breakdown table
   - Tracker breakdown table
   - Assignee workload table
   - Blocked items list (subject + assignee)
   - Recently completed items list
4. Return `{ markdown, json }` — JSON includes the raw counts for downstream use

**Step 4: Run tests to verify they pass**

```bash
cd redmine && deno test --allow-env --allow-net --allow-read --allow-write extensions/reports/sprint_summary_report_test.ts
```
Expected: All tests PASS.

**Step 5: Run check, lint, fmt**

```bash
cd redmine && deno check extensions/reports/sprint_summary_report.ts
cd redmine && deno lint extensions/reports/
cd redmine && deno fmt --check extensions/reports/
```

**Step 6: Commit**

```bash
git add redmine/extensions/reports/
git commit -m "feat(redmine): add sprint summary report"
```

---

### Task 8: Add CI Test Matrix Entry

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add redmine to the CI matrix**

Add a new job block to `.github/workflows/ci.yml` for the redmine extension. Follow the pattern used by `model-check` and individual test jobs. The redmine extension has both models and reports, so it needs:

1. A `redmine-check` job with matrix `[check, lint, fmt]`:
   - `check`: `deno check extensions/models/redmine/*.ts extensions/models/redmine/_lib/*.ts extensions/reports/*.ts`
   - `lint`: `deno lint extensions/models/ extensions/reports/`
   - `fmt`: `deno fmt --check extensions/models/ extensions/reports/`
   - Working directory: `redmine`

2. A `redmine-test` job:
   - `deno test --allow-env --allow-net --allow-read --allow-write extensions/models/ extensions/reports/`
   - Working directory: `redmine`

**Step 2: Run the CI checks locally**

```bash
cd redmine && deno task check && deno task lint && deno task fmt:check && deno task test
```
Expected: All pass.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add redmine extension to test matrix"
```

---

### Task 9: Scaffold-Story Workflow

Creates a story in Redmine and then creates N child tasks from a description. This is a YAML workflow that orchestrates the Redmine model methods.

**Files:**
- Create: `redmine/workflows/` directory
- Create workflow YAML via `swamp workflow create` (or manually)

**Step 1: Create the workflow YAML**

The workflow should be created at `redmine/workflows/scaffold-story.yaml` (the exact filename will include a UUID if created via `swamp workflow create`). If creating manually, use this structure:

```yaml
id: <generate-a-uuid>
name: "@webframp/scaffold-story"
description: |
  Create a Redmine story with child tasks from a brief description.
  Creates the parent story, then creates each task as a child issue.
tags:
  redmine: "true"
  workflow: "true"
  story: "true"
reports:
  require: []
inputs:
  properties:
    subject:
      type: string
      description: "Story subject (Technology | Service | Objective format)"
    description:
      type: string
      default: ""
      description: "Story description using the story template"
    tracker:
      type: string
      default: "Story"
      description: "Tracker name for the parent issue"
    tasks:
      type: array
      items:
        type: object
        properties:
          subject:
            type: string
          description:
            type: string
      default: []
      description: "List of child tasks to create (each with subject and description)"
  required:
    - subject
jobs:
  - name: create-story
    description: Create the parent story issue
    steps:
      - name: create-parent
        description: Create the story in Redmine
        task:
          type: model_method
          modelIdOrName: tracker
          methodName: create_issue
          inputs:
            tracker: ${{ inputs.tracker }}
            subject: ${{ inputs.subject }}
            description: ${{ inputs.description }}

  - name: create-tasks
    description: Create child tasks under the story
    dependsOn:
      - job: create-story
        condition:
          type: completed
    steps:
      - name: create-child-tasks
        description: Create each task as a child of the story
        task:
          type: model_method
          modelIdOrName: tracker
          methodName: create_issue
          inputs:
            tracker: Task
            subject: ${{ inputs.tasks[0].subject }}
            description: ${{ inputs.tasks[0].description }}
        allowFailure: true

version: 1
```

**Note:** Swamp workflows may not support array iteration natively. If so, the workflow creates the parent story only, and the user (or a skill) handles task creation by calling `create_issue` with the `parentId` from the story. Adjust the workflow accordingly — the important thing is the parent story creation via workflow, with the `scaffold-story` skill handling the task loop if needed.

**Step 2: Update manifest to include the workflow**

Add the workflow path to `redmine/manifest.yaml`:
```yaml
workflows:
  - scaffold-story.yaml
```
(Adjust filename to match the actual file created.)

**Step 3: Verify the workflow is valid**

```bash
cd redmine && swamp extension fmt manifest.yaml --check
```

**Step 4: Commit**

```bash
git add redmine/workflows/ redmine/manifest.yaml
git commit -m "feat(redmine): add scaffold-story workflow"
```

---

### Task 10: Update README and Final Cleanup

**Files:**
- Modify: `README.md` (add redmine to the extension list)
- Verify: All checks pass across the entire repo

**Step 1: Add redmine to the README**

Add an entry for the redmine extension in the root `README.md` extension table, following the existing format. It belongs alongside the other extensions with its description and labels.

**Step 2: Run the full CI suite locally**

```bash
cd redmine && deno task check && deno task lint && deno task fmt:check && deno task test
```

**Step 3: Verify manifest**

```bash
cd redmine && swamp extension fmt manifest.yaml --check
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add redmine extension to README"
```

---

## Skills (Not Part of This Plan)

The four skills (`create-story`, `create-task`, `design-session-checklist`, `hypothesis-task`) are Claude Code skills, not swamp extensions. They should be created separately as skill files that provide template guidance and invoke the Redmine model methods. They do not need tests, CI, or manifest entries — they live in the skills system.

After completing this plan and validating the model + reports + workflow work against a live Redmine instance, create the skills as a follow-up task.
