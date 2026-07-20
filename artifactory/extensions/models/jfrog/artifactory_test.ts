// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./artifactory.ts";

// deno-lint-ignore no-explicit-any
type AnyContext = any;

function makeContext() {
  return createModelTestContext({
    globalArgs: { url: "https://packages.example.com", token: "test-token" },
    definition: { id: "test", name: "packages-test", version: 1, tags: {} },
  });
}

let fetchHandler:
  | ((url: string, opts: RequestInit) => { status: number; body: unknown })
  | null = null;

function mockFetch(
  handler: (
    url: string,
    opts: RequestInit,
  ) => { status: number; body: unknown },
): () => void {
  const original = globalThis.fetch;
  fetchHandler = handler;
  globalThis.fetch = ((url: string | URL | Request, opts?: RequestInit) => {
    const { status, body } = fetchHandler!(url.toString(), opts ?? {});
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
    fetchHandler = null;
  };
}

// =============================================================================
// Structure
// =============================================================================

Deno.test("model type and version", () => {
  assertEquals(model.type, "@webframp/artifactory");
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model has all expected methods", () => {
  const expected = [
    "system_health",
    "list_repos",
    "get_repo_health",
    "query_packages",
    "diff_packages",
    "get_storage_info",
  ];
  for (const m of expected) {
    assertEquals(m in model.methods, true, `Missing: ${m}`);
  }
});

// =============================================================================
// system_health
// =============================================================================

Deno.test({
  name: "system_health reports ok when ping succeeds",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch((url) => {
      if (url.includes("/api/system/ping")) return { status: 200, body: "OK" };
      if (url.includes("/api/system/health")) return { status: 403, body: {} };
      return { status: 404, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.system_health.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.ping, "ok");
      assertStringIncludes(data.health.note, "403");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "system_health reports error when ping fails",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 503,
      body: "Service Unavailable",
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.system_health.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.ping, "error");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_repos
// =============================================================================

Deno.test({
  name: "list_repos returns repositories",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 200,
      body: [
        {
          key: "docker-local",
          type: "LOCAL",
          packageType: "docker",
          url: "https://x/docker-local",
          description: "Docker images",
        },
        {
          key: "npm-remote",
          type: "REMOTE",
          packageType: "npm",
          url: "https://x/npm-remote",
          description: "",
        },
      ],
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.list_repos.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.totalCount, 2);
      assertEquals(data.repos[0].key, "docker-local");
      assertEquals(data.truncated, false);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_repo_health
// =============================================================================

Deno.test({
  name: "get_repo_health fan-out from storageinfo",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch((url) => {
      if (url.includes("/api/storageinfo")) {
        return {
          status: 200,
          body: {
            repositoriesSummaryList: [
              {
                repoKey: "docker-local",
                filesCount: 42,
                usedSpace: "1.2 GB",
                usedSpaceInBytes: 1288490189,
              },
              {
                repoKey: "npm-cache",
                filesCount: 100,
                usedSpace: "500 MB",
                usedSpaceInBytes: 524288000,
              },
            ],
            fileStoreSummary: {},
          },
        };
      }
      return { status: 404, body: {} };
    });
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_repo_health.execute(
        { repoKey: undefined },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const resources = getWrittenResources() as any[];
      assertEquals(resources.length, 2);
      // deno-lint-ignore no-explicit-any
      const docker = resources.find((r: any) => r.name === "docker-local");
      assertEquals(docker.data.status, "ok");
      assertEquals(docker.data.artifactCount, 42);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// query_packages
// =============================================================================

Deno.test({
  name: "query_packages stores results keyed by hash",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        results: [
          {
            repo: "npm-local",
            path: "lodash/-",
            name: "lodash-4.17.21.tgz",
            size: 72000,
            modified: "2026-01-01",
          },
        ],
        range: { start_pos: 0, end_pos: 1, total: 1 },
      },
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.query_packages.execute(
        { query: 'items.find({"repo":"npm-local"})', limit: 1000 },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.totalCount, 1);
      assertEquals(data.results[0].name, "lodash-4.17.21.tgz");
      assertEquals(data.truncated, false);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// diff_packages
// =============================================================================

Deno.test({
  name: "diff_packages detects new and removed",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 200,
      body: {
        results: [
          {
            repo: "npm",
            path: "a",
            name: "a-1.0.tgz",
            size: 100,
            modified: "2026-06-01",
          },
          {
            repo: "npm",
            path: "b",
            name: "b-2.0.tgz",
            size: 200,
            modified: "2026-06-01",
          },
        ],
        range: { start_pos: 0, end_pos: 2, total: 2 },
      },
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      // deno-lint-ignore no-explicit-any
      (context as any).readResource = () =>
        Promise.resolve({
          fetchedAt: "2026-05-31T00:00:00Z",
          truncated: false,
          results: [
            {
              repo: "npm",
              path: "a",
              name: "a-1.0.tgz",
              size: 100,
              modified: "2026-05-30",
            },
            {
              repo: "npm",
              path: "c",
              name: "c-1.0.tgz",
              size: 300,
              modified: "2026-05-30",
            },
          ],
        });
      await model.methods.diff_packages.execute(
        { query: 'items.find({"repo":"npm"})', limit: 1000 },
        context as AnyContext,
      );
      // deno-lint-ignore no-explicit-any
      const resources = getWrittenResources() as any[];
      const diff = resources.find((r) => r.specName === "package-diff")?.data;
      assertEquals(diff.summary.newCount, 1); // b-2.0.tgz
      assertEquals(diff.summary.removedCount, 1); // c-1.0.tgz
      assertEquals(diff.noBaseline, false);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_storage_info
// =============================================================================

Deno.test({
  name: "get_storage_info handles 403 gracefully",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({
      status: 403,
      body: { errors: [{ message: "forbidden" }] },
    }));
    try {
      const { context, getWrittenResources } = makeContext();
      await model.methods.get_storage_info.execute({}, context as AnyContext);
      // deno-lint-ignore no-explicit-any
      const data = (getWrittenResources() as any[])[0].data as any;
      assertEquals(data.status, "forbidden");
      assertStringIncludes(data.error, "admin");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// Auth errors
// =============================================================================

Deno.test({
  name: "401 produces token-expired error",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockFetch(() => ({ status: 401, body: {} }));
    try {
      const { context } = makeContext();
      let msg = "";
      try {
        await model.methods.list_repos.execute({}, context as AnyContext);
      } catch (e) {
        msg = (e as Error).message;
      }
      assertStringIncludes(msg, "expired");
    } finally {
      restore();
    }
  },
});
