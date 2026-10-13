/**
 * AWS Certificate Manager (ACM) diagnostics model for swamp.
 *
 * Read-only methods for investigating certificate issuance and validation
 * problems, such as a CloudFormation certificate stuck in
 * PENDING_VALIDATION: per-domain validation status, the DNS records ACM
 * expects, failure reasons, and which resources still use a certificate.
 *
 * Only ListCertificates and DescribeCertificate are called, so a read-only
 * profile is sufficient.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import {
  ACMClient,
  type ACMClientConfig,
  CertificateKeyPairOrigin,
  type CertificateStatus,
  DescribeCertificateCommand,
  KeyAlgorithm,
  ListCertificatesCommand,
} from "npm:@aws-sdk/client-acm@3.1139.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1139.0";

const EXTENSION_NAME = "@webframp/aws/acm-diagnostics";

/** Safety bound on ListCertificates pagination (up to 1,000 per page). */
const MAX_PAGES = 50;

/** Certificates described per call; bounds fan-out. */
const MAX_ARNS = 100;

/** Per-request deadline; the SDK default has none, so a black-holed endpoint would hang. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Total budget for a describe_certificates fan-out. Remaining ARNs are reported as errored. */
const DESCRIBE_BUDGET_MS = 5 * 60_000;

/**
 * ListCertificates filters to RSA_1024 and RSA_2048 by default, which silently
 * hides EC and RSA_3072/4096 certificates. Always ask for every key type.
 */
const ALL_KEY_TYPES = Object.values(KeyAlgorithm);

/** The same trap exists for key pair origin: the default omits ACME. */
const ALL_KEY_PAIR_ORIGINS = Object.values(CertificateKeyPairOrigin);

/**
 * A full ACM certificate ARN. Strict on purpose: the trailing UUID becomes a
 * swamp data name, so an empty, `.`/`..`, or otherwise malformed id must fail
 * argument validation instead of failing partway through the writes.
 */
const CERT_ARN_RE =
  /^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Default data names of the two methods; each rejects the other's. */
const LIST_DEFAULT_NAME = "list-matching";
const SUMMARY_DEFAULT_NAME = "describe-summary";

/**
 * User-chosen data names. Data names are per model, so these share a namespace
 * with every resource this model writes: reject the swamp-reserved `latest`,
 * path-unsafe characters, the `cert-` prefix used for certificate records, and
 * the other method's default name (which holds a different schema).
 */
function userNameSchema(otherDefault: string) {
  return z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' and '-' only")
    .refine((n) => n !== "latest" && n !== "." && n !== "..", {
      message: "'latest', '.' and '..' are reserved",
    })
    .refine((n) => !n.startsWith("cert-"), {
      message: "the 'cert-' prefix is reserved for certificate records",
    })
    .refine((n) => n !== otherDefault, {
      message: `'${otherDefault}' is the other method's default data name`,
    });
}

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe(
      "AWS region of the certificate (CloudFront certificates live in us-east-1)",
    ),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "AWS shared-config profile to resolve credentials from (fromIni). " +
        "Omit to use the default credential chain.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const Meta = {
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
};

const ResourceRecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string(),
});

const DomainValidationSchema = z.object({
  domainName: z.string(),
  validationDomain: z.string().nullable(),
  validationStatus: z.string().nullable(),
  validationMethod: z.string().nullable(),
  resourceRecord: ResourceRecordSchema.nullable().describe(
    "The DNS CNAME ACM expects for DNS validation",
  ),
  validationEmails: z.array(z.string()),
});

const CertificateSchema = z.object({
  certificateArn: z.string(),
  found: z.boolean().describe(
    "True only when the certificate was described successfully",
  ),
  errorCode: z.string().nullable().describe(
    "SDK error name when it could not be described, e.g. " +
      "ResourceNotFoundException (deleted, or in another account), " +
      "RegionMismatch (ARN region differs from the model's) or AccessDeniedException",
  ),
  error: z.string().nullable().describe(
    "Error message when the certificate could not be described",
  ),
  domainName: z.string().nullable(),
  subjectAlternativeNames: z.array(z.string()),
  status: z.string().nullable(),
  type: z.string().nullable(),
  failureReason: z.string().nullable(),
  keyAlgorithm: z.string().nullable(),
  createdAt: z.string().nullable(),
  issuedAt: z.string().nullable(),
  notBefore: z.string().nullable(),
  notAfter: z.string().nullable(),
  inUseBy: z.array(z.string()).describe(
    "ARNs of resources using the certificate; a non-empty list blocks deletion",
  ),
  renewalEligibility: z.string().nullable(),
  domainValidations: z.array(DomainValidationSchema),
  pendingValidation: z.array(z.string()).describe(
    "Domains whose validationStatus is not SUCCESS",
  ),
  ...Meta,
});

