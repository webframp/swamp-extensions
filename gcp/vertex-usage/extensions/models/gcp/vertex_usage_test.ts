// GCP Vertex Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./vertex_usage.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

/** Fake service account JSON for tests. */
const FAKE_SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key123",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKCmHKV+dPlsrQ\np9REs67a+DxFUW3go0EdgWHbxQ7koEQix9C18lGF8a+D66u6J9Tlw17V5JIXN7tr\nZNwu8xnFxLjFKeccBFIsj1yXBf/FTTzrZYYkl0Nxg2YStQ5npZGBLxRl99MakxlG\nO11I0PHFu5jpjagxkw7WUlH0EVpa3/iylhPql7tX6oFPrXJucKO2DajdwYPeoQzN\nPEBHf5KmPw+R+Ng+GUe63PhyN2AkXyCe1da2MGjRHqlB5DMwmJIECZmkW9akfQ6p\n9B1XD6QWpXFmakJpRO2Q5sCRiXiaB4d/MDpIwHv9He73j5iQUIs58GCB5qJ1MYVg\nfZ3kdWibAgMBAAECggEAICKU7uyarMTfXwmv+voYtS5SKR+sWimik+aozHOkN0ar\nH7G9Z2XH2VtEHzeZrvhikJBJt2aYD/D8Mowuc0SU/v5CTzsneFl9l9B47x0eqItC\nRcSg7eql6QT3yWuag29zsbhDG9GA9mia1q9e2n6VU0MlLVIBLwVku5UIq5549cat\nFWUsPxK87m23H5/ZBoC3q90cQCnCABemY8NUANLQRU/5YiqXkTOJYiz8gXd3Cfv/\nm0yZ0F9n2amRYHhles6rbDityCYZCIJ3JOyIk7PnP69jFc/Ybtxp+OQBIZLG+n6I\ncGJsjhfQULYVbYVU02VNXAAY6CqPXFMdHCnQ+EHlTQKBgQDyuLzO7LseNxJ4Hdxy\nhb/+k96KPgSz3IAN0bia4+SuMSblwl9hAcWxsencgoCWqy2GiIey8lPvATQ8gz3P\nQJGEyUPGjDhS7jPa8oB81QCK22trBHZQi+tc0jI2aLt79/zM7o5wrgjWdj0+Fcy/\nVTxAlAc4fjsqRYsie6yzc9Y1PwKBgQDVF+o/pvWzZ0WOU0M0OCtqc5+RoKZuW1gl\n5PjJU93+Zqfi9nC3avIAov/0Azsk4Snu4eUlkiHAZ9gtKQd5R0+fTTbSKUNy+wbj\nfzxQ1iuYtAV4UdgF8/j5dimNDjJ09S2kI/QAJ1/qYLDWlOWk9qNZrMe6w88K7O6C\ngs1xBaIppQKBgQDfNRwMfo8lHigR5gQQHQeOqZUBND9G2AO6sZ4+ckyeE/1dVP45\nS1PuMVqKukheRlS7X1rLKSYeqNDMxTRWH16y6hM1x0UUnpF5S4D1SzwQde+2noff\nUozC81nRx0aCnm8QVmEPJjxiXKG9MnbzjQK3sGljflIScZmdwHX1IRVgKQKBgQDI\n63iqNaFbW9dAgA9QkFmXUJe29rOWQDhX2pIdOh+JfH91x4m113eA1C/jgpxkhI1G\nOOYXS7bZNNCmnBX46x0PBf3XoKKBKmFvZYuYaKfInoy9yuWVj1lE1X4OCsHWd0pm\nhqPM9VNBqZNzcAcrSIXyyq+z0GZKVeX5Vp2goIArJQKBgBMuw5f+cgF5YJJ8H8s7\nsKeeWN78e4E1D7ytpEHy3WFU8v5rsdmTjw1XVuN9jPK2zEjUvknUV4QBeWqWGvdR\nkwYga2oe2XeKFY/DMgdtqknnuVqL8v3hbIInihJK7kQcmpVgvR3t6bz1R28dVJX3\nh2U51ysu8FOk2obY2qa4gEJv\n-----END PRIVATE KEY-----\n",
  client_email: "test@test-project.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
});

