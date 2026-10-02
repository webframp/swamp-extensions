// GCP Vertex Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
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

Deno.test("model globalArguments allows omitting projects (discovery)", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("model globalArguments accepts projects array", () => {
  const parsed = model.globalArguments.parse({ projects: ["my-project"] });
  assertEquals(parsed.projects, ["my-project"]);
});

Deno.test("model globalArguments rejects empty projects array", () => {
  const result = model.globalArguments.safeParse({ projects: [] });
  assertEquals(result.success, false);
});

Deno.test("model globalArguments rejects empty-string project id", () => {
  const result = model.globalArguments.safeParse({ projects: [""] });
  assertEquals(result.success, false);
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
  const originalToken = Deno.env.get("GCP_ACCESS_TOKEN");
  Deno.env.delete("GOOGLE_APPLICATION_CREDENTIALS");
  Deno.env.delete("GCP_ACCESS_TOKEN");
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
    if (originalToken !== undefined) {
      Deno.env.set("GCP_ACCESS_TOKEN", originalToken);
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
    {
      ...context,
      fetchFn: mockFetch,
      sleepFn: () => Promise.resolve(),
    } as unknown as ScanContext,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    projects: Array<{ project: string }>;
    truncated: boolean;
  };

  // good-project succeeds, bad-project is skipped after 1 try + 6 retries
  assertEquals(data.projects.length, 1);
  assertEquals(data.projects[0].project, "good-project");
  assertEquals(requestCount, 8);
  // A failed project means the scan is incomplete.
  assertEquals(data.truncated, true);

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

// =============================================================================
// v2: retry, credentials, discovery, daily usage, billing
// =============================================================================

type Ctx = Parameters<typeof model.methods.scan_usage.execute>[1];
type CtxArgs = Record<string, unknown>;

const noSleep = () => Promise.resolve();

function url(u: string | URL | Request): string {
  return typeof u === "string" ? u : u.toString();
}

function ctxFor(globalArgs: CtxArgs, fetchFn: typeof fetch) {
  const tc = createModelTestContext({
    globalArgs: { serviceAccountJson: FAKE_SA_JSON, ...globalArgs },
    definition: { id: "t", name: "vertex-usage", version: 1, tags: {} },
  });
  return {
    ...tc,
    ctx: { ...tc.context, fetchFn, sleepFn: noSleep } as unknown as Ctx,
  };
}

/** A daily-aligned Monitoring series for one model. */
function series(
  opts: {
    model: string;
    direction?: string;
    location?: string;
    publisher?: string;
    requestType?: string;
    points: Array<[string, string]>; // [day YYYY-MM-DD, value]
  },
) {
  return {
    metric: {
      labels: {
        ...(opts.direction ? { type: opts.direction } : {}),
        ...(opts.requestType ? { request_type: opts.requestType } : {}),
      },
    },
    resource: {
      labels: {
        model_user_id: opts.model,
        location: opts.location ?? "us-central1",
        publisher: opts.publisher ?? "google",
      },
    },
    points: opts.points.map(([day, v]) => ({
      interval: {
        startTime: `${day}T00:00:00Z`,
        endTime: `${day}T23:59:59Z`,
      },
      value: { int64Value: v },
    })),
  };
}

Deno.test("retries 429 then succeeds", async () => {
  let calls = 0;
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("timeSeries")) {
      calls++;
      return calls < 3
        ? new Response("slow down", { status: 429 })
        : monitoringResponse([]);
    }
    return new Response("nf", { status: 404 });
  });
  const { ctx } = ctxFor({ projects: ["p1"] }, f);
  await model.methods.get_token_usage.execute({ project: "p1", days: 1 }, ctx);
  // 3 calls for token_count (2x 429 + 1 ok)
  assertEquals(calls, 3);
});

Deno.test("GCP_ACCESS_TOKEN skips the token exchange", async () => {
  Deno.env.set("GCP_ACCESS_TOKEN", "env-token");
  const seen: string[] = [];
  try {
    const f = createMockFetchFn((u, init) => {
      const s = url(u);
      if (s.includes("oauth2.googleapis.com")) {
        throw new Error("token exchange must not be called");
      }
      seen.push(
        (init?.headers as Record<string, string>)?.Authorization ?? "",
      );
      return monitoringResponse([]);
    });
    const tc = createModelTestContext({
      globalArgs: { projects: ["p1"] },
      definition: { id: "t", name: "v", version: 1, tags: {} },
    });
    await model.methods.get_token_usage.execute(
      { project: "p1", days: 1 },
      { ...tc.context, fetchFn: f, sleepFn: noSleep } as unknown as Ctx,
    );
    assertEquals(seen[0], "Bearer env-token");
  } finally {
    Deno.env.delete("GCP_ACCESS_TOKEN");
  }
});

Deno.test("discover_projects searches ACTIVE projects and paginates", async () => {
  const queries: string[] = [];
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("cloudresourcemanager.googleapis.com/v3/projects:search")) {
      const parsed = new URL(s);
      queries.push(parsed.searchParams.get("query") ?? "");
      if (!parsed.searchParams.get("pageToken")) {
        return new Response(
          JSON.stringify({
            projects: [{
              projectId: "zeta",
              name: "projects/2",
              state: "ACTIVE",
              parent: "folders/9",
            }],
            nextPageToken: "t2",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          projects: [{
            projectId: "alpha",
            name: "projects/1",
            state: "ACTIVE",
          }],
        }),
        { status: 200 },
      );
    }
    return new Response("nf", { status: 404 });
  });
  const { ctx, getWrittenResources } = ctxFor({}, f);
  await model.methods.discover_projects.execute(
    { parents: ["folders/9", "organizations/1"] },
    ctx,
  );
  assertEquals(queries.length, 2);
  assertEquals(
    queries[0],
    "state:ACTIVE (parent:folders/9 OR parent:organizations/1)",
  );
  const r = getWrittenResources()[0];
  assertEquals(r.specName, "projects");
  const data = r.data as {
    count: number;
    projects: Array<{ projectId: string }>;
  };
  assertEquals(data.count, 2);
  assertEquals(data.projects.map((p) => p.projectId), ["alpha", "zeta"]);
});

Deno.test("discover_projects surfaces a permission error", async () => {
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    return new Response("denied", { status: 403 });
  });
  const { ctx } = ctxFor({}, f);
  await assertRejects(
    () => model.methods.discover_projects.execute({ parents: [] }, ctx),
    Error,
    "HTTP 403",
  );
});