type Certificate = z.infer<typeof CertificateSchema>;

const CertificateListSchema = z.object({
  certificates: z.array(z.object({
    certificateArn: z.string(),
    domainName: z.string(),
    status: z.string().nullable(),
    type: z.string().nullable(),
    inUse: z.boolean().nullable(),
    createdAt: z.string().nullable(),
    issuedAt: z.string().nullable(),
    notAfter: z.string().nullable(),
  })),
  count: z.number(),
  truncated: z.boolean().describe(
    "True when pagination hit the page cap, so more certificates may exist",
  ),
  ...Meta,
});

const DescribeSummarySchema = z.object({
  requested: z.number(),
  found: z.number(),
  notFound: z.array(z.string()).describe(
    "ARNs ACM reports as nonexistent (deleted, or in another account)",
  ),
  errored: z.array(z.object({
    certificateArn: z.string(),
    errorCode: z.string().nullable(),
    error: z.string().nullable(),
  })).describe("ARNs that failed for any other reason, e.g. AccessDenied"),
  byStatus: z.record(z.string(), z.number()),
  pendingValidation: z.array(z.object({
    certificateArn: z.string(),
    domains: z.array(z.string()),
  })),
  inUse: z.array(z.object({
    certificateArn: z.string(),
    inUseBy: z.array(z.string()),
  })),
  ...Meta,
});

// =============================================================================
// Helpers
// =============================================================================

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeClient(g: GlobalArgs): ACMClient {
  const config: ACMClientConfig = { region: g.region };
  if (g.profile) config.credentials = fromIni({ profile: g.profile });
  return new ACMClient(config);
}

/** SDK timestamps may be Date or string depending on version. */
function iso(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Data name for a certificate record: `cert-<uuid>` from a validated ARN. */
function certName(arn: string): string {
  return `cert-${arn.split("/").pop()}`;
}

/**
 * Deterministic short hash (SHA-1, first 16 hex chars) used to disambiguate
 * data names that would otherwise collide.
 */
async function shortHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function isNotFound(errorCode: string | null): boolean {
  return errorCode === "ResourceNotFoundException";
}

type Context = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
  };
};

function emptyCertificate(
  arn: string,
  errorCode: string | null,
  error: string | null,
  startMs: number,
): Certificate {
  return {
    certificateArn: arn,
    found: false,
    errorCode,
    error,
    domainName: null,
    subjectAlternativeNames: [],
    status: null,
    type: null,
    failureReason: null,
    keyAlgorithm: null,
    createdAt: null,
    issuedAt: null,
    notBefore: null,
    notAfter: null,
    inUseBy: [],
    renewalEligibility: null,
    domainValidations: [],
    pendingValidation: [],
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    collectedBy: EXTENSION_NAME,
  };
}