type FetchHandler = (
  url: string | URL | Request,
  init?: RequestInit,
) => Response | Promise<Response>;

function createMockFetchFn(handler: FetchHandler): typeof fetch {
  return handler as typeof fetch;
}

/** Standard monitoring API response with time series data. */
function monitoringResponse(
  timeSeries: unknown[],
  nextPageToken?: string,
): Response {
  return new Response(
    JSON.stringify({ timeSeries, nextPageToken }),
    { status: 200 },
  );
}

/** Standard token exchange response. */
function tokenResponse(accessToken = "mock-access-token"): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
    { status: 200 },
  );
}

// =============================================================================
// Type aliases
// =============================================================================

type ScanContext = Parameters<typeof model.methods.scan_projects.execute>[1];
type UsageContext = Parameters<typeof model.methods.get_token_usage.execute>[1];

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/gcp/vertex-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model globalArguments requires projects array", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("model globalArguments accepts projects array", () => {
  const parsed = model.globalArguments.parse({ projects: ["my-project"] });
  assertEquals(parsed.projects, ["my-project"]);
});

Deno.test("model globalArguments accepts optional serviceAccountJson", () => {
  const parsed = model.globalArguments.parse({
    projects: ["p1"],
    serviceAccountJson: FAKE_SA_JSON,
  });
  assertEquals(parsed.serviceAccountJson, FAKE_SA_JSON);
});

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
  assertEquals("single_scan" in model.resources, true);
});

Deno.test("model defines expected methods", () => {
  assertEquals("scan_projects" in model.methods, true);
  assertEquals("get_token_usage" in model.methods, true);
});

// =============================================================================
// Argument Validation Tests
// =============================================================================

Deno.test("scan_projects rejects days=0", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({ days: 0 });
  assertEquals(result.success, false);
});

Deno.test("scan_projects accepts days=1", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({ days: 1 });
  assertEquals(result.success, true);
});

Deno.test("scan_projects rejects days=91", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({ days: 91 });
  assertEquals(result.success, false);
});

Deno.test("scan_projects defaults days to 30", () => {
  const schema = model.methods.scan_projects.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) assertEquals(result.data.days, 30);
});

Deno.test("get_token_usage requires project", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("get_token_usage rejects days=0", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({ project: "test", days: 0 });
  assertEquals(result.success, false);
});

Deno.test("get_token_usage accepts valid input", () => {
  const schema = model.methods.get_token_usage.arguments;
  const result = schema.safeParse({ project: "my-proj", days: 7 });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.project, "my-proj");
    assertEquals(result.data.days, 7);
  }
});

// =============================================================================
// Auth Tests
// =============================================================================

Deno.test("scan_projects fails without credentials", async () => {
  const originalEnv = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS");
  Deno.env.delete("GOOGLE_APPLICATION_CREDENTIALS");
  try {
    const { context } = createModelTestContext({
      globalArgs: { projects: ["test-project"] },
      definition: { id: "t", name: "v", version: 1, tags: {} },
    });

    await assertRejects(
      () =>
        model.methods.scan_projects.execute(
          { days: 7 },
          context as unknown as ScanContext,
        ),
      Error,
      "No serviceAccountJson provided",
    );
  } finally {
    if (originalEnv) {
      Deno.env.set("GOOGLE_APPLICATION_CREDENTIALS", originalEnv);
    }
  }
});

Deno.test("scan_projects fails on token exchange error", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const { context } = createModelTestContext({
    globalArgs: {
      projects: ["test-project"],
      serviceAccountJson: FAKE_SA_JSON,
    },
    definition: { id: "t", name: "v", version: 1, tags: {} },
  });

  await assertRejects(
    () =>
      model.methods.scan_projects.execute(
        { days: 7 },
        { ...context, fetchFn: mockFetch } as unknown as ScanContext,
      ),
    Error,
    "GCP token exchange failed",
  );
});

// =============================================================================
// Execute-level Tests: scan_projects
// =============================================================================