Deno.test("scan_usage rejects parents with an explicit project list", async () => {
  const f = createMockFetchFn(() => tokenResponse());
  const { ctx } = ctxFor({ projects: ["p1"] }, f);
  await assertRejects(
    () =>
      model.methods.scan_usage.execute(
        {
          days: 7,
          parents: ["folders/1"],
          concurrency: 2,
          maxRequestsPerMinute: 120,
        },
        ctx,
      ),
    Error,
    "parents only applies to project discovery",
  );
});

Deno.test("scan_usage args validate parents format and bounds", () => {
  const schema = model.methods.scan_usage.arguments;
  assertEquals(schema.safeParse({ parents: ["projects/1"] }).success, false);
  assertEquals(schema.safeParse({ parents: ["folders/1"] }).success, true);
  assertEquals(
    schema.safeParse({ concurrency: 0, maxRequestsPerMinute: 120 }).success,
    false,
  );
  assertEquals(schema.safeParse({ days: 1.5 }).success, false);
});

Deno.test("scan_usage discovers projects and writes daily rows per project", async () => {
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("projects:search")) {
      return new Response(
        JSON.stringify({
          projects: [
            { projectId: "alpha", state: "ACTIVE" },
            { projectId: "idle", state: "ACTIVE" },
            { projectId: "broken", state: "ACTIVE" },
          ],
        }),
        { status: 200 },
      );
    }
    if (s.includes("projects/broken/")) {
      return new Response("forbidden", { status: 403 });
    }
    if (s.includes("projects/idle/")) return monitoringResponse([]);
    if (s.includes("token_count")) {
      return monitoringResponse([
        series({
          model: "gemini-2.5-pro",
          direction: "input",
          requestType: "shared",
          points: [["2026-09-28", "100"], ["2026-09-29", "50"]],
        }),
        series({
          model: "gemini-2.5-pro",
          direction: "output",
          requestType: "shared",
          points: [["2026-09-28", "10"]],
        }),
        series({
          model: "claude-sonnet-4",
          publisher: "anthropic",
          location: "us-east5",
          direction: "input",
          requestType: "dedicated",
          points: [["2026-09-28", "7"]],
        }),
      ]);
    }
    if (s.includes("model_invocation_count")) {
      return monitoringResponse([
        series({
          model: "gemini-2.5-pro",
          requestType: "shared",
          points: [["2026-09-28", "3"], ["2026-09-29", "2"]],
        }),
      ]);
    }
    return new Response("nf", { status: 404 });
  });
  const { ctx, getWrittenResources } = ctxFor({}, f);
  await model.methods.scan_usage.execute(
    { days: 7, parents: [], concurrency: 2, maxRequestsPerMinute: 120 },
    ctx,
  );

  const written = getWrittenResources();
  const names = written.map((w) => `${w.specName}/${w.name}`).sort();
  // idle (no data) and broken (error) get no usage instance, only status.
  assertEquals(names, ["scan_summary/current", "usage/usage-alpha"]);

  const usage = written.find((w) => w.specName === "usage")!.data as {
    rows: Array<
      {
        date: string;
        modelId: string;
        publisher: string;
        inputTokens: number;
        outputTokens: number;
        requests: number;
        requestType: string;
      }
    >;
    byModel: Array<{ modelId: string; totalTokens: number; requests: number }>;
    totals: { totalTokens: number; requests: number };
    requestsAvailable: boolean;
  };
  assertEquals(usage.requestsAvailable, true);
  const d28 = usage.rows.find((r) =>
    r.date === "2026-09-28" && r.modelId === "gemini-2.5-pro"
  )!;
  assertEquals(d28.inputTokens, 100);
  assertEquals(d28.outputTokens, 10);
  assertEquals(d28.requests, 3);
  assertEquals(d28.requestType, "shared");
  const claude = usage.rows.find((r) => r.modelId === "claude-sonnet-4")!;
  assertEquals(claude.publisher, "anthropic");
  assertEquals(usage.totals.totalTokens, 167);
  assertEquals(usage.totals.requests, 5);
  assertEquals(usage.byModel[0].modelId, "gemini-2.5-pro");
  assertEquals(usage.byModel[0].totalTokens, 160);

  const summary = written.find((w) => w.specName === "scan_summary")!.data as {
    discovered: boolean;
    complete: boolean;
    window: { days: number; start: string; end: string };
    projects: Array<{ project: string; status: string; error?: string }>;
  };
  assertEquals(summary.discovered, true);
  // A failed project must make the scan incomplete rather than look empty.
  assertEquals(summary.complete, false);
  const byProject = Object.fromEntries(
    summary.projects.map((p) => [p.project, p]),
  );
  assertEquals(byProject.alpha.status, "ok");
  assertEquals(byProject.idle.status, "no_data");
  assertEquals(byProject.broken.status, "error");
  assertMatch(byProject.broken.error ?? "", /HTTP 403/);
  assertEquals(summary.window.days, 7);
  assertMatch(summary.window.end, /T00:00:00\.000Z$/);
});

Deno.test("scan_usage window is complete UTC days aligned to midnight", async () => {
  const intervals: string[] = [];
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("token_count")) {
      const p = new URL(s).searchParams;
      intervals.push(
        `${p.get("interval.startTime")}|${p.get("interval.endTime")}|${
          p.get("aggregation.alignmentPeriod")
        }`,
      );
    }
    return monitoringResponse([]);
  });
  const { ctx } = ctxFor({ projects: ["p1"] }, f);
  await model.methods.scan_usage.execute(
    { days: 2, parents: [], concurrency: 1, maxRequestsPerMinute: 120 },
    ctx,
  );
  const [start, end, align] = intervals[0].split("|");
  assertMatch(start, /T00:00:00\.000Z$/);
  assertMatch(end, /T00:00:00\.000Z$/);
  assertEquals(Date.parse(end) - Date.parse(start), 2 * 86400_000);
  assertEquals(align, "86400s");
});

Deno.test("scan_usage throws when every project fails", async () => {
  const f = createMockFetchFn((u) => {
    if (url(u).includes("oauth2.googleapis.com/token")) return tokenResponse();
    return new Response("denied", { status: 403 });
  });
  const { ctx } = ctxFor({ projects: ["a", "b"] }, f);
  await assertRejects(
    () =>
      model.methods.scan_usage.execute(
        { days: 1, parents: [], concurrency: 2, maxRequestsPerMinute: 120 },
        ctx,
      ),
    Error,
    "Every project failed to scan (2)",
  );
});

