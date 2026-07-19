/**
 * Cloudflare codegen configuration.
 *
 * Defines how OpenAPI tags/paths map to swamp extension directories,
 * which services to generate, and shared constants.
 */

/**
 * Git SHA pinning the Cloudflare OpenAPI spec.
 *
 * Pin to a specific commit for reproducible builds. Update with:
 *   deno task bump -- --update-sha
 *
 * Or manually: check https://github.com/cloudflare/api-schemas/commits/main
 */
export const SCHEMA_SHA = "29f8cda983dbd30c426fcc9d2767b2548409ac46";

/** Base URL for fetching the OpenAPI spec */
export const SCHEMA_URL =
  `https://raw.githubusercontent.com/cloudflare/api-schemas/${SCHEMA_SHA}/openapi.json`;

/** Where generated extensions land relative to repo root */
export const OUTPUT_BASE = "cloudflare";

/** Zod version to use in generated code */
export const ZOD_VERSION = "4.4.3";

/** swamp-testing version */
export const SWAMP_TESTING_VERSION = "0.20260504.10";

/** Max pagination pages (matches existing extensions) */
export const MAX_PAGES = 20;

/**
 * Service definition — maps a logical Cloudflare service to an extension.
 *
 * pathPrefixes: OpenAPI path prefixes that belong to this service
 * tags: OpenAPI tags that belong to this service (alternative/supplement to paths)
 * scope: what globalArgs the extension needs
 * description: manifest description
 * labels: manifest labels
 */
export interface ServiceConfig {
  /** Extension directory name under OUTPUT_BASE (e.g., "r2", "kv", "pages") */
  name: string;
  /** Human-readable description for the manifest */
  description: string;
  /** Path prefixes that group endpoints into this service */
  pathPrefixes: string[];
  /** Optional tag matches (if pathPrefixes aren't sufficient) */
  tags?: string[];
  /** The scope of API access — determines globalArgs */
  scope: "account" | "zone" | "user";
  /** Labels for the manifest */
  labels: string[];
  /** Skip these specific paths even if they match prefixes */
  excludePaths?: string[];
}

