/**
 * Tests for the extension generator module.
 */

import { assertEquals } from "@std/assert";
import {
  generateApiLib,
  generateReadme,
  generateReleaseNotes,
  generateSecretsSection,
  generateSwampYaml,
} from "./extension_generator.ts";
import type { ClassifiedMethod } from "./method_classifier.ts";
import type { GroupedOperation } from "./service_grouper.ts";
import type { ServiceConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// generateSwampYaml
//
// swamp mints `repoId` lazily into .swamp.yaml on first invocation in a
// directory — the generator never creates one. Regeneration must therefore
// carry forward whatever is already there, or it silently destroys the identity
// swamp uses for that repo. All 26 generated cloudflare extensions have a
// committed repoId that a naive regeneration would drop.
// ---------------------------------------------------------------------------

Deno.test("generateSwampYaml: preserves an existing repoId", () => {
  const existing =
    "repoVersion: 1\nrepoId: ad340ac8-27c9-44d1-a2f6-b4958dcf32a1\n";
  const result = generateSwampYaml(existing);

  assertEquals(
    result.includes("repoId: ad340ac8-27c9-44d1-a2f6-b4958dcf32a1"),
    true,
  );
  assertEquals(result.includes("repoVersion: 1"), true);
});

Deno.test("generateSwampYaml: emits no repoId for a new extension", () => {
  const result = generateSwampYaml(undefined);

  assertEquals(result.includes("repoId"), false);
  assertEquals(result.includes("repoVersion: 1"), true);
});

Deno.test("generateSwampYaml: a marker without a repoId stays without one", () => {
  const result = generateSwampYaml("repoVersion: 1\n");
  assertEquals(result.includes("repoId"), false);
});

Deno.test("generateSwampYaml: tolerates extra marker fields and comments", () => {
  // swamp writes additional keys over time (upgradedAt, tools, ...). Only the
  // repoId is carried forward — the rest are swamp's to re-add — but their
  // presence must not defeat the match.
  const existing = [
    "# Swamp repository marker",
    "repoVersion: 1",
    "tools:",
    "  - claude",
    "repoId: 11111111-2222-3333-4444-555555555555",
    'upgradedAt: "2026-07-26T15:33:08.695Z"',
    "",
  ].join("\n");

  const result = generateSwampYaml(existing);
  assertEquals(
    result.includes("repoId: 11111111-2222-3333-4444-555555555555"),
    true,
  );
});

Deno.test("generateSwampYaml: output is stable across repeated runs", () => {
  // Regeneration must be idempotent, or every run produces a spurious diff.
  const existing =
    "repoVersion: 1\nrepoId: ad340ac8-27c9-44d1-a2f6-b4958dcf32a1\n";
  const once = generateSwampYaml(existing);
  assertEquals(generateSwampYaml(once), once);
});

Deno.test("generateSwampYaml: ignores a repoId-like value in a comment", () => {
  const existing = "# repoId: not-the-real-one\nrepoVersion: 1\n";
  assertEquals(generateSwampYaml(existing).includes("repoId"), false);
});

// ---------------------------------------------------------------------------
// generateReleaseNotes
//
// Per-version notes are immutable on the swamp registry, so a wrong body is
// permanent. The default text claims an initial release, which is false for
// every version after the first — main.ts requires an explicit body when
// RELEASE_NOTES.md already exists.
// ---------------------------------------------------------------------------

const cfg = {
  name: "api-shield",
  description: "API Shield",
  pathPrefixes: ["/zones/{zone_id}/api_gateway"],
  scope: "zone" as const,
  labels: ["cloudflare"],
};

Deno.test("generateReleaseNotes: defaults to initial-release text", () => {
  const notes = generateReleaseNotes(cfg, "2026.07.19.1", 31);
  assertEquals(notes.startsWith("## 2026.07.19.1"), true);
  assertEquals(notes.includes("Initial code-generated release"), true);
  assertEquals(notes.includes("31 methods"), true);
});

Deno.test("generateReleaseNotes: an explicit body replaces the default", () => {
  const notes = generateReleaseNotes(
    cfg,
    "2026.07.27.1",
    31,
    "**Fixed:** methods referencing an undeclared path parameter.",
  );
  assertEquals(notes.includes("Initial code-generated release"), false);
  assertEquals(
    notes.includes(
      "**Fixed:** methods referencing an undeclared path parameter.",
    ),
    true,
  );
  assertEquals(notes.startsWith("## 2026.07.27.1"), true);
});

Deno.test("generateReleaseNotes: heading is always the version being published", () => {
  const notes = generateReleaseNotes(cfg, "2026.07.27.2", 31, "**Changed:** x");
  assertEquals(notes.split("\n")[0], "## 2026.07.27.2");
});

Deno.test("generateReleaseNotes: trailing whitespace in the body is trimmed", () => {
  const notes = generateReleaseNotes(
    cfg,
    "2026.07.27.1",
    31,
    "**Fixed:** y\n\n\n",
  );
  assertEquals(notes.endsWith("**Fixed:** y\n"), true);
});

// ---------------------------------------------------------------------------
// generateApiLib — the hardened HTTP client.
//
// The generated _lib/api.ts is what every model imports. These assertions pin
// the reference-inspired hardening: 429 retry with Retry-After, token env
// fallback, and the instance-name sanitizer export.
// ---------------------------------------------------------------------------

Deno.test("generateApiLib: exports sanitizeInstanceName", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("export function sanitizeInstanceName("), true);
});