Deno.test("scan_usage marks requestsAvailable false when the invocation metric fails", async () => {
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("model_invocation_count")) {
      return new Response("denied", { status: 403 });
    }
    return monitoringResponse([
      series({
        model: "m",
        direction: "input",
        points: [["2026-09-28", "5"]],
      }),
    ]);
  });
  const { ctx, getWrittenResources } = ctxFor({ projects: ["p1"] }, f);
  await model.methods.scan_usage.execute(
    { days: 7, parents: [], concurrency: 1, maxRequestsPerMinute: 120 },
    ctx,
  );
  const usage = getWrittenResources().find((w) => w.specName === "usage")!
    .data as { requestsAvailable: boolean; warnings: string[] };
  assertEquals(usage.requestsAvailable, false);
  assertEquals(usage.warnings.length, 1);
  // Missing request counts understate the summary, so it is not complete.
  const sum = getWrittenResources().find((w) => w.specName === "scan_summary")!
    .data as { complete: boolean };
  assertEquals(sum.complete, false);
});

// ---- Billing ---------------------------------------------------------------

const BILLING_TABLE = "bill-proj.billing.gcp_billing_export_v1_ABC";

function bqResponse(
  fields: string[],
  rows: Array<Array<string | null>>,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      jobComplete: true,
      jobReference: { projectId: "bill-proj", jobId: "job1", location: "US" },
      schema: { fields: fields.map((name) => ({ name })) },
      rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })),
      ...extra,
    }),
    { status: 200 },
  );
}

const COST_FIELDS = [
  "o_date",
  "o_project",
  "o_service",
  "o_sku",
  "o_location",
  "o_cost_type",
  "o_currency",
  "o_usage_unit",
  "o_usage_amount",
  "o_cost",
  "o_credits",
  "o_net",
];

Deno.test("globalArguments validates billingTable shape", () => {
  assertEquals(
    model.globalArguments.safeParse({ billingTable: "just-a-name" }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ billingTable: "x`; DROP" }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({
      billingTable: BILLING_TABLE,
      billingSchema: "standard",
    }).success,
    true,
  );
});

Deno.test("get_billing_costs requires billingTable", async () => {
  const f = createMockFetchFn(() => tokenResponse());
  const { ctx } = ctxFor({}, f);
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 7, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "billingTable is not configured",
  );
});

Deno.test("get_billing_costs parameterizes the query and writes per-project costs", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let jobUrl = "";
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("bigquery.googleapis.com")) {
      jobUrl = s;
      const body = JSON.parse(init!.body as string);
      bodies.push(body);
      if ((body.query as string).includes("MAX(usage_end_time)")) {
        return bqResponse(["o_data_through"], [["2099-01-01T00:00:00Z"]]);
      }
      return bqResponse(COST_FIELDS, [
        [
          "2026-09-28",
          "alpha",
          "Vertex AI",
          "Gemini 2.5 Pro input",
          "us-central1",
          "regular",
          "USD",
          "count",
          "1000",
          "12.5",
          "-2.5",
          "10",
        ],
        [
          "2026-09-29",
          "alpha",
          "Vertex AI",
          "Gemini 2.5 Pro output",
          "us-central1",
          "regular",
          "USD",
          "count",
          "100",
          "7.25",
          "0",
          "7.25",
        ],
        [
          "2026-09-28",
          "",
          "Vertex AI",
          "Support",
          "global",
          "regular",
          "EUR",
          "count",
          "1",
          "1",
          "0",
          "1",
        ],
      ]);
    }
    return new Response("nf", { status: 404 });
  });
  const { ctx, getWrittenResources } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await model.methods.get_billing_costs.execute(
    {
      days: 7,
      services: ["Vertex AI", "Anthropic"],
      skuPattern: "Gemini",
      projects: ["alpha"],
    },
    ctx,
  );

  // Job runs in the billing table's project unless overridden.
  assertMatch(jobUrl, /projects\/bill-proj\/queries/);
  const q = bodies[0];
  assertEquals(q.useLegacySql, false);
  assertEquals(q.parameterMode, "NAMED");
  assertMatch(
    q.query as string,
    /FROM `bill-proj\.billing\.gcp_billing_export_v1_ABC`/,
  );
  // Filters are bound parameters, never interpolated into the SQL text.
  assertEquals((q.query as string).includes("Anthropic"), false);
  assertEquals((q.query as string).includes("Gemini"), false);
  const params = q.queryParameters as Array<{
    name: string;
    parameterValue: { arrayValues?: Array<{ value: string }>; value?: string };
  }>;
  assertEquals(
    params.find((p) => p.name === "services")!.parameterValue.arrayValues!
      .map((v) => v.value),
    ["Vertex AI", "Anthropic"],
  );
  assertEquals(
    params.find((p) => p.name === "skuPattern")!.parameterValue.value,
    "Gemini",
  );
  assertEquals(params.some((p) => p.name === "projects"), true);

  const written = getWrittenResources();
  const names = written.map((w) => `${w.specName}/${w.name}`).sort();
  assertEquals(names, [
    "billing_costs/billing-alpha",
    "billing_costs/billing-unassigned",
    "billing_summary/current",
  ]);

  const alpha = written.find((w) => w.name === "billing-alpha")!.data as {
    rows: Array<{ cost: number; credits: number; netCost: number }>;
    totals: Array<
      { currency: string; cost: number; credits: number; netCost: number }
    >;
  };
  assertEquals(alpha.rows[0].netCost, 10);
  assertEquals(alpha.totals, [
    { currency: "USD", cost: 19.75, credits: -2.5, netCost: 17.25 },
  ]);

  const summary = written.find((w) => w.specName === "billing_summary")!
    .data as {
      totals: Array<{ currency: string; netCost: number }>;
      complete: boolean;
      rowCount: number;
      projectCount: number;
    };
  // Currencies are kept separate, never summed.
  assertEquals(summary.totals.map((t) => t.currency), ["EUR", "USD"]);
  assertEquals(summary.complete, true);
  assertEquals(summary.rowCount, 3);
  assertEquals(summary.projectCount, 2);
});

