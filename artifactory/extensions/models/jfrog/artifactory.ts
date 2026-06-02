/**
 * JFrog Artifactory model — query packages, monitor repository health,
 * and detect package changes from a consumer perspective.
 *
 * Uses AQL for flexible package queries and REST API for health/repo status.
 * One model instance per Artifactory server, data accumulates per-repo.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  url: z.string().url().describe(
    "Artifactory base URL including context path (e.g., https://packages.example.com/artifactory)",
  ),
  token: z.string().meta({ sensitive: true })
    .describe("vault:// reference to JFrog Identity Token or Access Token"),
});

const HealthSchema = z.object({
  url: z.string(),
  fetchedAt: z.string(),
  ping: z.enum(["ok", "error"]),
  pingLatencyMs: z.number(),
  health: z.object({
    available: z.boolean(),
    components: z.array(z.object({
      name: z.string(),
      status: z.string(),
    })).optional(),
    note: z.string().optional(),
  }),
});

const RepoSchema = z.object({
  key: z.string(),
  type: z.string(),
  packageType: z.string(),
  url: z.string(),
  description: z.string(),
});

const RepoListSchema = z.object({
  url: z.string(),
  fetchedAt: z.string(),
  repos: z.array(RepoSchema),
  totalCount: z.number(),
  truncated: z.boolean(),
});

const RepoHealthSchema = z.object({
  repoKey: z.string(),
  fetchedAt: z.string(),
  artifactCount: z.number(),
  usedSpaceBytes: z.number(),
  usedSpace: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
});

const PackageResultSchema = z.object({
  queryHash: z.string(),
  query: z.string(),
  fetchedAt: z.string(),
  results: z.array(z.object({
    repo: z.string(),
    path: z.string(),
    name: z.string(),
    size: z.number(),
    modified: z.string(),
    sha256: z.string().optional(),
  })),
  totalCount: z.number(),
  truncated: z.boolean(),
});

const PackageDiffSchema = z.object({
  queryHash: z.string(),
  fetchedAt: z.string(),
  previousFetchedAt: z.string(),
  newPackages: z.array(
    z.object({ repo: z.string(), path: z.string(), name: z.string() }),
  ),
  removedPackages: z.array(
    z.object({ repo: z.string(), path: z.string(), name: z.string() }),
  ),
  summary: z.object({
    newCount: z.number(),
    removedCount: z.number(),
  }),
  noBaseline: z.boolean(),
  truncated: z.boolean(),
});

const StorageSchema = z.object({
  fetchedAt: z.string(),
  usedSpace: z.string(),
  freeSpace: z.string(),
  totalSpace: z.string(),
  repoCount: z.number(),
  status: z.enum(["ok", "error", "forbidden"]),
  error: z.string().optional(),
});

// =============================================================================
// HTTP Client
// =============================================================================

interface ApiOpts {
  url: string;
  token: string;
}

async function rtfApi(
  method: string,
  path: string,
  opts: ApiOpts,
  body?: string,
): Promise<{ status: number; data: unknown }> {
  const fullUrl = `${opts.url}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${opts.token}`,
  };
  const fetchOpts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "text/plain";
    fetchOpts.body = body;
  }

  const resp = await fetch(fullUrl, fetchOpts);
  const status = resp.status;

  if (status === 401) {
    await resp.body?.cancel();
    throw new Error(
      "Artifactory authentication failed (401). Token may be expired. " +
        "Generate a new Identity Token and update your vault.",
    );
  }

  const text = await resp.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch { /* keep as text */ }

  return { status, data };
}

/** FNV-1a hash for deterministic instance naming from query strings. */
function fnvHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// =============================================================================
// Context
// =============================================================================

