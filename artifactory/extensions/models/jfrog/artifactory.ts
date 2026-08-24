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

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  url: z.string().url().describe(
    "Artifactory base URL including context path (e.g., https://packages.example.com/artifactory)",
  ),
  token: z.string().min(1).meta({ sensitive: true })
    .describe("vault:// reference to JFrog Identity Token or Access Token"),
});

const HealthSchema = z.object({
  url: z.string().describe("Artifactory base URL that was checked"),
  fetchedAt: z.string().describe("ISO 8601 timestamp when health was checked"),
  ping: z.enum(["ok", "error"]).describe("Result of the ping check"),
  pingLatencyMs: z.number().describe("Ping round-trip latency in milliseconds"),
  health: z.object({
    available: z.boolean().describe("Whether Artifactory is reachable"),
    components: z.array(z.object({
      name: z.string().describe("Component/service name"),
      status: z.string().describe("Component status"),
    })).optional().describe(
      "Per-component health, when the health endpoint is accessible",
    ),
    note: z.string().optional().describe(
      "Explanatory note when health details are unavailable (e.g. 403)",
    ),
  }),
});

const RepoSchema = z.object({
  key: z.string().describe("Repository key/identifier"),
  type: z.string().describe("Repository type (local, remote, virtual)"),
  packageType: z.string().describe("Package format (e.g. maven, npm, docker)"),
  url: z.string().describe("Repository URL"),
  description: z.string().describe("Repository description"),
});

const RepoListSchema = z.object({
  url: z.string().describe("Artifactory base URL that was queried"),
  fetchedAt: z.string().describe("ISO 8601 timestamp when repos were fetched"),
  repos: z.array(RepoSchema).describe("All repositories on the server"),
  totalCount: z.number().describe("Number of repositories returned"),
  truncated: z.boolean().describe(
    "Whether the listing is incomplete (always false — the API is non-paginated)",
  ),
});

const RepoHealthSchema = z.object({
  repoKey: z.string().describe("Repository key/identifier"),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when repo health was fetched",
  ),
  artifactCount: z.number().describe("Number of artifacts/files in the repo"),
  usedSpaceBytes: z.number().describe("Storage used by the repo, in bytes"),
  usedSpace: z.string().describe("Storage used by the repo, human-readable"),
  status: z.enum(["ok", "error"]).describe("Whether health data was retrieved"),
  error: z.string().optional().describe("Error message when status is error"),
});

const PackageResultSchema = z.object({
  queryHash: z.string().describe(
    "Collision-resistant hash of the AQL query, used as the resource instance key",
  ),
  query: z.string().describe("The AQL query that was executed"),
  fetchedAt: z.string().describe("ISO 8601 timestamp when the query ran"),
  results: z.array(z.object({
    repo: z.string().describe("Repository containing the artifact"),
    path: z.string().describe("Artifact path within the repository"),
    name: z.string().describe("Artifact file name"),
    size: z.number().describe("Artifact size in bytes"),
    modified: z.string().describe("Last-modified timestamp"),
    sha256: z.string().optional().describe(
      "Artifact SHA-256 checksum, if known",
    ),
  })).describe("Matching artifacts, up to the query limit"),
  totalCount: z.number().describe(
    "Total matching artifacts reported by Artifactory",
  ),
  truncated: z.boolean().describe(
    "Whether totalCount exceeds the number of results returned",
  ),
});

const PackageDiffSchema = z.object({
  queryHash: z.string().describe(
    "Collision-resistant hash of the AQL query being diffed",
  ),
  fetchedAt: z.string().describe("ISO 8601 timestamp when this diff ran"),
  previousFetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp of the prior scan used as the diff baseline, if any",
  ),
  newPackages: z.array(
    z.object({ repo: z.string(), path: z.string(), name: z.string() }),
  ).describe("Packages present now but not in the previous baseline"),
  removedPackages: z.array(
    z.object({ repo: z.string(), path: z.string(), name: z.string() }),
  ).describe("Packages present in the previous baseline but not now"),
  summary: z.object({
    newCount: z.number().describe("Number of new packages"),
    removedCount: z.number().describe("Number of removed packages"),
  }),
  noBaseline: z.boolean().describe(
    "Whether no prior scan existed to diff against",
  ),
  truncated: z.boolean().describe(
    "Whether the current or baseline scan was truncated, suppressing the diff",
  ),
});