Deno.test("get_billing_costs flags an export that lags the window", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    const body = JSON.parse(init!.body as string);
    if ((body.query as string).includes("MAX(usage_end_time)")) {
      return bqResponse(["o_data_through"], [["2020-01-01T00:00:00Z"]]);
    }
    return bqResponse(COST_FIELDS, []);
  });
  const { ctx, getWrittenResources } = ctxFor(
    {
      billingTable: BILLING_TABLE,
      billingSchema: "standard",
      billingQueryProject: "runner",
    },
    f,
  );
  await model.methods.get_billing_costs.execute(
    { days: 1, services: ["Vertex AI"] },
    ctx,
  );
  const summary = getWrittenResources().find((w) =>
    w.specName === "billing_summary"
  )!.data as { complete: boolean; warnings: string[] };
  assertEquals(summary.complete, false);
  assertMatch(summary.warnings[0], /understated/);
});

Deno.test("get_billing_costs warns when no rows match", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    const body = JSON.parse(init!.body as string);
    if ((body.query as string).includes("MAX(usage_end_time)")) {
      return bqResponse(["o_data_through"], [[null]]);
    }
    return bqResponse(COST_FIELDS, []);
  });
  const { ctx, getWrittenResources } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await model.methods.get_billing_costs.execute(
    { days: 1, services: ["Nope"] },
    ctx,
  );
  const summary = getWrittenResources().find((w) =>
    w.specName === "billing_summary"
  )!.data as {
    dataThrough: string | null;
    complete: boolean;
    warnings: string[];
  };
  assertEquals(summary.dataThrough, null);
  assertEquals(summary.complete, false);
  assertMatch(summary.warnings[0], /discover_billing_services/);
});

Deno.test("BigQuery polls incomplete jobs and follows result pages", async () => {
  let posted = 0;
  const gets: string[] = [];
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (init?.method === "POST") {
      posted++;
      const body = JSON.parse(init.body as string);
      if ((body.query as string).includes("MAX(usage_end_time)")) {
        return bqResponse(["o_data_through"], [["2099-01-01T00:00:00Z"]]);
      }
      return new Response(
        JSON.stringify({
          jobComplete: false,
          jobReference: {
            projectId: "bill-proj",
            jobId: "job9",
            location: "US",
          },
        }),
        { status: 200 },
      );
    }
    gets.push(s);
    if (!s.includes("pageToken")) {
      return bqResponse(
        COST_FIELDS,
        [[
          "2026-09-28",
          "a",
          "Vertex AI",
          "s1",
          "",
          "regular",
          "USD",
          "",
          "1",
          "1",
          "0",
        ]],
        { pageToken: "next" },
      );
    }
    return bqResponse(
      COST_FIELDS,
      [[
        "2026-09-29",
        "a",
        "Vertex AI",
        "s2",
        "",
        "regular",
        "USD",
        "",
        "1",
        "2",
        "0",
      ]],
    );
  });
  const { ctx, getWrittenResources } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await model.methods.get_billing_costs.execute(
    { days: 7, services: ["Vertex AI"] },
    ctx,
  );
  assertEquals(posted, 2);
  assertEquals(gets.length, 2);
  assertMatch(gets[0], /queries\/job9\?.*location=US/);
  const a = getWrittenResources().find((w) => w.name === "billing-a")!.data as {
    rows: unknown[];
    totals: Array<{ cost: number }>;
  };
  // Rows from both pages are present, so cost is not silently truncated.
  assertEquals(a.rows.length, 2);
  assertEquals(a.totals[0].cost, 3);
});

Deno.test("BigQuery errors fail the method instead of returning partial cost", async () => {
  const f = createMockFetchFn((u) => {
    if (url(u).includes("oauth2.googleapis.com/token")) return tokenResponse();
    return new Response("Access Denied: bigquery.jobs.create", { status: 403 });
  });
  const { ctx } = ctxFor({
    billingTable: BILLING_TABLE,
    billingSchema: "standard",
  }, f);
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "BigQuery request failed (HTTP 403)",
  );
});

Deno.test("discover_billing_services rolls SKUs up per service", async () => {
  const f = createMockFetchFn((u) => {
    if (url(u).includes("oauth2.googleapis.com/token")) return tokenResponse();
    return bqResponse(
      [
        "o_service",
        "o_sku",
        "o_currency",
        "o_usage_unit",
        "o_usage_amount",
        "o_cost",
      ],
      [
        ["Vertex AI", "Gemini input", "USD", "count", "10", "5"],
        ["Vertex AI", "Gemini output", "USD", "count", "5", "3"],
        ["Claude on Vertex", "Sonnet input", "USD", "count", "1", "1.5"],
      ],
    );
  });
  const { ctx, getWrittenResources } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await model.methods.discover_billing_services.execute(
    { days: 7, pattern: "(?i)vertex|claude" },
    ctx,
  );
  const r = getWrittenResources()[0];
  assertEquals(r.specName, "billing_services");
  const data = r.data as {
    services: Array<
      { service: string; currency: string; cost: number; skuCount: number }
    >;
    skus: unknown[];
  };
  assertEquals(data.services, [
    { service: "Vertex AI", currency: "USD", cost: 8, skuCount: 2 },
    { service: "Claude on Vertex", currency: "USD", cost: 1.5, skuCount: 1 },
  ]);
  assertEquals(data.skus.length, 3);
});

Deno.test("model declares the expected resource specs", () => {
  const schema = model.resources.usage.schema;
  assertEquals(schema.safeParse({}).success, false);
  assertEquals(
    Object.keys(model.resources).sort(),
    [
      "billing_costs",
      "billing_services",
      "billing_summary",
      "gemini_scan_summary",
      "gemini_usage",
      "projects",
      "scan_results",
      "scan_summary",
      "single_scan",
      "usage",
    ],
  );
});

// =============================================================================
// Findings from validating against live GCP
// =============================================================================

const FOCUS_TABLE_FIELDS = [
  "ServiceName",
  "BilledCost",
  "ContractedCost",
  "ChargePeriodStart",
  "x_Credits",
  "x_Project",
];

function tableSchemaResponse(fields: string[]): Response {
  return new Response(
    JSON.stringify({ schema: { fields: fields.map((name) => ({ name })) } }),
    { status: 200 },
  );
}

