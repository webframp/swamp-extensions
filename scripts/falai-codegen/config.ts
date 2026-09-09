/**
 * fal.ai codegen configuration.
 *
 * Defines how OpenAPI tags/paths map to swamp extension directories,
 * which services to generate, and shared constants.
 */

/** Live URL for the fal.ai Platform APIs OpenAPI spec (OpenAPI 3.1). */
export const SCHEMA_URL = "https://api.fal.ai/v1/openapi.json";

/** Where generated extensions land, relative to the codegen dir (cwd). */
export const OUTPUT_BASE = "../../falai";

/** Zod version to use in generated code */
export const ZOD_VERSION = "4.4.3";

/** swamp-testing version */
export const SWAMP_TESTING_VERSION = "0.20260604.20";

/** Max pagination pages (matches project-wide bounded-pagination rule) */
export const MAX_PAGES = 20;

/**
 * Service definition — maps a logical fal.ai service to an extension.
 *
 * fal.ai has no account/zone/org path-scoping: every path is global to the
 * caller's API key, so unlike the Cloudflare and Snyk codegens there is no
 * `scope` field here — no globalArgs beyond the API token are ever needed.
 *
 * A path belongs to a service when it matches EITHER `pathPrefixes` OR `tags`
 * (union, not intersection) — see service_grouper.ts.
 */
export interface ServiceConfig {
  /** Extension directory name under OUTPUT_BASE (e.g., "assets", "compute") */
  name: string;
  /** Human-readable description for the manifest */
  description: string;
  /** Path prefixes that group endpoints into this service */
  pathPrefixes?: string[];
  /** OpenAPI tags that group endpoints into this service */
  tags?: string[];
  /** Labels for the manifest */
  labels: string[];
  /** Skip these specific paths even if they match prefixes/tags */
  excludePaths?: string[];
}

/**
 * Master service registry.
 *
 * Add entries here to generate new extensions. The codegen will only produce
 * extensions listed in this registry — unlisted services are silently skipped.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "account",
    description:
      "fal.ai Account — billing, focus reports, model access controls, and account metadata",
    tags: ["Account", "Meta"],
    labels: ["falai", "account", "billing"],
  },
  {
    name: "assets",
    description:
      "fal.ai Assets — media library, characters, collections, tags, uploads, favorites",
    tags: ["Assets"],
    labels: ["falai", "assets", "media"],
  },
  {
    name: "compute",
    description: "fal.ai Compute — dedicated GPU compute instances",
    tags: ["Compute"],
    labels: ["falai", "compute", "gpu"],
  },
  {
    name: "keys",
    description: "fal.ai API Keys — key management",
    tags: ["Keys"],
    labels: ["falai", "keys", "auth"],
  },
  {
    name: "models",
    description:
      "fal.ai Models — model catalog, pricing, analytics, usage, billing events, request search",
    tags: ["Models"],
    labels: ["falai", "models", "pricing", "analytics"],
  },
  {
    name: "organization",
    description:
      "fal.ai Organization — teams, usage, billing events, focus reports",
    tags: ["Organization"],
    labels: ["falai", "organization", "teams"],
  },
  {
    name: "serverless",
    description:
      "fal.ai Serverless — app deployments, queue, revisions, files, logs, metrics, requests, usage",
    pathPrefixes: ["/serverless"],
    labels: ["falai", "serverless", "apps", "deployment"],
  },
  {
    name: "storage",
    description: "fal.ai Storage — file ACLs, signed URLs, storage settings",
    tags: ["Storage"],
    labels: ["falai", "storage", "files"],
  },
  {
    name: "workflows",
    description: "fal.ai Workflows — workflow definitions",
    tags: ["Workflows"],
    labels: ["falai", "workflows"],
  },
];

/** Get today's CalVer version */
export function calver(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}.1`;
}
