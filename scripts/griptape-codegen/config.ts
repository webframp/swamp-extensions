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
  "f06100fe330a59a7c052b5978fdf55f93e3ab5887cfecf1feddb7e76114a0032";

/** Where generated extensions land, relative to the codegen dir (cwd). */
export const OUTPUT_BASE = "../../griptape";

/**
 * Base URL Griptape Cloud serves the API from.
 *
 * NOTE: the spec's `servers[0].url` is `https://cloud.griptape.ai/api`, but the
 * spec's paths ALSO carry the `/api` prefix (e.g. `/api/threads`). Concatenating
 * the server URL with a path would double the prefix
 * (`.../api/api/threads` → 404). We emit the paths verbatim, so the base must be
 * the origin only, WITHOUT `/api`.
 */
export const GRIPTAPE_API_BASE = "https://cloud.griptape.ai";

/** Zod version to use in generated code. Must match the repo-wide pin. */
export const ZOD_VERSION = "4.6.7";

/** swamp-testing version for generated test files. */
export const SWAMP_TESTING_VERSION = "0.20261030.68";

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
  /**
   * Whether a bare top-level `value` field is a credential. Defaults to true:
   * the secrets family stores its secret there, and over-redacting is the safe
   * failure. Set false where `value` is ordinary data (tag values), otherwise
   * the field is vaulted and the real value is lost to readers.
   */
  valueIsSecret?: boolean;
}

/**
 * Master service registry.
 *
 * The codegen produces only the families listed here. Every other API family
 * must appear in DECLINED_FAMILIES with a reason; an unclassified family fails
 * `generate` and `bump -- --check`. Adding a family is a registry entry —
 * nothing in the generator changes.
 *
 * Order affects only README rendering, not generation.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "threads",
    description:
      "Griptape Cloud Threads — conversation threads and their messages",
    pathPrefixes: ["/api/threads", "/api/messages"],
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
  {
    name: "retrievers",
    description:
      "Griptape Cloud Retrievers — retrievers, retriever components, and libraries",
    pathPrefixes: [
      "/api/retrievers",
      "/api/retriever-components",
      "/api/libraries",
    ],
    labels: ["griptape", "retrievers", "rag", "libraries"],
  },
  {
    name: "integrations",
    description:
      "Griptape Cloud Integrations — integrations and their outbound connections",
    pathPrefixes: ["/api/integrations", "/api/connections"],
    labels: ["griptape", "integrations", "connections"],
  },
  {
    name: "tags",
    description: "Griptape Cloud Tags — tag profiles and tag listings",
    pathPrefixes: ["/api/tag-profiles", "/api/tags"],
    labels: ["griptape", "tags", "governance"],
    valueIsSecret: false,
  },
  {
    name: "import-export",
    description: "Griptape Cloud Import/Export — import jobs and export jobs",
    pathPrefixes: ["/api/import-jobs", "/api/export-jobs"],
    labels: ["griptape", "import", "export", "jobs"],
  },
  {
    name: "observability",
    description:
      "Griptape Cloud Observability — dashboards, platform config, events, and deployments",
    pathPrefixes: [
      "/api/dashboards",
      "/api/config",
      "/api/events",
      "/api/deployments",
    ],
    labels: ["griptape", "observability", "dashboards", "events"],
  },
];

/**
 * Top-level API families (first two path segments) that are deliberately NOT
 * generated, each with the reason.
 *
 * Every family in the spec must be claimed by a SERVICES entry or listed here.
 * `deno task generate` and `deno task bump -- --check` fail on a family that is
 * neither, so a new upstream family forces an explicit claim-or-decline
 * decision instead of silently going uncovered.
 */
export const DECLINED_FAMILIES: Record<string, string> = {
  // Administration, billing, and entitlement — out of scope since tier 1.
  "/api/organizations": "administration",
  "/api/users": "administration",
  "/api/invites": "administration",
  "/api/api-keys":
    "administration; key management returns one-time credentials",
  "/api/licenses": "billing/entitlement",
  "/api/license-groups": "billing/entitlement",
  "/api/license-info": "billing/entitlement",
  "/api/entitlement-policies": "billing/entitlement",
  "/api/managed-policies": "billing/entitlement",
  "/api/billing": "billing",
  "/api/credits": "billing",
  "/api/budgets": "billing",
  "/api/budget-alerts": "billing",
  "/api/budget-checks": "billing",
  "/api/spend": "billing",
  "/api/spend-exports": "billing",
  "/api/usage": "billing",
  // Runtime/session plumbing, not managed resources.
  "/api/sessions": "runtime session plumbing",
  "/api/session-pools": "runtime session plumbing",
  "/api/session-release": "runtime session plumbing",
  "/api/session-renew": "runtime session plumbing",
  "/api/engines":
    "Griptape Nodes engine self-registration (PUT of engine runtime state)",
  // Billable invocation rather than managed state.
  "/api/chat":
    "stateless billable LLM invocation; requires inline tools and output schema",
};

/** Get today's CalVer version. */
export function calver(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}.1`;
}