/** Mock for a billing run: detects the schema, answers queries. */
function billingFetch(
  fields: string[],
  seen: { schemaUrl?: string; queries: string[] },
): typeof fetch {
  return createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("/tables/")) {
      seen.schemaUrl = s;
      return tableSchemaResponse(fields);
    }
    const body = JSON.parse(init!.body as string);
    seen.queries.push(body.query as string);
    if ((body.query as string).includes("o_data_through")) {
      return bqResponse(["o_data_through"], [["2099-01-01T00:00:00Z"]]);
    }
    return bqResponse(COST_FIELDS, []);
  });
}

Deno.test("billingSchema auto-detects a FOCUS export and queries FOCUS columns", async () => {
  const seen: { schemaUrl?: string; queries: string[] } = { queries: [] };
  const { ctx, getWrittenResources } = ctxFor(
    { billingTable: BILLING_TABLE },
    billingFetch(FOCUS_TABLE_FIELDS, seen),
  );
  await model.methods.get_billing_costs.execute(
    { days: 7, services: ["Vertex AI"], projects: ["alpha"] },
    ctx,
  );
  // tables.get must not send selectedFields: it takes column names, and
  // "schema" is rejected with HTTP 400 (found against live BigQuery).
  assertEquals(seen.schemaUrl!.includes("selectedFields"), false);
  assertMatch(
    seen.schemaUrl!,
    /datasets\/billing\/tables\/gcp_billing_export_v1_ABC$/,
  );
  const q = seen.queries[0];
  assertMatch(q, /ServiceName IN UNNEST\(@services\)/);
  assertMatch(q, /ChargePeriodStart >= @start/);
  assertMatch(q, /x_Project\.Id IN UNNEST\(@projects\)/);
  assertMatch(q, /SUM\(ContractedCost\)/);
  assertMatch(q, /UNNEST\(x_Credits\)/);
  assertMatch(q, /SUM\(BilledCost\)/);
  // Output aliases must not collide with export columns; GROUP BY is positional.
  assertMatch(q, /GROUP BY 1, 2, 3, 4, 5, 6, 7, 8/);
  assertEquals(q.includes("usage_start_time"), false);
  const summary = getWrittenResources().find((w) =>
    w.specName === "billing_summary"
  )!.data as { billingSchema: string };
  assertEquals(summary.billingSchema, "focus");
});

Deno.test("billingSchema auto-detects the standard export", async () => {
  const seen: { schemaUrl?: string; queries: string[] } = { queries: [] };
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE },
    billingFetch(["service", "usage_start_time", "cost"], seen),
  );
  await model.methods.get_billing_costs.execute(
    { days: 7, services: ["Vertex AI"] },
    ctx,
  );
  assertMatch(seen.queries[0], /service\.description IN UNNEST\(@services\)/);
  assertMatch(seen.queries[0], /usage_start_time >= @start/);
});

Deno.test("billingSchema override skips table detection", async () => {
  const seen: { schemaUrl?: string; queries: string[] } = { queries: [] };
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "focus" },
    billingFetch([], seen),
  );
  await model.methods.get_billing_costs.execute(
    { days: 1, services: ["Vertex AI"] },
    ctx,
  );
  assertEquals(seen.schemaUrl, undefined);
  assertMatch(seen.queries[0], /ServiceName/);
});

Deno.test("billing schema detection rejects an unknown table layout", async () => {
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE },
    billingFetch(["foo", "bar"], { queries: [] }),
  );
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "matches neither the standard nor the FOCUS export schema",
  );
});

Deno.test("billing schema detection failure points at the override", async () => {
  const f = createMockFetchFn((u) => {
    if (url(u).includes("oauth2.googleapis.com/token")) return tokenResponse();
    return new Response("nope", { status: 403 });
  });
  const { ctx } = ctxFor({ billingTable: BILLING_TABLE }, f);
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    'Set billingSchema to "standard" or "focus"',
  );
});

Deno.test("get_billing_costs uses the export's net cost and flags drift", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    const body = JSON.parse(init!.body as string);
    if ((body.query as string).includes("o_data_through")) {
      return bqResponse(["o_data_through"], [["2099-01-01T00:00:00Z"]]);
    }
    // gross 10 + credits -2 should be 8, but the export says net is 5.
    return bqResponse(COST_FIELDS, [[
      "2026-09-28",
      "alpha",
      "Vertex AI",
      "sku",
      "",
      "USAGE",
      "USD",
      "requests",
      "1",
      "10",
      "-2",
      "5",
    ]]);
  });
  const { ctx, getWrittenResources } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "focus" },
    f,
  );
  await model.methods.get_billing_costs.execute(
    { days: 1, services: ["Vertex AI"] },
    ctx,
  );
  const w = getWrittenResources();
  const alpha = w.find((x) => x.name === "billing-alpha")!.data as {
    rows: Array<{ netCost: number }>;
  };
  assertEquals(alpha.rows[0].netCost, 5);
  const summary = w.find((x) => x.specName === "billing_summary")!.data as {
    warnings: string[];
  };
  assertMatch(summary.warnings[0], /differs from the export's net cost/);
});

Deno.test("usage rows count errors and 429s from response_code, and keep shared tiers apart", async () => {
  const inv = (code: string | undefined, shared: string, v: string) => {
    const s = series({
      model: "m",
      requestType: "shared",
      points: [["2026-09-28", v]],
    });
    s.metric.labels = {
      request_type: "shared",
      shared_request_type: shared,
      ...(code ? { response_code: code } : {}),
    } as typeof s.metric.labels;
    return s;
  };
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("model_invocation_count")) {
      return monitoringResponse([
        inv("200", "standard", "90"),
        inv("429", "standard", "4"),
        inv("500", "standard", "6"),
        inv(undefined, "standard", "2"),
        inv("200", "priority", "10"),
      ]);
    }
    return monitoringResponse([
      (() => {
        const t = series({
          model: "m",
          direction: "input",
          points: [["2026-09-28", "50"]],
        });
        t.metric.labels = {
          type: "input",
          request_type: "shared",
          shared_request_type: "standard",
        } as typeof t.metric.labels;
        return t;
      })(),
    ]);
  });
  const { ctx, getWrittenResources } = ctxFor({ projects: ["p1"] }, f);
  await model.methods.scan_usage.execute(
    { days: 7, parents: [], concurrency: 1, maxRequestsPerMinute: 120 },
    ctx,
  );
  const usage = getWrittenResources().find((w) => w.specName === "usage")!
    .data as {
      rows: Array<{
        sharedRequestType: string;
        requests: number;
        errorRequests: number;
        rateLimitedRequests: number;
        inputTokens: number;
      }>;
      totals: { requests: number; errorRequests: number };
    };
  const std = usage.rows.find((r) => r.sharedRequestType === "standard")!;
  const pri = usage.rows.find((r) => r.sharedRequestType === "priority")!;
  assertEquals(std.requests, 102);
  // 429 and 500 are errors; a missing response_code is not.
  assertEquals(std.errorRequests, 10);
  assertEquals(std.rateLimitedRequests, 4);
  assertEquals(std.inputTokens, 50);
  assertEquals(pri.requests, 10);
  assertEquals(pri.errorRequests, 0);
  assertEquals(usage.totals.errorRequests, 10);
});

