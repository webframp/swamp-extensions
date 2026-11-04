/**
 * DNSimple codegen configuration.
 *
 * Defines how DNSimple's OpenAPI paths map to swamp extension directories,
 * which operations are excluded, and shared constants.
 */

/** Live URL for the DNSimple API v2 OpenAPI spec (OpenAPI 3.1). */
export const SCHEMA_URL = "https://developer.dnsimple.com/v2/openapi.json";

/** Where generated extensions land, relative to the codegen dir (cwd). */
export const OUTPUT_BASE = "../../dnsimple";

/** Zod version to use in generated code */
export const ZOD_VERSION = "4.6.7";

/** swamp-testing version */
export const SWAMP_TESTING_VERSION = "0.20261030.68";

/**
 * Pagination bounds. Defined once, in the runtime helper the generator ships
 * into every extension (`lib/runtime/api.ts`), and re-exported here so the
 * generator and the generated code cannot drift apart.
 */
export { MAX_PAGES, PAGE_SIZE } from "./lib/runtime/api.ts";

/**
 * Service definition — maps a logical DNSimple area to an extension.
 *
 * A path belongs to the service whose `pathPrefixes` entry is the LONGEST
 * match (see service_grouper.ts). A prefix may begin with `/{account}`, which
 * matches any account-scoped path. `excludePaths` removes sub-trees that a
 * longer prefix on another service claims, so the overlap is declared and the
 * grouper's claim checks stay meaningful.
 */
export interface ServiceConfig {
  /** Extension directory name under OUTPUT_BASE (e.g., "zones") */
  name: string;
  /** Human-readable description for the manifest */
  description: string;
  /** Path prefixes that group endpoints into this service */
  pathPrefixes: string[];
  /** Labels for the manifest */
  labels: string[];
  /** Skip paths under these prefixes even if a prefix above matches */
  excludePaths?: string[];
  /** README "Stored data" text: what personal or credential-bearing data the service stores, and how */
  storedDataNote?: string;
  /** README "Plan limits" text: a cost that depends on the account's plan */
  planLimitNote?: string;
}

/**
 * Master service registry — eleven extensions mirroring DNSimple's areas.
 * Grouping is by path prefix, never by tag: `queryDnsAnalytics` carries both
 * the `billing` and `zones` tags and tag grouping would claim it twice.
 */
export const SERVICES: ServiceConfig[] = [
  {
    name: "account",
    description:
      "DNSimple Account — identity, account list, and billing charges",
    pathPrefixes: ["/whoami", "/accounts", "/{account}/billing"],
    labels: ["dnsimple", "account", "billing"],
    storedDataNote:
      "`whoami` and `list_accounts` store the user's and accounts' email addresses, and `list_charges` stores invoice data, all as ordinary swamp data.",
  },
  {
    name: "zones",
    description:
      "DNSimple Zones — zones, records, batch changes, zone file, distribution checks, NS records, activation, and DNS analytics",
    pathPrefixes: ["/{account}/zones", "/{account}/dns_analytics"],
    labels: ["dnsimple", "dns", "zones", "records"],
    planLimitNote:
      "DNSimple's spec says a zone's records beyond the plan's `records_limit` are either charged or cannot be created. Whether `create_zone_record` and `batch_change_zone_records` cost anything therefore depends on your plan, so they are not marked Billable. Check the account's limit before creating records in bulk. On the Solo, Solo Pro and Teams plans DNSimple also charges for each active zone when the subscription renews, so `activate_zone_service` adds to that invoice.",
  },
  {
    name: "secondary-dns",
    description: "DNSimple Secondary DNS — primary servers and secondary zones",
    pathPrefixes: ["/{account}/secondary_dns"],
    labels: ["dnsimple", "dns", "secondary-dns"],
    planLimitNote:
      "On the Solo Pro and Teams plans, DNSimple enables DNS services for a secondary zone when it is created and charges for the zone on each subscription renewal invoice, so `create_secondary_zone` adds to that invoice.",
  },
  {
    name: "domains",
    description:
      "DNSimple Domains — domains, applied services, pushes, email forwards, and vanity name servers",
    pathPrefixes: [
      "/{account}/domains",
      "/{account}/pushes",
      "/{account}/vanity",
      "/services",
    ],
    excludePaths: [
      "/{account}/domains/{domain}/dnssec",
      "/{account}/domains/{domain}/ds_records",
      "/{account}/domains/{domain}/certificates",
      "/{account}/domains/{domain}/templates",
    ],
    labels: ["dnsimple", "domains", "email-forwards"],
    planLimitNote:
      "On the Solo, Solo Pro and Teams plans, DNSimple enables DNS services for a domain's zone when `create_domain` adds it and charges for the zone on each subscription renewal invoice, so the call is not marked Billable but does add to that invoice.",
    storedDataNote:
      "Email forwards store their `from` and `to` addresses as ordinary swamp data.",
  },
  {
    name: "dnssec",
    description: "DNSimple DNSSEC — DNSSEC state and delegation signer records",
    pathPrefixes: [
      "/{account}/domains/{domain}/dnssec",
      "/{account}/domains/{domain}/ds_records",
    ],
    labels: ["dnsimple", "dns", "dnssec"],
  },
  {
    name: "certificates",
    description:
      "DNSimple Certificates — certificates, Let's Encrypt orders and renewals, and private keys",
    pathPrefixes: ["/{account}/domains/{domain}/certificates"],
    labels: ["dnsimple", "certificates", "tls", "letsencrypt"],
  },
  {
    name: "registrar",
    description:
      "DNSimple Registrar — registration, renewal, transfer, restore, delegation, WHOIS privacy, transfer lock, auto-renewal, registrant changes, and prices",
    pathPrefixes: ["/{account}/registrar"],
    labels: ["dnsimple", "registrar", "domains", "billing"],
    storedDataNote:
      "Registrations store the registrant's ID. Registrant changes store the change itself, including any `extended_attributes`, and some TLDs require national identifiers or similar personal details there. The registrar extension stores no names, addresses or phone numbers; those live in `@webframp/dnsimple/contacts`.",
  },
  {
    name: "contacts",
    description: "DNSimple Contacts — registrant contacts",
    pathPrefixes: ["/{account}/contacts"],
    labels: ["dnsimple", "contacts", "registrant"],
    storedDataNote:
      "Registrant contact details (names, email addresses, phone numbers and postal addresses) are required to manage a domain, so this extension stores them as ordinary swamp data.",
  },
  {
    name: "templates",
    description:
      "DNSimple Templates — record templates and applying them to domains",
    pathPrefixes: [
      "/{account}/templates",
      "/{account}/domains/{domain}/templates",
    ],
    labels: ["dnsimple", "dns", "templates"],
  },
  {
    name: "webhooks",
    description: "DNSimple Webhooks — webhook subscriptions",
    pathPrefixes: ["/{account}/webhooks"],
    labels: ["dnsimple", "webhooks"],
    storedDataNote:
      "Webhook URLs are stored as ordinary swamp data. A URL that embeds a credential (some chat services issue such URLs) is stored as given, so treat the datastore accordingly, or use an endpoint that authenticates another way.",
  },
  {
    name: "tlds",
    description: "DNSimple TLDs — TLD catalog and extended attributes",
    pathPrefixes: ["/tlds"],
    labels: ["dnsimple", "tlds", "registrar"],
  },
];

