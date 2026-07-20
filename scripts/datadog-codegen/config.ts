/**
 * Datadog codegen configuration.
 *
 * Defines how OpenAPI paths/tags map to swamp extension directories,
 * which services to generate (tiered), and shared constants.
 */

/** Datadog v2 OpenAPI spec location (from official API client repo) */
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/DataDog/datadog-api-client-go/master/.generator/schemas/v2/openapi.yaml";

/** Where generated extensions land relative to this script */
export const OUTPUT_BASE = "../../datadog";

/** Zod version to use in generated code */
export const ZOD_VERSION = "4.4.3";

/** swamp-testing version */
export const SWAMP_TESTING_VERSION = "0.20260504.10";

/** Max pagination pages (safety cap) */
export const MAX_PAGES = 20;

/** Datadog sites and their base URLs */
export const DD_SITES: Record<string, string> = {
  us1: "https://api.datadoghq.com",
  us3: "https://us3.datadoghq.com",
  us5: "https://us5.datadoghq.com",
  eu1: "https://api.datadoghq.eu",
  ap1: "https://ap1.datadoghq.com",
  "us1-fed": "https://api.ddog-gov.com",
};

/**
 * Pagination style for Datadog endpoints.
 *
 * Detected at codegen time from query parameter names.
 */
export type PaginationStyle = "cursor" | "offset" | "page_number" | "none";

/**
 * Pagination configuration embedded in generated methods.
 */
export interface PaginationConfig {
  style: PaginationStyle;
  /** Request param for page size (e.g., "page[limit]", "page[size]") */
  limitParam: string;
  /** Default page size */
  limitDefault: number;
  /** Cursor-based: request param name */
  cursorParam?: string;
  /** Cursor-based: dot-path in response to find next cursor */
  cursorResponsePath?: string;
  /** Offset-based: request param name */
  offsetParam?: string;
  /** Page-number: request param name */
  pageParam?: string;
}

/**
 * Service definition — maps a logical Datadog service to an extension.
 */
export interface ServiceConfig {
  /** Extension directory name under OUTPUT_BASE */
  name: string;
  /** Human-readable description for the manifest */
  description: string;
  /** OpenAPI tag(s) that group endpoints into this service */
  tags: string[];
  /** Path prefixes to include (if specified, limits to these paths within the tag) */
  pathPrefixes?: string[];
  /** Paths to exclude even if they match */
  excludePaths?: string[];
  /** Labels for the manifest */
  labels: string[];
  /** Optional pagination override for all endpoints in this service */
  pagination?: PaginationConfig;
  /** Allow x-unstable endpoints (default: false) */
  allowUnstable?: boolean;
}

/**
 * Tier 1 services — core observability value.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "monitors",
    description:
      "Datadog Monitors — monitor definitions, muting, status, and downtime management",
    tags: ["Monitors"],
    labels: ["datadog", "monitors", "alerting", "observability"],
  },
  {
    name: "incidents",
    description:
      "Datadog Incidents — incident lifecycle, timelines, teams, and attachments",
    tags: ["Incidents"],
    labels: ["datadog", "incidents", "on-call", "response"],
  },
  {
    name: "slos",
    description:
      "Datadog SLOs — service level objective definitions, status, and history",
    tags: ["Service Level Objectives"],
    labels: ["datadog", "slo", "reliability", "observability"],
    allowUnstable: true,
  },
  {
    name: "metrics",
    description:
      "Datadog Metrics — metric queries, submissions, tag configurations, and metadata",
    tags: ["Metrics"],
    labels: ["datadog", "metrics", "timeseries", "observability"],
  },
  {
    name: "logs",
    description: "Datadog Logs — log search, aggregation, and analytics",
    tags: ["Logs"],
    labels: ["datadog", "logs", "search", "observability"],
  },
  {
    name: "events",
    description: "Datadog Events — event search and submission",
    tags: ["Events"],
    labels: ["datadog", "events", "observability"],
  },
  {
    name: "downtimes",
    description:
      "Datadog Downtimes — scheduled downtime management for monitors",
    tags: ["Downtimes"],
    labels: ["datadog", "downtimes", "maintenance", "alerting"],
  },
  {
    name: "synthetics",
    description:
      "Datadog Synthetics — synthetic monitoring tests, results, and locations",
    tags: ["Synthetics"],
    labels: ["datadog", "synthetics", "monitoring", "testing"],
  },
  {
    name: "on-call",
    description:
      "Datadog On-Call — on-call schedules, escalation policies, and routing",
    tags: ["On-Call"],
    labels: ["datadog", "on-call", "paging", "incident-response"],
  },
  {
    name: "teams",
    description:
      "Datadog Teams — team management, memberships, and permissions",
    tags: ["Teams"],
    labels: ["datadog", "teams", "organization", "rbac"],
  },
  {
    name: "dora",
    description:
      "Datadog DORA Metrics — deployment frequency, lead time, MTTR, and change failure rate",
    tags: ["DORA Metrics"],
    labels: ["datadog", "dora", "devops", "engineering-velocity"],
  },
  // Security Monitoring split by sub-path
  {
    name: "security-rules",
    description: "Datadog Security Rules — detection rule CRUD and management",
    tags: ["Security Monitoring"],
    pathPrefixes: ["/api/v2/security_monitoring/rules"],
    labels: ["datadog", "security", "detection", "siem"],
  },
  {
    name: "security-signals",
    description:
      "Datadog Security Signals — signal search, triage, and archiving",
    tags: ["Security Monitoring"],
    pathPrefixes: ["/api/v2/security_monitoring/signals"],
    labels: ["datadog", "security", "signals", "triage"],
  },
  {
    name: "security-suppressions",
    description: "Datadog Security Suppressions — suppression rule management",
    tags: ["Security Monitoring"],
    pathPrefixes: ["/api/v2/security_monitoring/configuration/suppressions"],
    labels: ["datadog", "security", "suppressions", "tuning"],
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