// =============================================================================
// Gemini API (generativelanguage.googleapis.com)
// =============================================================================

function geminiTokenSeries(
  model: string,
  points: Array<[string, string]>,
  labels: Record<string, string> = {},
) {
  return {
    metric: {
      labels: {
        model,
        output_modality: "text",
        thinking_enabled: "false",
        ...labels,
      },
    },
    resource: { labels: { project_id: "p", location: "us-central1" } },
    points: points.map(([day, v]) => ({
      interval: { startTime: `${day}T00:00:00Z`, endTime: `${day}T23:59:59Z` },
      value: { int64Value: v },
    })),
  };
}

function geminiRequestSeries(
  code: string,
  credential: string,
  v: string,
  method =
    "google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent",
) {
  return {
    metric: { labels: { response_code: code } },
    resource: {
      labels: {
        service: "generativelanguage.googleapis.com",
        version: "v1beta",
        credential_id: credential,
        location: "us-central1",
        method,
      },
    },
    points: [{
      interval: {
        startTime: "2026-09-28T00:00:00Z",
        endTime: "2026-09-29T00:00:00Z",
      },
      value: { int64Value: v },
    }],
  };
}

Deno.test("scan_gemini_api_usage reads output tokens and API-wide requests", async () => {
  const filters: string[] = [];
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("projects/idle/")) return monitoringResponse([]);
    const filter = new URL(s).searchParams.get("filter") ?? "";
    filters.push(filter);
    if (filter.includes("generate_content_usage_output_token_count")) {
      return monitoringResponse([
        geminiTokenSeries("gemini-2.5-flash", [["2026-09-28", "100"], [
          "2026-09-29",
          "50",
        ]]),
        geminiTokenSeries("gemini-2.5-flash", [["2026-09-28", "25"]], {
          thinking_enabled: "true",
        }),
        geminiTokenSeries("gemini-2.5-pro", [["2026-09-28", "7"]]),
      ]);
    }
    return monitoringResponse([
      geminiRequestSeries("200", "apikey:aaa", "90"),
      geminiRequestSeries("429", "apikey:aaa", "4"),
      geminiRequestSeries("503", "apikey:bbb", "6"),
      geminiRequestSeries(
        "200",
        "apikey:bbb",
        "3",
        "google.ai.generativelanguage.v1beta.ModelService.ListModels",
      ),
    ]);
  });
  const { ctx, getWrittenResources } = ctxFor({}, (u, i) => {
    if (url(u).includes("projects:search")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            projects: [{ projectId: "p" }, { projectId: "idle" }],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(f(u, i));
  });
  await model.methods.scan_gemini_api_usage.execute(
    { days: 7, parents: [], concurrency: 2, maxRequestsPerMinute: 120 },
    ctx,
  );

  // The request-count metric must be scoped to the Gemini API service, since
  // serviceruntime request_count covers every API in the project.
  const reqFilter = filters.find((x) => x.includes("request_count"))!;
  assertMatch(
    reqFilter,
    /AND resource\.labels\.service = "generativelanguage\.googleapis\.com"/,
  );

  const written = getWrittenResources();
  assertEquals(
    written.map((w) => `${w.specName}/${w.name}`).sort(),
    ["gemini_scan_summary/current", "gemini_usage/gemini-usage-p"],
  );
  const u = written.find((w) => w.specName === "gemini_usage")!.data as {
    inputTokensAvailable: boolean;
    tokenRows: Array<
      {
        date: string;
        modelId: string;
        thinkingEnabled: string;
        outputTokens: number;
      }
    >;
    requestRows: Array<{ method: string; apiVersion: string }>;
    totals: {
      outputTokens: number;
      requests: number;
      errorRequests: number;
      rateLimitedRequests: number;
    };
    byModel: Array<{ modelId: string; outputTokens: number }>;
    byCredential: Array<
      { credentialId: string; requests: number; errorRequests: number }
    >;
  };
  assertEquals(u.inputTokensAvailable, false);
  // thinking on/off stay separate rows; the same model on the same day is not merged across them.
  assertEquals(
    u.tokenRows.filter((r) => r.modelId === "gemini-2.5-flash").length,
    3,
  );
  assertEquals(u.totals.outputTokens, 182);
  assertEquals(u.byModel[0], {
    modelId: "gemini-2.5-flash",
    outputTokens: 175,
  });
  assertEquals(u.totals.requests, 103);
  assertEquals(u.totals.errorRequests, 10);
  assertEquals(u.totals.rateLimitedRequests, 4);
  // Method name is trimmed of the package/version prefix.
  assertEquals(
    u.requestRows.some((r) => r.method === "GenerativeService.GenerateContent"),
    true,
  );
  assertEquals(
    u.requestRows.some((r) => r.method === "ModelService.ListModels"),
    true,
  );
  assertEquals(u.byCredential[0], {
    credentialId: "apikey:aaa",
    requests: 94,
    errorRequests: 4,
  });

  const summary = written.find((w) => w.specName === "gemini_scan_summary")!
    .data as {
      complete: boolean;
      projects: Array<{ project: string; status: string }>;
    };
  assertEquals(summary.complete, true);
  const st = Object.fromEntries(
    summary.projects.map((p) => [p.project, p.status]),
  );
  assertEquals(st, { p: "ok", idle: "no_data" });
});