const StorageSchema = z.object({
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when storage info was fetched",
  ),
  usedSpace: z.string().describe("Total used storage, human-readable"),
  freeSpace: z.string().describe("Total free storage, human-readable"),
  totalSpace: z.string().describe("Total storage capacity, human-readable"),
  repoCount: z.number().describe(
    "Number of repositories included in the summary",
  ),
  status: z.enum(["ok", "error", "forbidden"]).describe(
    "Whether storage info was retrieved successfully",
  ),
  error: z.string().optional().describe("Error message when status is not ok"),
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
  const fullUrl = `${opts.url.replace(/\/$/, "")}${path}`;
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

/** Dual FNV-1a hash (48-bit / 12 hex chars) for collision-resistant instance naming. */
function computeQueryHash(input: string): string {
  // Dual FNV-1a: two independent 32-bit FNV-1a passes with swapped constants
  // then take 12 hex chars (48 bits, birthday collision at ~16M queries)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0").slice(0, 4);
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
  version: "2026.08.24.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.1",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
        } catch (e) {
          if (
            (e as Error).message.startsWith("Artifactory authentication failed")
          ) throw e;
        }
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
          } else {
            health.note = `Health endpoint returned HTTP ${status}`;
          }
        } catch (e) {
          if (
            (e as Error).message.startsWith(
              "Artifactory authentication failed",
            )
          ) throw e;
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
          const msg = typeof data === "string" ? data : JSON.stringify(data);
          throw new Error(
            `Failed to list repos from ${url}/api/repositories: HTTP ${status}: ${msg}`,
          );
        }

        const raw = Array.isArray(data) ? data : [];
        const repos = raw.map((r: Record<string, unknown>) => ({
          key: (r.key as string) ?? "",
          type: (r.type as string) ?? "",
          packageType: (r.packageType as string) ?? "",
          url: (r.url as string) ?? "",
          description: (r.description as string) ?? "",
        }));

        const handle = await context.writeResource("repos", "repo-list", {
          url,
          fetchedAt: new Date().toISOString(),
          repos,
          totalCount: repos.length,
          // /api/repositories returns all repos in a single non-paginated array.
          // There is no pagination envelope, token, or total in the response.
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
          if (status === 403) {
            const h = await context.writeResource("repos", "_error", {
              repoKey: "all",
              fetchedAt: new Date().toISOString(),
              artifactCount: 0,
              usedSpaceBytes: 0,
              usedSpace: "unknown",
              status: "error",
              error: "Storage info requires admin token (403)",
            });
            return { dataHandles: [h] };
          }
          const msg = typeof data === "string" ? data : JSON.stringify(data);
          throw new Error(
            `Failed to fetch storage info from ${url}/api/storageinfo (for repo health): HTTP ${status}: ${msg}`,
          );
        }
        const repoList =
          ((data as Record<string, unknown>)?.repositoriesSummaryList ??
            []) as Array<Record<string, unknown>>;
        const repos = args.repoKey
          ? repoList.filter((r) =>
            r.repoKey === args.repoKey && r.repoKey !== "TOTAL"
          )
          : repoList.filter((r) => r.repoKey !== "TOTAL");
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
        query: z.string().min(1, "query must not be empty").describe(
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
        const queryHash = computeQueryHash(args.query);

        context.logger.info("Executing AQL query (hash={hash})", {
          hash: queryHash,
        });

        // Append .limit() if not already in the query
        let aql = args.query;
        aql = aql.replace(/(?<=\))\s*\.limit\(\d+\)/g, "");
        aql += `.limit(${args.limit})`;

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
          totalCount,
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
        query: z.string().min(1, "query must not be empty").describe(
          "AQL query string (same as used in query_packages)",
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
        const queryHash = computeQueryHash(args.query);

        // Read previous result for this query
        let previousResults: Array<
          { repo: string; path: string; name: string }
        > = [];
        let previousFetchedAt: string | undefined;
        let hasPriorScan = false;
        if (context.readResource) {
          try {
            const prev = await context.readResource(queryHash);
            if (prev && Array.isArray(prev.results) && !prev.truncated) {
              hasPriorScan = true;
              previousResults = (prev.results as Array<Record<string, string>>)
                .map((r) => ({
                  repo: r.repo ?? "",
                  path: r.path ?? "",
                  name: r.name ?? "",
                }));
              previousFetchedAt = (prev.fetchedAt as string) ?? undefined;
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
        aql = aql.replace(/(?<=\))\s*\.limit\(\d+\)/g, "");
        aql += `.limit(${args.limit})`;
        const { status, data } = await rtfApi(
          "POST",
          "/api/search/aql",
          opts,
          aql,
        );

        if (status !== 200) {
          const msg = typeof data === "string" ? data : JSON.stringify(data);
          throw new Error(
            `AQL query failed (hash=${queryHash}, ${status}): ${msg}`,
          );
        }

        const raw = data as Record<string, unknown>;
        const results = (raw.results ?? []) as Array<Record<string, unknown>>;
        const range = raw.range as Record<string, number> | undefined;
        const totalCount = range?.total ?? results.length;
        const truncated = totalCount > results.length;

        const currentResults = results.map((r) => ({
          repo: (r.repo as string) ?? "",
          path: (r.path as string) ?? "",
          name: (r.name as string) ?? "",
        }));

        // Diff by repo+path+name composite key
        const toKey = (r: { repo: string; path: string; name: string }) =>
          `${r.repo}\x00${r.path}\x00${r.name}`;
        const previousKeys = new Set(previousResults.map(toKey));
        const currentKeys = new Set(currentResults.map(toKey));

        const noBaseline = !hasPriorScan;
        const suppressDiff = truncated || noBaseline;

        const newPackages = suppressDiff
          ? []
          : currentResults.filter((r) => !previousKeys.has(toKey(r)));
        const removedPackages = suppressDiff
          ? []
          : previousResults.filter((r) => !currentKeys.has(toKey(r)));

        // Only update baseline when current fetch is complete (not truncated).
        // Writing a truncated result as baseline corrupts future diffs.
        if (!truncated) {
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
              sha256: (r.actual_sha256 as string) ?? (r.sha256 as string) ??
                undefined,
            })),
            totalCount,
            truncated: false,
          });
        }

        const diffHandle = await context.writeResource(
          "package-diff",
          `diff-${queryHash}`,
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
            const msg = typeof data === "string" ? data : JSON.stringify(data);
            throw new Error(
              `Failed to fetch storage info from ${url}/api/storageinfo: HTTP ${status}: ${msg}`,
            );
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
            repoCount: Array.isArray(repos)
              ? (repos as Array<Record<string, unknown>>).filter((r) =>
                r.repoKey !== "TOTAL"
              ).length
              : 0,
            status: "ok",
          });

          context.logger.info("Storage info: {used} used, {free} free", {
            used: d.usedSpace ?? "unknown",
            free: d.freeSpace ?? "unknown",
          });
          return { dataHandles: [handle] };
        } catch (e) {
          if (
            (e as Error).message.startsWith("Artifactory authentication failed")
          ) throw e;
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
