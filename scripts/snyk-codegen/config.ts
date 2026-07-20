/**
 * Snyk codegen configuration.
 *
 * Defines how OpenAPI paths map to swamp extension directories,
 * which services to generate, and shared constants.
 */

/**
 * Pinned Snyk API version.
 *
 * Snyk versions their API by date. Pin to a specific version for
 * reproducible builds.
 */
export const API_VERSION = "2024-10-15";

/** Base URL for fetching the OpenAPI spec */
export const SCHEMA_URL = `https://api.snyk.io/rest/openapi/${API_VERSION}`;

/** Snyk REST API base URL */
export const API_BASE = "https://api.snyk.io/rest";

/** Where generated extensions land relative to repo root */
export const OUTPUT_BASE = "../../snyk";

/** Zod version to use in generated code */
export const ZOD_VERSION = "4.4.3";

/** swamp-testing version */
export const SWAMP_TESTING_VERSION = "0.20260504.10";

/** Max pagination pages (safety cap) */
export const MAX_PAGES = 20;

/**
 * Service definition — maps a logical Snyk service to an extension.
 */
export interface ServiceConfig {
  /** Extension directory name under OUTPUT_BASE (e.g., "projects", "issues") */
  name: string;
  /** Human-readable description for the manifest */
  description: string;
  /** Path prefixes that group endpoints into this service */
  pathPrefixes: string[];
  /** The scope of API access — determines globalArgs */
  scope: "org" | "group" | "user";
  /** Labels for the manifest */
  labels: string[];
  /** Skip these specific paths even if they match prefixes */
  excludePaths?: string[];
}

/**
 * Master service registry.
 *
 * Endpoints that don't match any service here are silently skipped.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "projects",
    description:
      "Snyk Projects — project listing, attributes, relationships, and target management",
    pathPrefixes: ["/orgs/{org_id}/projects"],
    scope: "org",
    labels: ["snyk", "projects", "security", "devsecops"],
  },
  {
    name: "issues",
    description:
      "Snyk Issues — vulnerability issues across projects and groups",
    pathPrefixes: [
      "/orgs/{org_id}/issues",
      "/groups/{group_id}/issues",
    ],
    scope: "org",
    labels: ["snyk", "issues", "vulnerabilities", "security"],
  },
  {
    name: "inventory",
    description:
      "Snyk Inventory — asset discovery for packages, containers, repos, and cloud resources",
    pathPrefixes: [
      "/orgs/{org_id}/inventory",
      "/groups/{group_id}/inventory",
    ],
    scope: "org",
    labels: ["snyk", "inventory", "assets", "sbom", "devsecops"],
  },
  {
    name: "cloud",
    description:
      "Snyk Cloud — cloud environments, scans, and resource posture management",
    pathPrefixes: ["/orgs/{org_id}/cloud"],
    scope: "org",
    labels: ["snyk", "cloud", "iac", "posture", "security"],
  },
  {
    name: "policies",
    description:
      "Snyk Policies — security policy management and rule configuration",
    pathPrefixes: ["/orgs/{org_id}/policies"],
    scope: "org",
    labels: ["snyk", "policies", "governance", "security"],
  },
  {
    name: "apps",
    description:
      "Snyk Apps — OAuth application management, bots, installations",
    pathPrefixes: [
      "/orgs/{org_id}/apps",
      "/orgs/{org_id}/app_bots",
      "/groups/{group_id}/apps",
    ],
    scope: "org",
    labels: ["snyk", "apps", "oauth", "integrations"],
  },
  {
    name: "settings",
    description: "Snyk Settings — organization and group setting management",
    pathPrefixes: [
      "/orgs/{org_id}/settings",
      "/groups/{group_id}/settings",
    ],
    scope: "org",
    labels: ["snyk", "settings", "configuration"],
  },
  {
    name: "collections",
    description:
      "Snyk Collections — project collection groupings and management",
    pathPrefixes: ["/orgs/{org_id}/collections"],
    scope: "org",
    labels: ["snyk", "collections", "organization"],
  },
  {
    name: "container-images",
    description:
      "Snyk Container Images — container image scanning and vulnerability data",
    pathPrefixes: ["/orgs/{org_id}/container_images"],
    scope: "org",
    labels: ["snyk", "containers", "images", "security"],
  },
  {
    name: "sbom",
    description: "Snyk SBOM — software bill of materials testing and analysis",
    pathPrefixes: ["/orgs/{org_id}/sbom_tests"],
    scope: "org",
    labels: ["snyk", "sbom", "supply-chain", "security"],
  },
  {
    name: "service-accounts",
    description:
      "Snyk Service Accounts — automated access management for CI/CD",
    pathPrefixes: [
      "/orgs/{org_id}/service_accounts",
      "/groups/{group_id}/service_accounts",
    ],
    scope: "org",
    labels: ["snyk", "service-accounts", "ci-cd", "automation"],
  },
  {
    name: "tests",
    description:
      "Snyk Tests — on-demand package and dependency vulnerability testing",
    pathPrefixes: ["/orgs/{org_id}/tests"],
    scope: "org",
    labels: ["snyk", "tests", "scanning", "vulnerabilities"],
  },
  {
    name: "sast",
    description:
      "Snyk SAST — static application security testing results and management",
    pathPrefixes: ["/groups/{group_id}/sast"],
    scope: "group",
    labels: ["snyk", "sast", "static-analysis", "security"],
  },
  {
    name: "assets",
    description:
      "Snyk Assets — asset discovery and classification across the group",
    pathPrefixes: ["/groups/{group_id}/assets"],
    scope: "group",
    labels: ["snyk", "assets", "discovery", "inventory"],
  },
  {
    name: "sso",
    description: "Snyk SSO — single sign-on connection management for groups",
    pathPrefixes: ["/groups/{group_id}/sso_connections"],
    scope: "group",
    labels: ["snyk", "sso", "saml", "identity"],
  },
  {
    name: "memberships",
    description: "Snyk Memberships — group and org member management",
    pathPrefixes: [
      "/groups/{group_id}/memberships",
      "/orgs/{org_id}/memberships",
    ],
    scope: "org",
    labels: ["snyk", "memberships", "users", "access"],
  },
  {
    name: "self",
    description:
      "Snyk Self — current user context, org listing, and app management",
    pathPrefixes: ["/self"],
    scope: "user",
    labels: ["snyk", "self", "user", "account"],
  },
  {
    name: "tenants",
    description: "Snyk Tenants — tenant and organization lifecycle management",
    pathPrefixes: ["/tenants"],
    scope: "user",
    labels: ["snyk", "tenants", "organizations", "management"],
  },
  {
    name: "groups",
    description: "Snyk Groups — group management, orgs, members, and audit",
    pathPrefixes: ["/groups"],
    scope: "group",
    labels: ["snyk", "groups", "organizations", "management"],
    excludePaths: [
      "/groups/{group_id}/issues",
      "/groups/{group_id}/inventory",
      "/groups/{group_id}/sast",
      "/groups/{group_id}/assets",
      "/groups/{group_id}/apps",
      "/groups/{group_id}/service_accounts",
      "/groups/{group_id}/settings",
      "/groups/{group_id}/sso_connections",
      "/groups/{group_id}/memberships",
    ],
  },
  {
    name: "slack",
    description:
      "Snyk Slack Integration — Slack app configuration and channel management",
    pathPrefixes: ["/orgs/{org_id}/slack_app"],
    scope: "org",
    labels: ["snyk", "slack", "notifications", "integrations"],
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