Deno.test("scan_gemini_api_usage keeps tokens when request counts fail", async () => {
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("request_count")) {
      return new Response("denied", { status: 403 });
    }
    return monitoringResponse([
      geminiTokenSeries("gemini-2.5-flash", [["2026-09-28", "9"]]),
    ]);
  });
  const { ctx, getWrittenResources } = ctxFor({ projects: ["p"] }, f);
  await model.methods.scan_gemini_api_usage.execute(
    { days: 7, parents: [], concurrency: 1, maxRequestsPerMinute: 120 },
    ctx,
  );
  const u = getWrittenResources().find((w) => w.specName === "gemini_usage")!
    .data as {
      totals: { outputTokens: number };
      warnings: string[];
      requestsAvailable: boolean;
    };
  assertEquals(u.totals.outputTokens, 9);
  assertEquals(u.requestsAvailable, false);
  assertMatch(u.warnings[0], /Request counts unavailable/);
  const gsum = getWrittenResources().find((w) =>
    w.specName === "gemini_scan_summary"
  )!.data as { complete: boolean };
  assertEquals(gsum.complete, false);
});

Deno.test("daily points land on their own day whatever the interval shape", async () => {
  const point = (
    startTime: string | undefined,
    endTime: string,
    v: string,
  ) => ({
    interval: startTime ? { startTime, endTime } : { endTime },
    value: { int64Value: v },
  });
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("request_count")) return monitoringResponse([]);
    const ts = geminiTokenSeries("m", []);
    return monitoringResponse([{
      ...ts,
      points: [
        // start..next midnight (exclusive end)
        point("2026-09-20T00:00:00Z", "2026-09-21T00:00:00Z", "1"),
        // start..23:59:59 (inclusive end)
        point("2026-09-21T00:00:00Z", "2026-09-21T23:59:59Z", "2"),
        // end only, at midnight: closes the previous day
        point(undefined, "2026-09-23T00:00:00Z", "4"),
        // end only, inside the day
        point(undefined, "2026-09-23T23:59:59Z", "8"),
        // gauge-style zero-length interval at midnight: previous day
        point("2026-09-25T00:00:00Z", "2026-09-25T00:00:00Z", "16"),
        // Interval opening late the previous evening: the midpoint, not the
        // start, decides the day.
        point("2026-09-26T20:00:00Z", "2026-09-27T23:59:59Z", "32"),
      ],
    }]);
  });
  const { ctx, getWrittenResources } = ctxFor({ projects: ["p"] }, f);
  await model.methods.scan_gemini_api_usage.execute(
    { days: 7, parents: [], concurrency: 1, maxRequestsPerMinute: 120 },
    ctx,
  );
  const u = getWrittenResources().find((w) => w.specName === "gemini_usage")!
    .data as { tokenRows: Array<{ date: string; outputTokens: number }> };
  assertEquals(
    Object.fromEntries(u.tokenRows.map((r) => [r.date, r.outputTokens])),
    {
      "2026-09-20": 1,
      "2026-09-21": 2,
      "2026-09-22": 4,
      "2026-09-23": 8,
      "2026-09-24": 16,
      "2026-09-27": 32,
    },
  );
});

Deno.test("scan_gemini_api_usage reports an errored project as incomplete", async () => {
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("projects/bad/")) {
      return new Response("denied", { status: 403 });
    }
    return monitoringResponse([
      geminiTokenSeries("m", [["2026-09-28", "1"]]),
    ]);
  });
  const { ctx, getWrittenResources } = ctxFor({ projects: ["ok", "bad"] }, f);
  await model.methods.scan_gemini_api_usage.execute(
    { days: 1, parents: [], concurrency: 2, maxRequestsPerMinute: 120 },
    ctx,
  );
  const summary = getWrittenResources().find((w) =>
    w.specName === "gemini_scan_summary"
  )!.data as {
    complete: boolean;
    projects: Array<{ project: string; status: string }>;
  };
  assertEquals(summary.complete, false);
  assertEquals(
    summary.projects.find((p) => p.project === "bad")!.status,
    "error",
  );
});

Deno.test("get_billing_costs defaults to both Vertex AI and Gemini API", () => {
  const parsed = model.methods.get_billing_costs.arguments.parse({});
  assertEquals(parsed.services, ["Vertex AI", "Gemini API"]);
});

Deno.test("scan paces Monitoring requests under maxRequestsPerMinute", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    return monitoringResponse([]);
  });
  const tc = createModelTestContext({
    globalArgs: {
      serviceAccountJson: FAKE_SA_JSON,
      projects: ["a", "b", "c"],
    },
    definition: { id: "t", name: "v", version: 1, tags: {} },
  });
  const ctx = {
    ...tc.context,
    fetchFn: f,
    nowFn: () => clock,
    sleepFn: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  } as unknown as Ctx;
  // 6 projects x 2 metrics = 12 requests against a cap of 10 per minute.
  await model.methods.scan_usage.execute(
    {
      days: 1,
      parents: [],
      concurrency: 1,
      maxRequestsPerMinute: 10,
      projects: ["a", "b", "c", "d", "e", "f"],
    },
    ctx,
  );
  // 12 requests with a cap of 10 per minute forces exactly one wait for the
  // window to roll over, not a spin.
  assertEquals(sleeps.length > 0, true);
  assertEquals(sleeps.every((ms) => ms > 0 && ms <= 60_000), true);
});

Deno.test("429 backs off for longer than a 5xx and honors Retry-After", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    calls++;
    if (calls === 1) {
      return new Response("quota", {
        status: 429,
        headers: { "retry-after": "7" },
      });
    }
    if (calls === 2) return new Response("quota", { status: 429 });
    if (calls === 3) return new Response("oops", { status: 503 });
    return monitoringResponse([]);
  });
  const tc = createModelTestContext({
    globalArgs: { serviceAccountJson: FAKE_SA_JSON, projects: ["p1"] },
    definition: { id: "t", name: "v", version: 1, tags: {} },
  });
  await model.methods.get_token_usage.execute(
    { project: "p1", days: 1 },
    {
      ...tc.context,
      fetchFn: f,
      sleepFn: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    } as unknown as Ctx,
  );
  // Retry-After wins; an unadvised 429 starts at 5s and doubles; 5xx starts at 0.5s*2^attempt.
  assertEquals(sleeps[0], 7000);
  assertEquals(sleeps[1], 10_000);
  assertEquals(sleeps[2], 2000);
});