Deno.test("generateApiLib: retries on 429 honoring Retry-After", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("status !== 429"), true);
  assertEquals(lib.includes('headers.get("Retry-After")'), true);
  assertEquals(lib.includes("const MAX_RETRIES = 3"), true);
});

Deno.test("generateApiLib: resolves the token from arg or env, else throws", () => {
  const lib = generateApiLib();
  assertEquals(lib.includes("function resolveToken("), true);
  assertEquals(lib.includes('Deno.env.get("CLOUDFLARE_API_TOKEN")'), true);
  assertEquals(lib.includes("Cloudflare API token not set"), true);
});

Deno.test("generateApiLib: sanitizeInstanceName strips path-traversal chars at runtime", async () => {
  // Materialize the generated source and import it, so the emitted regex chain
  // is exercised as real code rather than string-matched.
  const lib = generateApiLib();
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmp, lib);
    const mod = await import(`file://${tmp}`);
    // "/" and "\" -> "_", ".." -> "_", null byte removed (matches reference).
    assertEquals(mod.sanitizeInstanceName("a/b\\c..d\0e"), "a_b_c_de");
    assertEquals(mod.sanitizeInstanceName("plain"), "plain");
  } finally {
    await Deno.remove(tmp);
  }
});

// ---------------------------------------------------------------------------
// cfApiPaginatedCursor
//
// Materialize generateApiLib()'s output and import it (same pattern as
// sanitizeInstanceName above), mocking globalThis.fetch so the real cursor-
// following loop runs against controlled responses instead of string-matching
// the generated source.
// ---------------------------------------------------------------------------

function cfBody(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: [],
    ...overrides,
  });
}

async function withCfApiPaginatedCursor(
  fetchImpl: typeof fetch,
  // deno-lint-ignore no-explicit-any
  run: (fn: any) => Promise<void>,
) {
  const lib = generateApiLib();
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  const originalFetch = globalThis.fetch;
  try {
    await Deno.writeTextFile(tmp, lib);
    const mod = await import(`file://${tmp}`);
    globalThis.fetch = fetchImpl;
    await run(mod.cfApiPaginatedCursor);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(tmp);
  }
}

Deno.test("cfApiPaginatedCursor: single page with no result_info.cursor is not truncated", async () => {
  await withCfApiPaginatedCursor(
    (() =>
      Promise.resolve(
        new Response(
          cfBody({
            result: [{ id: 1 }],
            result_info: {
              page: 1,
              per_page: 20,
              total_count: 1,
              total_pages: 1,
            },
          }),
          { status: 200 },
        ),
      )) as typeof fetch,
    async (cfApiPaginatedCursor) => {
      const { results, truncated } = await cfApiPaginatedCursor(
        "test-token",
        "/accounts/acct/storage/kv/namespaces/ns/keys",
      );
      assertEquals(results, [{ id: 1 }]);
      assertEquals(truncated, false);
    },
  );
});