Deno.test("scan_projects returns token data for multiple projects", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return monitoringResponse([
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "gemini-1.5-pro" } },
          points: [{ value: { int64Value: "15000" } }],
        },
        {
          metric: { labels: { type: "output" } },
          resource: { labels: { model_user_id: "gemini-1.5-pro" } },
          points: [{ value: { int64Value: "8000" } }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      projects: ["project-a", "project-b"],
      serviceAccountJson: FAKE_SA_JSON,
    },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  const result = await model.methods.scan_projects.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "scan_results");

  const data = resources[0].data as {
    projects: Array<{
      project: string;
      totalTokens: number;
      models: Array<{ modelId: string; inputTokens: number }>;
    }>;
    totals: { totalTokens: number; inputTokens: number; outputTokens: number };
    truncated: boolean;
  };

  assertEquals(data.projects.length, 2);
  assertEquals(data.projects[0].models[0].modelId, "gemini-1.5-pro");
  assertEquals(data.totals.inputTokens, 30000); // 15000 * 2 projects
  assertEquals(data.totals.outputTokens, 16000); // 8000 * 2 projects
  assertEquals(data.totals.totalTokens, 46000);
  assertEquals(data.truncated, false);
});

Deno.test("scan_projects handles pagination", async () => {
  let fetchCount = 0;
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      fetchCount++;
      if (!u.includes("pageToken")) {
        return monitoringResponse(
          [
            {
              metric: { labels: { type: "input" } },
              resource: { labels: { model_user_id: "gemini-1.5-pro" } },
              points: [{ value: { int64Value: "1000" } }],
            },
          ],
          "page2",
        );
      }
      return monitoringResponse([
        {
          metric: { labels: { type: "output" } },
          resource: { labels: { model_user_id: "gemini-1.5-pro" } },
          points: [{ value: { int64Value: "500" } }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["my-project"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  await model.methods.scan_projects.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    projects: Array<{ totalTokens: number }>;
  };

  assertEquals(fetchCount, 2);
  assertEquals(data.projects[0].totalTokens, 1500);
});

Deno.test("scan_projects handles 'Cannot find metric' gracefully", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return new Response("Cannot find metric", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      projects: ["no-metrics-project"],
      serviceAccountJson: FAKE_SA_JSON,
    },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  const result = await model.methods.scan_projects.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  assertExists(result.dataHandles);
  const resources = getWrittenResources();
  const data = resources[0].data as {
    projects: Array<unknown>;
    totals: { totalTokens: number };
  };
  assertEquals(data.projects.length, 0);
  assertEquals(data.totals.totalTokens, 0);
});

Deno.test("scan_projects logs warning and continues on per-project error", async () => {
  let requestCount = 0;
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      requestCount++;
      if (u.includes("bad-project")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return monitoringResponse([
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "gemini-2.0" } },
          points: [{ value: { int64Value: "2000" } }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: {
        projects: ["good-project", "bad-project"],
        serviceAccountJson: FAKE_SA_JSON,
      },
      definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
    });

  await model.methods.scan_projects.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    projects: Array<{ project: string }>;
  };

  // good-project succeeds, bad-project is skipped
  assertEquals(data.projects.length, 1);
  assertEquals(data.projects[0].project, "good-project");
  assertEquals(requestCount, 2);

  const warns = getLogsByLevel("warning");
  assertEquals(warns.length, 1);
  // Logger receives (message, propsObject) — props is first element of args
  const warnProps = warns[0].args[0] as Record<string, unknown>;
  assertEquals(warnProps.project, "bad-project");
});

// =============================================================================
// Execute-level Tests: get_token_usage
// =============================================================================

Deno.test("get_token_usage returns data for single project", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return monitoringResponse([
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "claude-3.5-sonnet" } },
          points: [{ value: { int64Value: "10000" } }],
        },
        {
          metric: { labels: { type: "output" } },
          resource: { labels: { model_user_id: "claude-3.5-sonnet" } },
          points: [{ value: { int64Value: "5000" } }],
        },
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "gemini-1.5-pro" } },
          points: [{ value: { doubleValue: 3000.5 } }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["my-proj"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  const result = await model.methods.get_token_usage.execute(
    { project: "my-proj", days: 14 },
    { ...context, fetchFn: mockFetch } as unknown as UsageContext,
  );

  assertExists(result.dataHandles);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "single_scan");
  assertEquals(resources[0].name, "my-proj");

  const data = resources[0].data as {
    days: number;
    projects: Array<{
      models: Array<{ modelId: string; inputTokens: number }>;
    }>;
    totals: { inputTokens: number; outputTokens: number; totalTokens: number };
  };

  assertEquals(data.days, 14);
  assertEquals(data.totals.inputTokens, 13000.5); // 10000 + 3000.5
  assertEquals(data.projects[0].models.length, 2);
});