Deno.test("retries do not consume rate limiter slots", async () => {
  const scan = async (limit: number, failFirst: boolean) => {
    let monitoring = 0;
    const sleeps: number[] = [];
    const f = createMockFetchFn((u) => {
      if (url(u).includes("oauth2.googleapis.com/token")) {
        return tokenResponse();
      }
      monitoring++;
      if (failFirst && monitoring === 1) {
        return new Response("quota", { status: 429 });
      }
      return monitoringResponse([]);
    });
    const tc = createModelTestContext({
      globalArgs: { serviceAccountJson: FAKE_SA_JSON, projects: ["p1"] },
      definition: { id: "t", name: "v", version: 1, tags: {} },
    });
    await model.methods.scan_usage.execute(
      // execute() skips schema validation, so limits below the schema's
      // minimum are fine here.
      { days: 1, parents: [], concurrency: 1, maxRequestsPerMinute: limit },
      {
        ...tc.context,
        fetchFn: f,
        // A frozen clock keeps every slot inside one window, so a limiter
        // wait shows up as a 60s sleep, longer than any 429 backoff here.
        nowFn: () => 0,
        sleepFn: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      } as unknown as Ctx,
    );
    return { monitoring, sleeps };
  };
  const baseline = await scan(1000, false);
  // Limit equals the first-attempt count: any slot spent on the retry would
  // push the limiter into a 60s wait.
  const withRetry = await scan(baseline.monitoring, true);
  assertEquals(withRetry.monitoring, baseline.monitoring + 1);
  assertEquals(withRetry.sleeps.some((ms) => ms >= 60_000), false);
});

Deno.test("BigQuery response without a job id is not reported as a timeout", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("/tables/")) {
      return tableSchemaResponse(["service", "usage_start_time", "cost"]);
    }
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ jobComplete: false }), {
        status: 200,
      });
    }
    return bqResponse(COST_FIELDS, []);
  });
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "no jobReference.jobId",
  );
});

Deno.test("BigQuery HTTP 200 with errors fails instead of returning zero rows", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("/tables/")) {
      return tableSchemaResponse(["service", "usage_start_time", "cost"]);
    }
    if (init?.method === "POST") {
      return bqResponse(["o_data_through"], [], {
        errors: [{ reason: "billingTierLimitExceeded" }],
      });
    }
    return bqResponse(["o_data_through"], []);
  });
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "billingTierLimitExceeded",
  );
});

Deno.test("BigQuery job that never completes still reports a timeout", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("/tables/")) {
      return tableSchemaResponse(["service", "usage_start_time", "cost"]);
    }
    if (init?.method === "POST") {
      return bqResponse(["o_data_through"], [], { jobComplete: false });
    }
    return bqResponse(["o_data_through"], [], { jobComplete: false });
  });
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "did not complete in time",
  );
});

Deno.test("BigQuery pageToken without a job id is not reported as a page cap", async () => {
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("/tables/")) {
      return tableSchemaResponse(["service", "usage_start_time", "cost"]);
    }
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({
          jobComplete: true,
          schema: { fields: [{ name: "o_data_through" }] },
          rows: [],
          pageToken: "next",
        }),
        { status: 200 },
      );
    }
    return bqResponse(["o_data_through"], []);
  });
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await assertRejects(
    () =>
      model.methods.get_billing_costs.execute(
        { days: 1, services: ["Vertex AI"] },
        ctx,
      ),
    Error,
    "no jobReference.jobId",
  );
});

Deno.test("domain-scoped billing projects are parsed from the right", async () => {
  const urls: string[] = [];
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    urls.push(s);
    if (s.includes("/tables/")) {
      return tableSchemaResponse(["service", "usage_start_time", "cost"]);
    }
    const body = JSON.parse(init!.body as string);
    if ((body.query as string).includes("o_data_through")) {
      return bqResponse(["o_data_through"], [["2099-01-01T00:00:00Z"]]);
    }
    return bqResponse(COST_FIELDS, []);
  });
  const { ctx } = ctxFor(
    { billingTable: "example.com:proj.billing.export_v1" },
    f,
  );
  await model.methods.get_billing_costs.execute(
    { days: 1, services: ["Vertex AI"] },
    ctx,
  );
  assertMatch(
    urls.find((x) => x.includes("/tables/"))!,
    /projects\/example\.com%3Aproj\/datasets\/billing\/tables\/export_v1$/,
  );
  assertEquals(
    urls.some((x) => x.includes("/projects/example.com%3Aproj/queries")),
    true,
  );
});

Deno.test("scan_projects fails on empty discovery instead of reporting zero usage", async () => {
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    return new Response(JSON.stringify({ projects: [] }), { status: 200 });
  });
  const { ctx, getWrittenResources } = ctxFor({}, f);
  await assertRejects(
    () => model.methods.scan_projects.execute({ days: 7 }, ctx),
    Error,
    "No projects to scan",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("an explicit empty projects list falls back to the configured one", async () => {
  const scanned: string[] = [];
  const f = createMockFetchFn((u) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (s.includes("projects:search")) throw new Error("must not discover");
    const m = /projects\/([^/]+)\/timeSeries/.exec(s);
    if (m) scanned.push(m[1]);
    return monitoringResponse([]);
  });
  const { ctx } = ctxFor({ projects: ["configured"] }, f);
  await model.methods.scan_usage.execute(
    {
      days: 1,
      projects: [],
      parents: [],
      concurrency: 1,
      maxRequestsPerMinute: 120,
    },
    ctx,
  );
  assertEquals([...new Set(scanned)], ["configured"]);
});

Deno.test("BigQuery jobs.query carries a requestId for deduplication", async () => {
  const ids: unknown[] = [];
  const f = createMockFetchFn((u, init) => {
    const s = url(u);
    if (s.includes("oauth2.googleapis.com/token")) return tokenResponse();
    const body = JSON.parse(init!.body as string);
    ids.push(body.requestId);
    if ((body.query as string).includes("o_data_through")) {
      return bqResponse(["o_data_through"], [[null]]);
    }
    return bqResponse(COST_FIELDS, []);
  });
  const { ctx } = ctxFor(
    { billingTable: BILLING_TABLE, billingSchema: "standard" },
    f,
  );
  await model.methods.get_billing_costs.execute(
    { days: 1, services: ["Vertex AI"] },
    ctx,
  );
  assertEquals(ids.length, 2);
  assertMatch(String(ids[0]), /^[0-9a-f-]{36}$/);
  assertEquals(ids[0] !== ids[1], true);
});