Deno.test("cfApiPaginatedCursor: threads result_info.cursor into the next request", async () => {
  const requestedUrls: string[] = [];
  await withCfApiPaginatedCursor(
    ((url: string) => {
      requestedUrls.push(url);
      const body = url.includes("cursor=abc")
        ? cfBody({
          result: [{ id: 2 }],
          result_info: { page: 2, per_page: 1, total_count: 2, total_pages: 2 },
        })
        : cfBody({
          result: [{ id: 1 }],
          result_info: {
            page: 1,
            per_page: 1,
            total_count: 2,
            total_pages: 2,
            cursor: "abc",
          },
        });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch,
    async (cfApiPaginatedCursor) => {
      const { results, truncated } = await cfApiPaginatedCursor(
        "test-token",
        "/accounts/acct/storage/kv/namespaces/ns/keys",
      );
      assertEquals(results, [{ id: 1 }, { id: 2 }]);
      assertEquals(truncated, false);
      assertEquals(requestedUrls.length, 2);
      assertEquals(requestedUrls[1].includes("cursor=abc"), true);
    },
  );
});

Deno.test("cfApiPaginatedCursor: a caller-supplied initial cursor is sent on the first request", async () => {
  const requestedUrls: string[] = [];
  await withCfApiPaginatedCursor(
    ((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve(
        new Response(
          cfBody({
            result_info: {
              page: 1,
              per_page: 20,
              total_count: 0,
              total_pages: 1,
            },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch,
    async (cfApiPaginatedCursor) => {
      await cfApiPaginatedCursor("test-token", "/accounts/acct/r2/buckets", {
        cursor: "resume-token",
      });
      assertEquals(requestedUrls[0].includes("cursor=resume-token"), true);
    },
  );
});

Deno.test("cfApiPaginatedCursor: marks truncated when MAX_PAGES is reached with a cursor still live", async () => {
  let page = 0;
  await withCfApiPaginatedCursor(
    (() => {
      page++;
      return Promise.resolve(
        new Response(
          cfBody({
            result: [{ id: page }],
            result_info: {
              page,
              per_page: 1,
              total_count: 999,
              total_pages: 999,
              cursor: `next-${page}`,
            },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch,
    async (cfApiPaginatedCursor) => {
      const { results, truncated } = await cfApiPaginatedCursor(
        "test-token",
        "/accounts/acct/storage/kv/namespaces/ns/keys",
      );
      assertEquals(truncated, true);
      assertEquals(results.length, 20); // MAX_PAGES
    },
  );
});

Deno.test("cfApiPaginatedCursor: a response with no result_info at all is marked truncated, not silently complete", async () => {
  await withCfApiPaginatedCursor(
    (() =>
      Promise.resolve(
        new Response(cfBody({ result: [{ id: 1 }] }), { status: 200 }),
      )) as typeof fetch,
    async (cfApiPaginatedCursor) => {
      const { results, truncated } = await cfApiPaginatedCursor(
        "test-token",
        "/accounts/acct/storage/kv/namespaces/ns/keys",
      );
      assertEquals(results, [{ id: 1 }]);
      assertEquals(truncated, true);
    },
  );
});

Deno.test("cfApiPaginatedCursor: a null result on an intermediate page does not throw", async () => {
  await withCfApiPaginatedCursor(
    ((url: string) => {
      const body = url.includes("cursor=abc")
        ? cfBody({
          result: [{ id: 2 }],
          result_info: { page: 2, per_page: 1, total_count: 2, total_pages: 2 },
        })
        : cfBody({
          result: null,
          result_info: {
            page: 1,
            per_page: 1,
            total_count: 2,
            total_pages: 2,
            cursor: "abc",
          },
        });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch,
    async (cfApiPaginatedCursor) => {
      const { results, truncated } = await cfApiPaginatedCursor(
        "test-token",
        "/accounts/acct/storage/kv/namespaces/ns/keys",
      );
      assertEquals(results, [{ id: 2 }]);
      assertEquals(truncated, false);
    },
  );
});

// ---------------------------------------------------------------------------
// README: vault-first credentials and secret-handling notes
// ---------------------------------------------------------------------------

const readmeConfig: ServiceConfig = {
  name: "r2",
  description: "Cloudflare R2",
  pathPrefixes: ["/accounts/{account_id}/r2"],
  scope: "account",
  labels: ["cloudflare"],
};

function readmeMethod(
  name: string,
  type: ClassifiedMethod["type"],
  op: Partial<GroupedOperation>,
): ClassifiedMethod {
  return {
    name,
    type,
    description: name,
    operation: {
      httpMethod: "post",
      path: "/accounts/{account_id}/r2/x",
      operationId: name,
      summary: name,
      description: "",
      pathParams: [],
      queryParams: [],
      isCollection: false,
      usesCursorPagination: false,
      deprecated: false,
      tags: [],
      ...op,
    },
  };
}

Deno.test("generateReadme: credentials go through a vault, never a literal token", () => {
  const readme = generateReadme(readmeConfig, [
    readmeMethod("list_buckets", "list", {}),
  ]);
  assertEquals(
    readme.includes("swamp vault create local_encryption cloudflare"),
    true,
  );
  assertEquals(readme.includes("swamp vault put cloudflare API_TOKEN"), true);
  assertEquals(
    readme.includes(
      `--global-arg 'apiToken=\${{ vault.get("cloudflare", "API_TOKEN") }}'`,
    ),
    true,
  );
  assertEquals(readme.includes("apiToken=CLOUDFLARE_API_TOKEN"), false);
  // The env var appears only as a discouraged fallback.
  assertEquals(
    readme.replace(/\s+/g, " ").includes(
      "Swamp does not redact that variable, so it is not recommended.",
    ),
    true,
  );
  // No method handles a secret, so there is no Secrets section.
  assertEquals(readme.includes("## Secrets"), false);
});

Deno.test("generateSecretsSection: lists secret inputs, vaulted outputs and stripped fields", () => {
  const section = generateSecretsSection([
    readmeMethod("create_store_credentials", "create", {
      inputSecrets: ["token"],
    }),
    readmeMethod("create_temp_access_credentials", "create", {
      responseSchema: {
        type: "object",
        properties: {
          accessKeyId: { type: "string" },
          secretAccessKey: { type: "string", "x-swamp-sensitive": true },
        },
      },
      responseSecrets: {
        wrapRoot: false,
        vaultable: [["secretAccessKey"]],
        leaves: [[{ k: "secretAccessKey" }]],
      },
    }),
    readmeMethod("list_jobs", "list", {
      isCollection: true,
      responseSecrets: {
        wrapRoot: false,
        vaultable: [],
        leaves: [[{ k: "destination_conf" }]],
      },
    }),
  ]);
  assertEquals(section.includes("## Secrets"), true);
  assertEquals(
    section.includes('`${{ vault.get("<vault>", "<KEY>") }}`'),
    true,
  );
  assertEquals(
    section.includes("| `create_store_credentials` | `token` | — | — |"),
    true,
  );
  assertEquals(
    section.includes(
      "| `create_temp_access_credentials` | — | `secretAccessKey` | — |",
    ),
    true,
  );
  assertEquals(
    section.includes("| `list_jobs` | — | — | `destination_conf` |"),
    true,
  );
});

Deno.test("generateApiLib: the missing-token error leads with the vault", () => {
  const lib = generateApiLib();
  const at = lib.indexOf("Cloudflare API token not set");
  const message = lib.slice(at, lib.indexOf(");", at));
  assertEquals(message.includes("vault.get"), true);
  assertEquals(
    message.indexOf("vault.get") < message.indexOf("CLOUDFLARE_API_TOKEN"),
    true,
  );
  assertEquals(message.includes("not recommended"), true);
});

Deno.test("generateApiLib: stripSensitive removes secrets at runtime without touching the input", async () => {
  const lib = generateApiLib();
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmp, lib);
    const { stripSensitive } = await import(`file://${tmp}`);
    const input = {
      jobs: [{ id: 1, destination_conf: "s3://x?secret=1" }],
      env_vars: {
        A: { type: "secret_text", value: "s3cret" },
        B: { type: "plain_text", value: "visible" },
      },
    };
    const out = stripSensitive(input, [
      [{ k: "jobs" }, { each: true }, { k: "destination_conf" }],
      [{ k: "env_vars" }, { values: true }, {
        k: "value",
        when: ["type", "secret_text"],
      }],
    ]);
    assertEquals(out, {
      jobs: [{ id: 1 }],
      env_vars: {
        A: { type: "secret_text" },
        B: { type: "plain_text", value: "visible" },
      },
    });
    // The caller's value is not mutated.
    assertEquals(input.jobs[0].destination_conf, "s3://x?secret=1");
  } finally {
    await Deno.remove(tmp);
  }
});

const vaultedCreate = (name: string) =>
  readmeMethod(name, "create", {
    responseSchema: {
      type: "object",
      properties: { secret: { type: "string", "x-swamp-sensitive": true } },
    },
    responseSecrets: {
      wrapRoot: false,
      vaultable: [["secret"]],
      leaves: [[{ k: "secret" }]],
    },
  });

Deno.test("generateReadme: a model with vaulted output needs a vault for every method", () => {
  const readme = generateReadme(readmeConfig, [
    vaultedCreate("create_widget"),
    readmeMethod("get_widget", "get", {}),
  ]).replace(/\s+/g, " ");
  // swamp infers get_widget's kind from its name: not a read, so it is
  // refused too. The requirement is stated under Credentials and Secrets.
  const sentence =
    "swamp refuses to run any of its methods, reads included, until a vault exists";
  assertEquals(readme.split(sentence).length - 1, 2);
  assertEquals(
    readme.includes("so a vault must exist before you run the method"),
    false,
  );
});

Deno.test("generateReadme: methods named list or get are the only ones exempt", () => {
  const readme = generateReadme(readmeConfig, [
    vaultedCreate("create"),
    readmeMethod("list", "list", { isCollection: true }),
    readmeMethod("get", "get", {}),
  ]).replace(/\s+/g, " ");
  assertEquals(
    readme.includes(
      "swamp refuses to run any of its methods except `list` and `get` until a vault exists",
    ),
    true,
  );
});

Deno.test("generateReadme: secret inputs alone do not demand a vault", () => {
  const readme = generateReadme(readmeConfig, [
    readmeMethod("create_store_credentials", "create", {
      inputSecrets: ["token"],
    }),
  ]);
  assertEquals(readme.includes("## Secrets"), true);
  assertEquals(readme.includes("refuses to run"), false);
  assertEquals(readme.includes("inside a list, map or union"), false);
});
