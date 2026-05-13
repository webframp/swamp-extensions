// GCP Vertex Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./vertex_usage.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

const OriginalCommand = Deno.Command;
type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  class MockCommand {
    #cmd: string;
    #args: string[];
    constructor(
      cmd: string,
      options: { args?: string[]; stdout?: string; stderr?: string },
    ) {
      this.#cmd = cmd;
      this.#args = options.args ?? [];
    }
    output() {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        stdout: encoder.encode(result.stdout),
        stderr: result.success ? new Uint8Array() : encoder.encode("failed"),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

function withMockedFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// =============================================================================
// Type aliases
// =============================================================================

type ScanContext = Parameters<typeof model.methods.scan_projects.execute>[1];

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

Deno.test("model defines expected resources", () => {
  assertEquals("scan_results" in model.resources, true);
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

// =============================================================================
// Execute-level Tests
// =============================================================================

Deno.test({
  name: "scan_projects returns token data for multiple projects",
  sanitizeResources: false,
  fn: async () => {
    await withMockedCommand(
      (cmd, args) => {
        if (cmd === "gcloud" && args.includes("print-access-token")) {
          return { stdout: "fake-token-123", success: true };
        }
        return { stdout: "", success: false };
      },
      () =>
        withMockedFetch(
          (url) => {
            if (url.includes("timeSeries")) {
              return new Response(
                JSON.stringify({
                  timeSeries: [
                    {
                      metric: { labels: { type: "input" } },
                      resource: {
                        labels: { model_user_id: "gemini-1.5-pro" },
                      },
                      points: [{ value: { int64Value: "15000" } }],
                    },
                    {
                      metric: { labels: { type: "output" } },
                      resource: {
                        labels: { model_user_id: "gemini-1.5-pro" },
                      },
                      points: [{ value: { int64Value: "8000" } }],
                    },
                  ],
                }),
                { status: 200 },
              );
            }
            return new Response("not found", { status: 404 });
          },
          async () => {
            const { context, getWrittenResources } = createModelTestContext({
              globalArgs: { projects: ["project-a", "project-b"] },
              definition: {
                id: "test-id",
                name: "vertex-usage",
                version: 1,
                tags: {},
              },
            });

            const result = await model.methods.scan_projects.execute(
              { days: 7 },
              context as unknown as ScanContext,
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
                models: Array<{ modelId: string }>;
              }>;
              totals: { totalTokens: number; inputTokens: number };
            };

            assertEquals(data.projects.length, 2);
            assertEquals(data.projects[0].models[0].modelId, "gemini-1.5-pro");
            assertEquals(data.totals.inputTokens, 30000); // 15000 * 2 projects
          },
        ),
    );
  },
});

Deno.test({
  name: "scan_projects handles pagination",
  sanitizeResources: false,
  fn: async () => {
    let fetchCount = 0;
    await withMockedCommand(
      (cmd, args) => {
        if (cmd === "gcloud" && args.includes("print-access-token")) {
          return { stdout: "fake-token", success: true };
        }
        return { stdout: "", success: false };
      },
      () =>
        withMockedFetch(
          (url) => {
            fetchCount++;
            if (url.includes("timeSeries")) {
              // First page returns a nextPageToken, second page does not
              if (!url.includes("pageToken")) {
                return new Response(
                  JSON.stringify({
                    timeSeries: [
                      {
                        metric: { labels: { type: "input" } },
                        resource: {
                          labels: { model_user_id: "gemini-1.5-pro" },
                        },
                        points: [{ value: { int64Value: "1000" } }],
                      },
                    ],
                    nextPageToken: "page2",
                  }),
                  { status: 200 },
                );
              }
              return new Response(
                JSON.stringify({
                  timeSeries: [
                    {
                      metric: { labels: { type: "output" } },
                      resource: {
                        labels: { model_user_id: "gemini-1.5-pro" },
                      },
                      points: [{ value: { int64Value: "500" } }],
                    },
                  ],
                }),
                { status: 200 },
              );
            }
            return new Response("not found", { status: 404 });
          },
          async () => {
            const { context, getWrittenResources } = createModelTestContext({
              globalArgs: { projects: ["my-project"] },
              definition: {
                id: "test-id",
                name: "vertex-usage",
                version: 1,
                tags: {},
              },
            });

            await model.methods.scan_projects.execute(
              { days: 7 },
              context as unknown as ScanContext,
            );

            const resources = getWrittenResources();
            const data = resources[0].data as {
              projects: Array<{ totalTokens: number }>;
            };

            // Should have fetched 2 pages
            assertEquals(fetchCount, 2);
            assertEquals(data.projects[0].totalTokens, 1500);
          },
        ),
    );
  },
});

Deno.test({
  name: "scan_projects handles API error gracefully",
  sanitizeResources: false,
  fn: async () => {
    await withMockedCommand(
      (cmd, args) => {
        if (cmd === "gcloud" && args.includes("print-access-token")) {
          return { stdout: "fake-token", success: true };
        }
        return { stdout: "", success: false };
      },
      () =>
        withMockedFetch(
          () =>
            new Response("Cannot find metric", {
              status: 400,
            }),
          async () => {
            const { context, getWrittenResources } = createModelTestContext({
              globalArgs: { projects: ["bad-project"] },
              definition: {
                id: "test-id",
                name: "vertex-usage",
                version: 1,
                tags: {},
              },
            });

            const result = await model.methods.scan_projects.execute(
              { days: 7 },
              context as unknown as ScanContext,
            );

            assertExists(result.dataHandles);
            const resources = getWrittenResources();
            const data = resources[0].data as {
              projects: Array<unknown>;
              totals: { totalTokens: number };
            };
            assertEquals(data.projects.length, 0);
            assertEquals(data.totals.totalTokens, 0);
          },
        ),
    );
  },
});
