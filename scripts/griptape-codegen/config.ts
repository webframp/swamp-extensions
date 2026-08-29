/**
 * Griptape Cloud codegen configuration.
 *
 * Defines how OpenAPI paths map to swamp extension directories, which resource
 * families to generate (tier-1), and shared constants.
 *
 * Unlike the Cloudflare generator — which pins its spec by git SHA — Griptape
 * publishes its OpenAPI document as a mutable S3 object with no version in the
 * URL (the `info.version` is a static API-contract date, not a release tag). We
 * therefore pin by SHA-256 of the fetched YAML body: reproducible builds plus a
 * clear "the upstream spec changed" signal. Update with:
 *   deno task bump -- --update-spec
 */

/** Griptape Cloud OpenAPI spec location (public S3 asset). */
export const SCHEMA_URL =
  "https://griptape-cloud-assets.s3.amazonaws.com/Griptape.openapi.yaml";

/**
 * SHA-256 of the pinned spec body (lowercase hex).
 *
 * `deno task generate` verifies the fetched spec against this hash and refuses
 * to generate from an unexpected document. `deno task bump -- --update-spec`
 * re-fetches, prints the old/new hash, and rewrites this constant.
 */
export const SPEC_SHA256 =
  "189b319ab221116f898d000e1342d02bbba6adf2ecf53d8dc9c621a598f5a083";

/** Where generated extensions land, relative to the codegen dir (cwd). */
export const OUTPUT_BASE = "../../griptape";

/** Base URL Griptape Cloud serves the API from (spec `servers[0].url`). */
export const GRIPTAPE_API_BASE = "https://cloud.griptape.ai/api";

/** Zod version to use in generated code. Must match the repo-wide pin. */
export const ZOD_VERSION = "4.4.3";

/** swamp-testing version for generated test files. */
export const SWAMP_TESTING_VERSION = "0.20260604.20";

/** Max pagination pages (safety cap; matches sibling generators). */
export const MAX_PAGES = 20;

/**
 * Service definition — maps a logical Griptape resource family to an extension.
 *
 * Griptape Cloud has a single API scope (organization-wide, keyed by the Bearer
 * API key), so there is no account/zone scope switch like Cloudflare. Every
 * generated model takes the same globalArgs: `apiKey` (sensitive, vault-
 * wireable) and an optional `baseUrl` override.
 */
export interface ServiceConfig {
  /** Extension directory name under OUTPUT_BASE (e.g., "threads"). */
  name: string;
  /** Human-readable description for the manifest. */
  description: string;
  /** OpenAPI path prefixes that group endpoints into this service. */
  pathPrefixes: string[];
  /** Paths to exclude even if they match a prefix. */
  excludePaths?: string[];
  /** Labels for the manifest. */
  labels: string[];
}

/**
 * Master service registry — tier 1.
 *
 * The codegen produces only the families listed here; unlisted paths are
 * silently skipped. The registry is additive: admin/billing surface
 * (organizations, billing, credits, licenses, invites, usage, sessions) is
 * deliberately excluded from tier 1 and can be added later without touching the
 * generator.
 *
 * Order affects only README rendering, not generation.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "threads",
    description:
      "Griptape Cloud Threads — conversation threads and their messages",
    pathPrefixes: ["/api/threads"],
    labels: ["griptape", "threads", "conversation", "ai"],
  },
  {
    name: "assistants",
    description:
      "Griptape Cloud Assistants — assistant definitions and assistant runs",
    pathPrefixes: ["/api/assistants", "/api/assistant-runs"],
    labels: ["griptape", "assistants", "agents", "ai"],
  },
  {
    name: "structures",
    description:
      "Griptape Cloud Structures — deployed structures, runs, logs, and spans",
    pathPrefixes: ["/api/structures", "/api/structure-runs"],
    labels: ["griptape", "structures", "workflows", "ai"],
  },
  {
    name: "knowledge-bases",
    description:
      "Griptape Cloud Knowledge Bases — RAG knowledge bases, queries, searches, and index jobs",
    pathPrefixes: [
      "/api/knowledge-bases",
      "/api/knowledge-base-jobs",
      "/api/knowledge-base-queries",
      "/api/knowledge-base-searches",
    ],
    labels: ["griptape", "knowledge-bases", "rag", "retrieval"],
  },
  {
    name: "rulesets",
    description:
      "Griptape Cloud Rulesets — behavioral rulesets and their rules",
    pathPrefixes: ["/api/rulesets", "/api/rules"],
    labels: ["griptape", "rulesets", "governance", "ai"],
  },
  {
    name: "tools",
    description:
      "Griptape Cloud Tools — hosted tools, activities, deployments, and tool runs",
    pathPrefixes: ["/api/tools", "/api/tool-runs"],
    labels: ["griptape", "tools", "agents", "ai"],
  },
  {
    name: "data-connectors",
    description:
      "Griptape Cloud Data Connectors — data source connectors and ingest jobs",
    pathPrefixes: ["/api/data-connectors", "/api/data-jobs"],
    labels: ["griptape", "data-connectors", "ingest", "etl"],
  },
  {
    name: "buckets",
    description:
      "Griptape Cloud Buckets — asset buckets and their stored assets",
    pathPrefixes: ["/api/buckets"],
    labels: ["griptape", "buckets", "storage", "assets"],
  },
  {
    name: "secrets",
    description: "Griptape Cloud Secrets — organization secret management",
    pathPrefixes: ["/api/secrets"],
    labels: ["griptape", "secrets", "credentials"],
  },
  {
    name: "models",
    description:
      "Griptape Cloud Models — model configurations and provider auth configs",
    pathPrefixes: ["/api/models"],
    labels: ["griptape", "models", "llm", "configuration"],
  },
];

/** Get today's CalVer version. */
export function calver(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}.1`;
}