async function describeOne(
  client: ACMClient,
  arn: string,
): Promise<Certificate> {
  const startMs = Date.now();
  let res;
  try {
    res = await client.send(
      new DescribeCertificateCommand({ CertificateArn: arn }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  } catch (err) {
    // A deleted certificate is a finding, not a failure of the
    // whole fan-out; other errors (AccessDenied, throttling) are recorded too
    // so one bad ARN cannot hide the rest.
    return emptyCertificate(
      arn,
      err instanceof Error ? err.name : "Error",
      errMsg(err),
      startMs,
    );
  }
  const c = res.Certificate;
  if (!c) {
    return emptyCertificate(arn, "EmptyResponse", "empty response", startMs);
  }

  const domainValidations = (c.DomainValidationOptions ?? []).map((d) => ({
    domainName: d.DomainName ?? "",
    validationDomain: d.ValidationDomain ?? null,
    validationStatus: d.ValidationStatus ?? null,
    validationMethod: d.ValidationMethod ?? null,
    resourceRecord: d.ResourceRecord
      ? {
        name: d.ResourceRecord.Name ?? "",
        type: d.ResourceRecord.Type ?? "",
        value: d.ResourceRecord.Value ?? "",
      }
      : null,
    validationEmails: d.ValidationEmails ?? [],
  }));

  return {
    certificateArn: c.CertificateArn ?? arn,
    found: true,
    errorCode: null,
    error: null,
    domainName: c.DomainName ?? null,
    subjectAlternativeNames: c.SubjectAlternativeNames ?? [],
    status: c.Status ?? null,
    type: c.Type ?? null,
    failureReason: c.FailureReason ?? null,
    keyAlgorithm: c.KeyAlgorithm ?? null,
    createdAt: iso(c.CreatedAt),
    issuedAt: iso(c.IssuedAt),
    notBefore: iso(c.NotBefore),
    notAfter: iso(c.NotAfter),
    inUseBy: c.InUseBy ?? [],
    renewalEligibility: c.RenewalEligibility ?? null,
    domainValidations,
    pendingValidation: domainValidations
      .filter((d) => d.validationStatus !== "SUCCESS")
      .map((d) => d.domainName),
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    collectedBy: EXTENSION_NAME,
  };
}

// =============================================================================
// Model
// =============================================================================

/**
 * Read-only ACM diagnostics. Methods: `list_certificates` (find certificates
 * by status or domain) and `describe_certificates` (fan-out DescribeCertificate
 * over many ARNs, with per-domain validation status, expected DNS records,
 * failure reasons and in-use resources).
 */
export const model = {
  type: "@webframp/aws/acm-diagnostics",
  version: "2026.10.13.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],

  resources: {
    certificate_list: {
      description: "ACM certificates matching a status / domain filter",
      schema: CertificateListSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
    certificate: {
      description:
        "One certificate's status, per-domain validation state, expected DNS records and in-use resources",
      schema: CertificateSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    describe_summary: {
      description:
        "Roll-up of one describe_certificates call: status counts, pending validations, in-use certificates, missing ARNs",
      schema: DescribeSummarySchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    list_certificates: {
      description:
        "List certificates, optionally filtered by status and a domain-name substring",
      arguments: z.object({
        statuses: z
          .array(z.enum([
            "PENDING_VALIDATION",
            "ISSUED",
            "INACTIVE",
            "EXPIRED",
            "VALIDATION_TIMED_OUT",
            "REVOKED",
            "FAILED",
          ]))
          .min(1, "omit statuses to list every status")
          .optional()
          .describe("Certificate status filter. Omit for all statuses."),
        domainContains: z.string().min(1).optional().describe(
          "Case-insensitive substring of the primary domain name or any " +
            "subject alternative name (client-side)",
        ),
        instanceName: userNameSchema(SUMMARY_DEFAULT_NAME).default(
          LIST_DEFAULT_NAME,
        ).describe(
          "Name for the stored certificate_list resource",
        ),
      }),
      execute: async (
        args: {
          statuses?: CertificateStatus[];
          domainContains?: string;
          instanceName: string;
        },
        context: Context,
      ) => {
        const startMs = Date.now();
        const client = makeClient(context.globalArgs);
        try {
          const certificates: z.infer<
            typeof CertificateListSchema
          >["certificates"] = [];
          const needle = args.domainContains?.toLowerCase();
          let nextToken: string | undefined;
          let pages = 0;
          do {
            let res;
            try {
              res = await client.send(
                new ListCertificatesCommand({
                  CertificateStatuses: args.statuses,
                  Includes: { keyTypes: ALL_KEY_TYPES },
                  CertificateKeyPairOrigins: ALL_KEY_PAIR_ORIGINS,
                  NextToken: nextToken,
                  MaxItems: 1000,
                }),
                { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
              );
            } catch (err) {
              throw new Error(
                `Failed to list ACM certificates (region=${context.globalArgs.region}): ${
                  errMsg(err)
                }`,
                { cause: err },
              );
            }
            for (const s of res.CertificateSummaryList ?? []) {
              const domain = s.DomainName ?? "";
              if (
                needle &&
                ![domain, ...(s.SubjectAlternativeNameSummaries ?? [])].some(
                  (d) => d.toLowerCase().includes(needle),
                )
              ) continue;
              certificates.push({
                certificateArn: s.CertificateArn ?? "",
                domainName: domain,
                status: s.Status ?? null,
                type: s.Type ?? null,
                inUse: s.InUse ?? null,
                createdAt: iso(s.CreatedAt),
                issuedAt: iso(s.IssuedAt),
                notAfter: iso(s.NotAfter),
              });
            }
            nextToken = res.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "certificate_list",
            args.instanceName,
            {
              certificates,
              count: certificates.length,
              truncated: Boolean(nextToken),
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info("Found {count} certificates", {
            count: certificates.length,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    describe_certificates: {
      description:
        "Describe many certificates in one call: per-domain validation status, the DNS records ACM expects, failure reason and in-use resources. A missing certificate is recorded as found=false, not an error.",
      arguments: z.object({
        certificateArns: z
          .array(
            z.string().regex(
              CERT_ARN_RE,
              "expected arn:aws:acm:<region>:<account>:certificate/<uuid>",
            ),
          )
          .min(1, "at least one certificate ARN required")
          .max(MAX_ARNS, `at most ${MAX_ARNS} ARNs per call`)
          .describe("Certificate ARNs to describe"),
        summaryName: userNameSchema(LIST_DEFAULT_NAME).default(
          SUMMARY_DEFAULT_NAME,
        ).describe(
          "Name for the stored describe_summary resource",
        ),
      }),
      execute: async (
        args: { certificateArns: string[]; summaryName: string },
        context: Context,
      ) => {
        const startMs = Date.now();
        const client = makeClient(context.globalArgs);
        try {
          const unique = [...new Set(args.certificateArns)];
          const certs: Certificate[] = [];
          // Sequential: one lock, bounded request rate (DescribeCertificate is
          // throttled), and stable output ordering. A total budget bounds the
          // loop; ARNs left when it runs out are reported as errored.
          for (const arn of unique) {
            if (Date.now() - startMs > DESCRIBE_BUDGET_MS) {
              certs.push(
                emptyCertificate(
                  arn,
                  "BudgetExceeded",
                  `not described: ${
                    DESCRIBE_BUDGET_MS / 1000
                  }s budget exhausted`,
                  Date.now(),
                ),
              );
              continue;
            }
            // An ARN for another region would be asked of this region's
            // endpoint; ACM could answer NotFound and a false "deleted" record
            // would be written. Flag it instead of calling the API.
            const arnRegion = arn.split(":")[3];
            if (arnRegion !== context.globalArgs.region) {
              certs.push(
                emptyCertificate(
                  arn,
                  "RegionMismatch",
                  `ARN is in ${arnRegion} but this model targets ${context.globalArgs.region}`,
                  Date.now(),
                ),
              );
              continue;
            }
            certs.push(await describeOne(client, arn));
          }

          // Write a record only when ACM gave an answer: the certificate was
          // described, or ACM confirmed it does not exist. Throttling, expired
          // credentials and the like must not overwrite the last good record
          // with an empty one; they surface under `errored` in the summary.
          const handles = [];
          const written = certs.filter((c) =>
            c.found || isNotFound(c.errorCode)
          );
          // The same UUID in another account keeps both records. Suffix every
          // member of a clash, not just the later one, so a record's name does
          // not depend on the order the ARNs were given in.
          // Counted over every requested ARN, not just the ones written this
          // run, so a certificate's name does not change when its twin errors.
          const uuidCount = new Map<string, number>();
          for (const arn of unique) {
            const n = certName(arn);
            uuidCount.set(n, (uuidCount.get(n) ?? 0) + 1);
          }
          for (const c of written) {
            let name = certName(c.certificateArn);
            if ((uuidCount.get(name) ?? 0) > 1) {
              name = `${name}-${await shortHash(c.certificateArn)}`;
            }
            handles.push(
              await context.writeResource("certificate", name, c),
            );
          }

          const byStatus: Record<string, number> = {};
          for (const c of certs) {
            if (!c.status) continue;
            byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
          }
          const summary = {
            requested: unique.length,
            found: certs.filter((c) => c.found).length,
            notFound: certs.filter((c) => isNotFound(c.errorCode)).map((c) =>
              c.certificateArn
            ),
            errored: certs
              .filter((c) => !c.found && !isNotFound(c.errorCode))
              .map((c) => ({
                certificateArn: c.certificateArn,
                errorCode: c.errorCode,
                error: c.error,
              })),
            byStatus,
            pendingValidation: certs
              .filter((c) => c.pendingValidation.length > 0)
              .map((c) => ({
                certificateArn: c.certificateArn,
                domains: c.pendingValidation,
              })),
            inUse: certs
              .filter((c) => c.inUseBy.length > 0)
              .map((c) => ({
                certificateArn: c.certificateArn,
                inUseBy: c.inUseBy,
              })),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          };
          handles.push(
            await context.writeResource(
              "describe_summary",
              args.summaryName,
              summary,
            ),
          );
          const counts = {
            found: summary.found,
            requested: summary.requested,
            pending: summary.pendingValidation.length,
            notFound: summary.notFound.length,
            errored: summary.errored.length,
          };
          context.logger.info(
            "{found}/{requested} certificates found, {pending} pending validation, {notFound} not found, {errored} errored",
            counts,
          );
          if (summary.errored.length > 0) {
            // A partial failure must not read as a clean run in the CLI output.
            context.logger.warn(
              "{errored} certificate(s) could not be described; see errored in the summary",
              counts,
            );
          }
          if (summary.found === 0 && summary.notFound.length === 0) {
            // Nothing was answered (bad credentials, throttling, no access):
            // a "successful" run with found=0 would read as a clean result.
            const first = summary.errored[0];
            throw new Error(
              `describe_certificates could not describe any of ${summary.requested} ` +
                `certificate(s) (region=${context.globalArgs.region}); first error: ` +
                `${first?.errorCode ?? "unknown"}: ${first?.error ?? ""}`,
            );
          }
          return { dataHandles: handles };
        } finally {
          client.destroy();
        }
      },
    },
  },
};