/**
 * Operations the generator never emits. `oauthToken` runs the OAuth
 * authorization-code exchange for third-party apps and takes a
 * `client_secret`; a model that already holds an access token has no use for
 * it.
 */
export const EXCLUDED_OPERATIONS: string[] = ["oauthToken"];

/**
 * Paginated operations whose results are not at `data`. `queryDnsAnalytics`
 * returns `data: { headers, rows }`, so its results live at `data.rows` and
 * the sibling keys named in `keep` are copied from the first page.
 * Generation fails when a paginated operation's results path does not resolve
 * to an array.
 */
export interface PaginatedResultPath {
  /** Property path from the response root to the results array. */
  path: string[];
  /** Sibling properties of the results array to keep from the first page. */
  keep?: string[];
}

export const PAGINATED_RESULT_PATHS: Record<string, PaginatedResultPath> = {
  queryDnsAnalytics: { path: ["data", "rows"], keep: ["headers"] },
};

/**
 * Response fields that carry secrets, keyed by OpenAPI `operationId`. Each is
 * marked `.meta({ sensitive: true })` in the method's resource schema, so
 * swamp stores the value in a vault and persists only a `vault.get(...)`
 * reference. Declared by operation rather than inferred from field names: a
 * name heuristic would flag `ServiceSetting.password` (a boolean that marks a
 * field as a password) and the public DNSSEC `public_key` and `keytag` values.
 * Every listed field must be declared in the response schema; generation
 * fails otherwise, since swamp only vaults fields the schema names.
 */
export const SENSITIVE_RESPONSE_FIELDS: Record<string, string[]> = {
  getCertificatePrivateKey: ["private_key"],
};

/**
 * Request fields that carry secrets, keyed by `operationId`. Each is marked
 * `.meta({ sensitive: true })` on the method argument and omitted from the
 * receipt an action writes. Every listed field must be declared in the
 * resolved request body schema; generation fails otherwise.
 */
export const SENSITIVE_ARG_FIELDS: Record<string, string[]> = {
  transferDomain: ["auth_code"],
};

/**
 * Known errors in DNSimple's spec text. A correction applies only while the
 * spec still holds `expected` at `path`, so an upstream fix is never
 * overwritten and a stale entry does nothing.
 */
export interface SpecCorrection {
  path: string[];
  expected: unknown;
  value: unknown;
}

export const SPEC_CORRECTIONS: SpecCorrection[] = [
  {
    // Copied from the country field upstream.
    path: [
      "components",
      "schemas",
      "Contact",
      "properties",
      "postal_code",
      "description",
    ],
    expected: "The ISO 3166-1 alpha-2 country code, upper case (eg. DE).",
    value: "The postal code.",
  },
  {
    // The field's own description limits it to TLDs that use authorization-
    // based transfers, so a transfer for any other TLD must be able to omit it.
    path: [
      "components",
      "requestBodies",
      "DomainTransfer",
      "content",
      "application/json",
      "schema",
      "required",
    ],
    expected: ["registrant_id", "auth_code"],
    value: ["registrant_id"],
  },
  {
    // A primary server's port is an integer in every response.
    path: [
      "components",
      "requestBodies",
      "PrimaryServerCreate",
      "content",
      "application/json",
      "schema",
      "properties",
      "port",
      "type",
    ],
    expected: "string",
    value: "integer",
  },
];

/**
 * Operations that charge the account. Enabling WHOIS privacy buys a year of
 * the service when it is not already purchased. Their describe string opens with
 * "Billable:" so the cost is visible in `swamp model describe` output.
 */
export const BILLABLE_OPERATIONS: string[] = [
  "registerDomain",
  "renewDomain",
  "transferDomain",
  "restoreDomain",
  "enableWhoisPrivacy",
  "purchaseLetsencryptCertificate",
  "purchaseRenewalLetsencryptCertificate",
];

/** Get today's CalVer version */
export function calver(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}.1`;
}