type MethodContext = {
  globalArgs: { url: string; token: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource?: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn?: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model
// =============================================================================

/** JFrog Artifactory model for package management and health monitoring. */
export const model = {
  type: "@webframp/artifactory",
  version: "2026.06.02.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    health: {
      description: "System health and ping status",
      schema: HealthSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    repos: {
      description: "Repository listing and per-repo health",
      schema: z.union([RepoListSchema, RepoHealthSchema]),
      lifetime: "24h" as const,
      garbageCollection: 20,
    },
    packages: {
      description: "AQL query results",
      schema: PackageResultSchema,
      lifetime: "24h" as const,
      garbageCollection: 10,
    },
    "package-diff": {
      description: "Package change detection between scans",
      schema: PackageDiffSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    storage: {
      description: "Global storage information",
      schema: StorageSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    system_health: {
      description:
        "Check Artifactory availability via ping and best-effort health details",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { url, token } = context.globalArgs;
        const opts = { url, token };

        context.logger.info("Checking health of {url}", { url });

        // Ping (always works for any authenticated user)
        const pingStart = Date.now();
        let ping: "ok" | "error" = "error";
        try {
          const { status } = await rtfApi("GET", "/api/system/ping", opts);
          if (status === 200) ping = "ok";
        } catch { /* ping failed */ }
        const pingLatencyMs = Date.now() - pingStart;

        // Health details (may 403 for non-admin)
        let health: {
          available: boolean;
          components?: Array<{ name: string; status: string }>;
          note?: string;
        } = {
          available: ping === "ok",
        };
        try {
          const { status, data } = await rtfApi(
            "GET",
            "/api/system/health",
            opts,
          );
          if (status === 200 && typeof data === "object" && data !== null) {
            const d = data as Record<string, unknown>;
            health = {
              available: true,
              components: Array.isArray(d.components)
                ? (d.components as Array<Record<string, string>>).map((c) => ({
                  name: c.service_id ?? c.name ?? "unknown",
                  status: c.state ?? c.status ?? "unknown",
                }))
                : undefined,
            };
          } else if (status === 403) {
            health.note =
              "Health details require admin token (403). Ping succeeded.";
          }
        } catch {
          health.note =
            "Health endpoint unreachable. Ping status used as fallback.";
        }

        const handle = await context.writeResource("health", "result", {
          url,
          fetchedAt: new Date().toISOString(),
          ping,
          pingLatencyMs,
          health,
        });

        context.logger.info("Health check: ping={ping} latency={ms}ms", {
          ping,
          ms: pingLatencyMs,
        });
        return { dataHandles: [handle] };
      },
    },

    list_repos: {
      description: "List all repositories with type and package type",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { url, token } = context.globalArgs;
        const opts = { url, token };

        context.logger.info("Listing repositories on {url}", { url });
        const { status, data } = await rtfApi("GET", "/api/repositories", opts);

        if (status !== 200) {
          throw new Error(`Failed to list repos: HTTP ${status}`);
        }

        const raw = Array.isArray(data) ? data : [];
        const repos = raw.map((r: Record<string, unknown>) => ({
          key: (r.key as string) ?? "",
          type: (r.type as string) ?? "",
          packageType: (r.packageType as string) ?? "",
          url: (r.url as string) ?? "",
          description: (r.description as string) ?? "",
        }));

        const handle = await context.writeResource("repos", "all", {
          url,
          fetchedAt: new Date().toISOString(),
          repos,
          totalCount: repos.length,
          truncated: false,
        });

        context.logger.info("Found {count} repositories", {
          count: repos.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_repo_health: {
      description:
        "Get per-repo artifact count and storage (single API call, fan-out output)",
      arguments: z.object({
        repoKey: z.string().optional().describe(
          "Specific repo. Omit to scan all.",
        ),
      }),
      execute: async (args: { repoKey?: string }, context: MethodContext) => {
        const { url, token } = context.globalArgs;
        const opts = { url, token };
        const handles: Array<{ name: string }> = [];
        context.logger.info("Fetching repo health data", {});
        const { status, data } = await rtfApi("GET", "/api/storageinfo", opts);
        if (status !== 200) {
          throw new Error(`Storage info failed: HTTP ${status}`);
        }
        const repoList =
          ((data as Record<string, unknown>)?.repositoriesSummaryList ??
            []) as Array<Record<string, unknown>>;
        const repos = args.repoKey
          ? repoList.filter((r) => r.repoKey === args.repoKey)
          : repoList;
        for (const r of repos) {
          const key = (r.repoKey as string) ?? "unknown";
          const handle = await context.writeResource("repos", key, {
            repoKey: key,
            fetchedAt: new Date().toISOString(),
            artifactCount: (r.filesCount as number) ?? 0,
            usedSpaceBytes: (r.usedSpaceInBytes as number) ?? 0,
            usedSpace: (r.usedSpace as string) ?? "0 bytes",
            status: "ok",
          });
          handles.push(handle);
        }
        if (args.repoKey && repos.length === 0) {
          const handle = await context.writeResource("repos", args.repoKey, {
            repoKey: args.repoKey,
            fetchedAt: new Date().toISOString(),
            artifactCount: 0,
            usedSpaceBytes: 0,
            usedSpace: "unknown",
            status: "error",
            error: `Repo '${args.repoKey}' not found in storage info`,
          });
          handles.push(handle);
        }
        context.logger.info("Repo health: {count} repos", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    query_packages: {
      description:
        "Execute an AQL query and store results (keyed by query hash for diffing)",
      arguments: z.object({
        query: z.string().describe(
          'AQL query string (e.g., items.find({"repo":"my-repo"}))',
        ),
        limit: z.number().int().min(1).max(10000).default(1000)
          .describe("Maximum results to return"),
      }),
      execute: async (
        args: { query: string; limit: number },
        context: MethodContext,
      ) => {
        const { url, token } = context.globalArgs;
        const opts = { url, token };
        const queryHash = fnvHash(args.query);

        context.logger.info("Executing AQL query (hash={hash})", {
          hash: queryHash,
        });

        // Append .limit() if not already in the query
        let aql = args.query;
        if (!aql.includes(".limit(")) {
          aql += `.limit(${args.limit})`;
        }

        const { status, data } = await rtfApi(
          "POST",
          "/api/search/aql",
          opts,
          aql,
        );

        if (status !== 200) {
          const msg = typeof data === "string" ? data : JSON.stringify(data);
          throw new Error(`AQL query failed (${status}): ${msg}`);
        }

        const raw = data as Record<string, unknown>;
        const results = (raw.results ?? []) as Array<Record<string, unknown>>;
        const range = raw.range as Record<string, number> | undefined;
        const totalCount = range?.total ?? results.length;
        const truncated = totalCount > results.length;

        const mapped = results.map((r) => ({
          repo: (r.repo as string) ?? "",
          path: (r.path as string) ?? "",
          name: (r.name as string) ?? "",
          size: (r.size as number) ?? 0,
          modified: (r.modified as string) ?? "",
          sha256: (r.actual_sha256 as string) ?? (r.sha256 as string) ??
            undefined,
        }));

        const handle = await context.writeResource("packages", queryHash, {
          queryHash,
          query: args.query,
          fetchedAt: new Date().toISOString(),
          results: mapped,
          totalCount: mapped.length,
          truncated,
        });

        context.logger.info(
          "AQL returned {count} results (truncated={truncated})",
          {
            count: mapped.length,
            truncated,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    diff_packages: {
      description:
        "Compare current AQL results against previous run for the same query",
      arguments: z.object({
        query: z.string().describe(
          "AQL query string (same as used in query_packages)",
        ),
        limit: z.number().int().min(1).max(10000).default(1000),
      }),
      execute: async (
        args: { query: string; limit: number },
        context: MethodContext,
      ) => {
        const { url, token } = context.globalArgs;
        const opts = { url, token };
        const queryHash = fnvHash(args.query);

        // Read previous result for this query
        let previousResults: Array<
          { repo: string; path: string; name: string }
        > = [];
        let previousFetchedAt = "";
        if (context.readResource) {
          try {
            const prev = await context.readResource(queryHash);
            if (prev && Array.isArray(prev.results)) {
              previousResults = (prev.results as Array<Record<string, string>>)
                .map((r) => ({
                  repo: r.repo ?? "",
                  path: r.path ?? "",
                  name: r.name ?? "",
                }));
              previousFetchedAt = (prev.fetchedAt as string) ?? "";
            }
          } catch {
            if (context.logger.warn) {
              context.logger.warn(
                "Could not read previous scan for query {hash}",
                { hash: queryHash },
              );
            }
          }
        }

        // Run current query
        let aql = args.query;
        if (!aql.includes(".limit(")) aql += `.limit(${args.limit})`;
        const { status, data } = await rtfApi(
          "POST",
          "/api/search/aql",
          opts,
          aql,
        );

        if (status !== 200) {
          throw new Error(`AQL query failed (${status})`);
        }

        const raw = data as Record<string, unknown>;
        const results = (raw.results ?? []) as Array<Record<string, unknown>>;
        const range = raw.range as Record<string, number> | undefined;
        const truncated = (range?.total ?? 0) > results.length;

        const currentResults = results.map((r) => ({
          repo: (r.repo as string) ?? "",
          path: (r.path as string) ?? "",
          name: (r.name as string) ?? "",
        }));

        // Diff by repo+path+name composite key
        const toKey = (r: { repo: string; path: string; name: string }) =>
          `${r.repo}/${r.path}/${r.name}`;
        const previousKeys = new Set(previousResults.map(toKey));
        const currentKeys = new Set(currentResults.map(toKey));

        const noBaseline = previousResults.length === 0 &&
          currentResults.length > 0;
        const suppressDiff = truncated || noBaseline;

        const newPackages = suppressDiff
          ? []
          : currentResults.filter((r) => !previousKeys.has(toKey(r)));
        const removedPackages = suppressDiff
          ? []
          : previousResults.filter((r) => !currentKeys.has(toKey(r)));

        // Store current as new baseline
        await context.writeResource("packages", queryHash, {
          queryHash,
          query: args.query,
          fetchedAt: new Date().toISOString(),
          results: results.map((r) => ({
            repo: (r.repo as string) ?? "",
            path: (r.path as string) ?? "",
            name: (r.name as string) ?? "",
            size: (r.size as number) ?? 0,
            modified: (r.modified as string) ?? "",
            sha256: (r.actual_sha256 as string) ?? undefined,
          })),
          totalCount: currentResults.length,
          truncated,
        });

        const diffHandle = await context.writeResource(
          "package-diff",
          queryHash,
          {
            queryHash,
            fetchedAt: new Date().toISOString(),
            previousFetchedAt,
            newPackages,
            removedPackages,
            summary: {
              newCount: newPackages.length,
              removedCount: removedPackages.length,
            },
            noBaseline,
            truncated,
          },
        );

        context.logger.info(
          "Package diff: {new} new, {removed} removed (noBaseline={noBaseline})",
          {
            new: newPackages.length,
            removed: removedPackages.length,
            noBaseline,
          },
        );
        return { dataHandles: [diffHandle] };
      },
    },

    get_storage_info: {
      description: "Get global storage summary (may require admin token)",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { url, token } = context.globalArgs;
        const opts = { url, token };

        context.logger.info("Fetching storage info from {url}", { url });

        try {
          const { status, data } = await rtfApi(
            "GET",
            "/api/storageinfo",
            opts,
          );

          if (status === 403) {
            const handle = await context.writeResource("storage", "result", {
              fetchedAt: new Date().toISOString(),
              usedSpace: "unknown",
              freeSpace: "unknown",
              totalSpace: "unknown",
              repoCount: 0,
              status: "forbidden",
              error: "Storage info requires admin token (403)",
            });
            return { dataHandles: [handle] };
          }

          if (status !== 200) {
            throw new Error(`Storage info failed: HTTP ${status}`);
          }

          const d =
            (data as Record<string, unknown>)?.fileStoreSummary as Record<
              string,
              unknown
            > ?? {};
          const repos = (data as Record<string, unknown>)
            ?.repositoriesSummaryList as unknown[];

          const handle = await context.writeResource("storage", "result", {
            fetchedAt: new Date().toISOString(),
            usedSpace: (d.usedSpace as string) ?? "unknown",
            freeSpace: (d.freeSpace as string) ?? "unknown",
            totalSpace: (d.totalSpace as string) ?? "unknown",
            repoCount: Array.isArray(repos) ? repos.length : 0,
            status: "ok",
          });

          context.logger.info("Storage info: {used} used, {free} free", {
            used: d.usedSpace ?? "unknown",
            free: d.freeSpace ?? "unknown",
          });
          return { dataHandles: [handle] };
        } catch (e) {
          if ((e as Error).message.includes("401")) throw e;
          const handle = await context.writeResource("storage", "result", {
            fetchedAt: new Date().toISOString(),
            usedSpace: "unknown",
            freeSpace: "unknown",
            totalSpace: "unknown",
            repoCount: 0,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