Deno.test("get_token_usage handles empty results", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return monitoringResponse([]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["empty-proj"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  await model.methods.get_token_usage.execute(
    { project: "empty-proj", days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as UsageContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    totals: { totalTokens: number };
    truncated: boolean;
  };
  assertEquals(data.totals.totalTokens, 0);
  assertEquals(data.truncated, false);
});

// =============================================================================
// Edge Cases
// =============================================================================

Deno.test("handles multiple data points per time series", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return monitoringResponse([
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "gemini-2.0" } },
          points: [
            { value: { int64Value: "1000" } },
            { value: { int64Value: "2000" } },
            { value: { int64Value: "3000" } },
          ],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["multi-point"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  await model.methods.get_token_usage.execute(
    { project: "multi-point", days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as UsageContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    totals: { inputTokens: number };
  };
  assertEquals(data.totals.inputTokens, 6000); // 1000 + 2000 + 3000
});

Deno.test("models are sorted by totalTokens descending", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return monitoringResponse([
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "small-model" } },
          points: [{ value: { int64Value: "100" } }],
        },
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "big-model" } },
          points: [{ value: { int64Value: "9999" } }],
        },
        {
          metric: { labels: { type: "input" } },
          resource: { labels: { model_user_id: "medium-model" } },
          points: [{ value: { int64Value: "500" } }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["sort-test"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  await model.methods.get_token_usage.execute(
    { project: "sort-test", days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as UsageContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    projects: Array<{ models: Array<{ modelId: string }> }>;
  };
  assertEquals(data.projects[0].models[0].modelId, "big-model");
  assertEquals(data.projects[0].models[1].modelId, "medium-model");
  assertEquals(data.projects[0].models[2].modelId, "small-model");
});

Deno.test("truncated is true when pagination limit is hit", async () => {
  // Simulate always returning a nextPageToken (will hit MAX_PAGES=50)
  let pages = 0;
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      pages++;
      return monitoringResponse(
        [
          {
            metric: { labels: { type: "input" } },
            resource: { labels: { model_user_id: "model" } },
            points: [{ value: { int64Value: "1" } }],
          },
        ],
        `page${pages + 1}`, // always return a next page
      );
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["paginated"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  await model.methods.scan_projects.execute(
    { days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as { truncated: boolean };
  assertEquals(data.truncated, true);
  assertEquals(pages, 50);
});

Deno.test("handles unknown direction labels", async () => {
  const mockFetch = createMockFetchFn((url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return tokenResponse();
    }
    if (u.includes("timeSeries")) {
      return monitoringResponse([
        {
          metric: { labels: { type: "cache_hit" } },
          resource: { labels: { model_user_id: "gemini-2.0" } },
          points: [{ value: { int64Value: "500" } }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { projects: ["unknown-dir"], serviceAccountJson: FAKE_SA_JSON },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });

  await model.methods.get_token_usage.execute(
    { project: "unknown-dir", days: 7 },
    { ...context, fetchFn: mockFetch } as unknown as UsageContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    projects: Array<{
      models: Array<{ inputTokens: number; outputTokens: number }>;
    }>;
  };
  // Unknown direction doesn't count as input or output
  assertEquals(data.projects[0].models[0].inputTokens, 0);
  assertEquals(data.projects[0].models[0].outputTokens, 0);
});