/**
 * Master service registry.
 *
 * Add entries here to generate new extensions. The codegen will only produce
 * extensions listed in this registry — unlisted services are silently skipped.
 *
 * Order doesn't matter for generation but affects the README rendering.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "r2",
    description:
      "Cloudflare R2 object storage — buckets, objects, multipart uploads, notifications",
    pathPrefixes: ["/accounts/{account_id}/r2"],
    scope: "account",
    labels: ["cloudflare", "r2", "storage", "s3-compatible"],
  },
  {
    name: "kv",
    description:
      "Cloudflare Workers KV — namespaces, keys, values, bulk operations",
    pathPrefixes: ["/accounts/{account_id}/storage/kv"],
    scope: "account",
    labels: ["cloudflare", "kv", "key-value", "workers"],
  },
  {
    name: "d1",
    description: "Cloudflare D1 serverless SQL databases — databases, queries",
    pathPrefixes: ["/accounts/{account_id}/d1"],
    scope: "account",
    labels: ["cloudflare", "d1", "database", "sql"],
  },
  {
    name: "pages",
    description:
      "Cloudflare Pages — projects, deployments, domains, build configs",
    pathPrefixes: ["/accounts/{account_id}/pages"],
    scope: "account",
    labels: ["cloudflare", "pages", "jamstack", "deployment"],
  },
  {
    name: "queues",
    description:
      "Cloudflare Queues — queue management, consumers, message operations",
    pathPrefixes: ["/accounts/{account_id}/queues"],
    scope: "account",
    labels: ["cloudflare", "queues", "messaging"],
  },
  {
    name: "workers-ai",
    description:
      "Cloudflare Workers AI — model inference, fine-tuning, LoRA adapters",
    pathPrefixes: ["/accounts/{account_id}/ai"],
    scope: "account",
    labels: ["cloudflare", "ai", "inference", "workers"],
  },
  {
    name: "vectorize",
    description:
      "Cloudflare Vectorize — vector indexes, insert/query/delete operations",
    pathPrefixes: ["/accounts/{account_id}/vectorize"],
    scope: "account",
    labels: ["cloudflare", "vectorize", "vector-search", "embeddings"],
  },
  {
    name: "images",
    description:
      "Cloudflare Images — upload, transform, deliver, and manage image pipelines",
    pathPrefixes: ["/accounts/{account_id}/images"],
    scope: "account",
    labels: ["cloudflare", "images", "cdn", "media"],
  },
  {
    name: "stream",
    description:
      "Cloudflare Stream — video upload, encoding, delivery, live streaming",
    pathPrefixes: ["/accounts/{account_id}/stream"],
    scope: "account",
    labels: ["cloudflare", "stream", "video", "media"],
  },
  {
    name: "load-balancing",
    description:
      "Cloudflare Load Balancing — pools, monitors, load balancers, steering policies",
    pathPrefixes: [
      "/accounts/{account_id}/load_balancers",
      "/zones/{zone_id}/load_balancers",
    ],
    scope: "account",
    labels: ["cloudflare", "load-balancing", "traffic", "health-checks"],
  },
  {
    name: "access",
    description:
      "Cloudflare Access (Zero Trust) — applications, policies, identity providers, certificates",
    pathPrefixes: ["/accounts/{account_id}/access"],
    scope: "account",
    labels: ["cloudflare", "access", "zero-trust", "identity"],
  },
  {
    name: "tunnel",
    description:
      "Cloudflare Tunnel — tunnel management, configurations, connections",
    pathPrefixes: [
      "/accounts/{account_id}/cfd_tunnel",
      "/accounts/{account_id}/tunnels",
    ],
    scope: "account",
    labels: ["cloudflare", "tunnel", "zero-trust", "connectivity"],
  },
  {
    name: "gateway",
    description:
      "Cloudflare Gateway — DNS/HTTP policies, locations, proxy endpoints",
    pathPrefixes: ["/accounts/{account_id}/gateway"],
    scope: "account",
    labels: ["cloudflare", "gateway", "zero-trust", "dns-filtering"],
  },
  {
    name: "turnstile",
    description: "Cloudflare Turnstile — CAPTCHA-free challenges, site widgets",
    pathPrefixes: ["/accounts/{account_id}/challenges/widgets"],
    scope: "account",
    labels: ["cloudflare", "turnstile", "captcha", "bot-management"],
  },
  {
    name: "logpush",
    description:
      "Cloudflare Logpush — log jobs, destinations, field configurations",
    pathPrefixes: [
      "/accounts/{account_id}/logpush",
      "/zones/{zone_id}/logpush",
    ],
    scope: "account",
    labels: ["cloudflare", "logpush", "logging", "observability"],
  },
  {
    name: "registrar",
    description:
      "Cloudflare Registrar — domain registration, transfers, contacts",
    pathPrefixes: ["/accounts/{account_id}/registrar"],
    scope: "account",
    labels: ["cloudflare", "registrar", "domains"],
  },
  {
    name: "waiting-room",
    description:
      "Cloudflare Waiting Room — traffic queuing, rules, events, analytics",
    pathPrefixes: ["/zones/{zone_id}/waiting_rooms"],
    scope: "zone",
    labels: ["cloudflare", "waiting-room", "traffic-management"],
  },
  {
    name: "email-routing",
    description:
      "Cloudflare Email Routing — rules, addresses, catch-all, DNS setup",
    pathPrefixes: ["/zones/{zone_id}/email"],
    scope: "zone",
    labels: ["cloudflare", "email", "routing"],
  },
  {
    name: "hyperdrive",
    description:
      "Cloudflare Hyperdrive — database connection pooling configurations",
    pathPrefixes: ["/accounts/{account_id}/hyperdrive"],
    scope: "account",
    labels: ["cloudflare", "hyperdrive", "database", "connection-pooling"],
  },
  {
    name: "durable-objects",
    description:
      "Cloudflare Durable Objects — namespaces, object management, alarms",
    pathPrefixes: ["/accounts/{account_id}/workers/durable_objects"],
    scope: "account",
    labels: ["cloudflare", "durable-objects", "workers", "state"],
  },
  {
    name: "workers-scripts",
    description:
      "Cloudflare Workers Scripts — upload, deploy, bindings, routes, cron triggers",
    pathPrefixes: [
      "/accounts/{account_id}/workers/scripts",
      "/accounts/{account_id}/workers/services",
    ],
    scope: "account",
    labels: ["cloudflare", "workers", "serverless", "scripts"],
    excludePaths: ["/accounts/{account_id}/workers/durable_objects"],
  },
  {
    name: "rulesets",
    description:
      "Cloudflare Rulesets — WAF custom rules, transform rules, managed rulesets",
    pathPrefixes: [
      "/accounts/{account_id}/rulesets",
      "/zones/{zone_id}/rulesets",
    ],
    scope: "account",
    labels: ["cloudflare", "rulesets", "waf", "security"],
  },
  {
    name: "api-shield",
    description:
      "Cloudflare API Shield — schema validation, endpoint discovery, sequence rules",
    pathPrefixes: ["/zones/{zone_id}/api_gateway"],
    scope: "zone",
    labels: ["cloudflare", "api-shield", "api-security"],
  },
  {
    name: "spectrum",
    description:
      "Cloudflare Spectrum — TCP/UDP proxying for non-HTTP applications",
    pathPrefixes: ["/zones/{zone_id}/spectrum"],
    scope: "zone",
    labels: ["cloudflare", "spectrum", "tcp", "udp", "proxy"],
  },
  {
    name: "magic-transit",
    description:
      "Cloudflare Magic Transit — GRE tunnels, static routes, health checks, IPsec",
    pathPrefixes: ["/accounts/{account_id}/magic"],
    scope: "account",
    labels: ["cloudflare", "magic-transit", "network", "ddos"],
  },
  {
    name: "ssl-certificates",
    description:
      "Cloudflare SSL/TLS — certificate packs, custom certificates, certificate authority",
    pathPrefixes: [
      "/zones/{zone_id}/ssl",
      "/zones/{zone_id}/custom_certificates",
      "/certificates",
    ],
    scope: "zone",
    labels: ["cloudflare", "ssl", "tls", "certificates"],
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
