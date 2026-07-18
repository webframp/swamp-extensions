/**
 * AWS DNS Observation Model — observe Route53 hosted zones, record sets, and
 * detect orphaned DNS records pointing at decommissioned infrastructure.
 *
 * This model reads Route53 data for observation and orphan detection. It does
 * not manage zones or records — use @swamp/aws/route53 for infrastructure
 * management.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  GetHostedZoneCommand,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
  type RRType,
} from "npm:@aws-sdk/client-route-53@3.1090.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1090.0";

const MAX_PAGES = 50;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z.string().default("us-east-1").describe(
    "AWS region (Route53 is global but STS needs a region)",
  ),
});

const HostedZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  recordCount: z.number(),
  comment: z.string().nullable(),
  vpcAssociations: z.array(z.object({
    vpcId: z.string(),
    vpcRegion: z.string(),
  })).default([]),
});

const RecordSetSchema = z.object({
  zoneId: z.string(),
  zoneName: z.string(),
  name: z.string(),
  type: z.string(),
  ttl: z.number().nullable(),
  values: z.array(z.string()),
  aliasTarget: z.object({
    dnsName: z.string(),
    hostedZoneId: z.string(),
    evaluateTargetHealth: z.boolean(),
  }).nullable(),
});

const OrphanedRecordSchema = z.object({
  zoneId: z.string(),
  zoneName: z.string(),
  recordName: z.string(),
  recordType: z.string(),
  target: z.string(),
  reason: z.string(),
});

const ZoneListSchema = z.object({
  fetchedAt: z.string(),
  accountId: z.string(),
  truncated: z.boolean(),
  zones: z.array(HostedZoneSchema),
  summary: z.object({
    totalZones: z.number(),
    publicZones: z.number(),
    privateZones: z.number(),
    totalRecords: z.number(),
  }),
});

const RecordListSchema = z.object({
  fetchedAt: z.string(),
  accountId: z.string(),
  truncated: z.boolean(),
  records: z.array(RecordSetSchema),
  summary: z.object({
    totalRecords: z.number(),
    zonesScanned: z.number(),
    byType: z.record(z.string(), z.number()),
  }),
});

const OrphanReportSchema = z.object({
  fetchedAt: z.string(),
  accountId: z.string(),
  truncated: z.boolean(),
  orphans: z.array(OrphanedRecordSchema),
  summary: z.object({
    totalOrphans: z.number(),
    byReason: z.record(z.string(), z.number()),
    zonesScanned: z.number(),
    recordsAnalyzed: z.number(),
  }),
});

// =============================================================================
// Context type
// =============================================================================

type DnsObservationContext = {
  globalArgs: { region: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instance: string,
  ) => Promise<{ attributes: Record<string, unknown> } | null>;
  dataRepository: {
    findBySpec: (
      modelName: string,
      specName: string,
    ) => Promise<
      Array<{ attributes: Record<string, unknown>; updatedAt?: string }>
    >;
  };
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
    warn: (msg: string, props: Record<string, unknown>) => void;
    error: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Helpers
// =============================================================================

async function getAccountId(region: string): Promise<string> {
  const sts = new STSClient({ region });
  try {
    const resp = await sts.send(new GetCallerIdentityCommand({}));
    return resp.Account ?? "unknown";
  } finally {
    sts.destroy();
  }
}

function stripTrailingDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function extractZoneId(fullId: string): string {
  return fullId.replace("/hostedzone/", "");
}

// Known AWS service DNS suffixes for alias target classification
const ELB_SUFFIXES = [
  ".elb.amazonaws.com",
  ".elb.us-gov.amazonaws.com",
];

const CLOUDFRONT_SUFFIXES = [
  ".cloudfront.net",
];

const S3_WEBSITE_PATTERNS = [
  ".s3-website-",
  ".s3-website.",
  ".s3.amazonaws.com",
];

const ELASTICBEANSTALK_SUFFIXES = [
  ".elasticbeanstalk.com",
];

function isPrivateOrReservedIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  // RFC 1918
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  // Loopback
  if (parts[0] === 127) return true;
  // Link-local
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function extractS3BucketName(target: string): string {
  const match = target.match(/^(.+?)\.s3(?:-website[-.]|\.)/);
  return match ? match[1] : target.split(".s3")[0];
}

function classifyTarget(
  target: string,
): "elb" | "cloudfront" | "s3" | "beanstalk" | "ec2_ip" | "other" {
  const lower = target.toLowerCase();
  if (ELB_SUFFIXES.some((s) => lower.endsWith(s))) return "elb";
  if (CLOUDFRONT_SUFFIXES.some((s) => lower.endsWith(s))) return "cloudfront";
  if (S3_WEBSITE_PATTERNS.some((p) => lower.includes(p))) return "s3";
  if (ELASTICBEANSTALK_SUFFIXES.some((s) => lower.endsWith(s))) {
    return "beanstalk";
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) {
    if (isPrivateOrReservedIp(target)) return "other";
    return "ec2_ip";
  }
  return "other";
}

// =============================================================================
// Orphan Detection Logic
// =============================================================================

interface KnownInfrastructure {
  elbDnsNames: Set<string>;
  cloudfrontDomains: Set<string>;
  s3Buckets: Set<string>;
  ec2PublicIps: Set<string>;
  elasticIps: Set<string>;
}

function buildKnownInfrastructure(
  inventoryAttrs: Record<string, unknown> | null,
  adoptAttrs: Record<string, unknown> | null,
): KnownInfrastructure {
  const known: KnownInfrastructure = {
    elbDnsNames: new Set(),
    cloudfrontDomains: new Set(),
    s3Buckets: new Set(),
    ec2PublicIps: new Set(),
    elasticIps: new Set(),
  };

  // From inventory scan data
  if (inventoryAttrs) {
    const ec2 = inventoryAttrs.ec2 as
      | Array<Record<string, unknown>>
      | undefined;
    if (ec2) {
      for (const instance of ec2) {
        const ip = instance.publicIpAddress as string | undefined;
        if (ip) known.ec2PublicIps.add(ip);
      }
    }

    const s3 = inventoryAttrs.s3 as Array<Record<string, unknown>> | undefined;
    if (s3) {
      for (const bucket of s3) {
        const name = bucket.bucketName as string | undefined;
        if (name) known.s3Buckets.add(name.toLowerCase());
      }
    }

    const elb = inventoryAttrs.elb as
      | Array<Record<string, unknown>>
      | undefined;
    if (elb) {
      for (const lb of elb) {
        const dns = lb.dnsName as string | undefined;
        if (dns) known.elbDnsNames.add(dns.toLowerCase());
      }
    }

    const elbv2 = inventoryAttrs.elbv2 as
      | Array<Record<string, unknown>>
      | undefined;
    if (elbv2) {
      for (const lb of elbv2) {
        const dns = lb.dnsName as string | undefined;
        if (dns) known.elbDnsNames.add(dns.toLowerCase());
      }
    }

    const cloudfront = inventoryAttrs.cloudfront as
      | Array<Record<string, unknown>>
      | undefined;
    if (cloudfront) {
      for (const dist of cloudfront) {
        const domain = dist.domainName as string | undefined;
        if (domain) known.cloudfrontDomains.add(domain.toLowerCase());
      }
    }
  }

  // From adopt discovery data
  if (adoptAttrs) {
    const eips = adoptAttrs.elasticIps as
      | Array<Record<string, unknown>>
      | undefined;
    if (eips) {
      for (const eip of eips) {
        const ip = eip.publicIp as string | undefined;
        if (ip) known.elasticIps.add(ip);
      }
    }
  }

  return known;
}

function stripDualstackPrefix(target: string): string {
  return target.startsWith("dualstack.") ? target.slice(10) : target;
}

function detectOrphan(
  record: z.infer<typeof RecordSetSchema>,
  known: KnownInfrastructure,
): z.infer<typeof OrphanedRecordSchema> | null {
  if (record.type === "NS" || record.type === "SOA") return null;

  if (record.aliasTarget) {
    const target = stripTrailingDot(record.aliasTarget.dnsName).toLowerCase();
    const targetType = classifyTarget(target);

    if (targetType === "elb") {
      if (known.elbDnsNames.size === 0) return null;
      const normalized = stripDualstackPrefix(target);
      if (!known.elbDnsNames.has(normalized)) {
        return {
          zoneId: record.zoneId,
          zoneName: record.zoneName,
          recordName: record.name,
          recordType: record.type,
          target,
          reason: "alias_target_elb_not_found",
        };
      }
    }
    if (targetType === "cloudfront") {
      if (known.cloudfrontDomains.size === 0) return null;
      if (!known.cloudfrontDomains.has(target)) {
        return {
          zoneId: record.zoneId,
          zoneName: record.zoneName,
          recordName: record.name,
          recordType: record.type,
          target,
          reason: "alias_target_cloudfront_not_found",
        };
      }
    }
    if (targetType === "s3") {
      if (known.s3Buckets.size === 0) return null;
      const bucketName = extractS3BucketName(target);
      if (!known.s3Buckets.has(bucketName.toLowerCase())) {
        return {
          zoneId: record.zoneId,
          zoneName: record.zoneName,
          recordName: record.name,
          recordType: record.type,
          target,
          reason: "alias_target_s3_bucket_not_found",
        };
      }
    }
    return null;
  }

  if (record.type === "A") {
    if (known.ec2PublicIps.size === 0 && known.elasticIps.size === 0) {
      return null;
    }
    for (const value of record.values) {
      if (isPrivateOrReservedIp(value)) continue;
      if (
        !known.ec2PublicIps.has(value) && !known.elasticIps.has(value)
      ) {
        return {
          zoneId: record.zoneId,
          zoneName: record.zoneName,
          recordName: record.name,
          recordType: record.type,
          target: value,
          reason: "a_record_ip_not_in_inventory",
        };
      }
    }
  }

  if (record.type === "CNAME") {
    for (const value of record.values) {
      const target = stripTrailingDot(value).toLowerCase();
      const targetType = classifyTarget(target);

      if (targetType === "elb") {
        if (known.elbDnsNames.size === 0) continue;
        const normalized = stripDualstackPrefix(target);
        if (!known.elbDnsNames.has(normalized)) {
          return {
            zoneId: record.zoneId,
            zoneName: record.zoneName,
            recordName: record.name,
            recordType: record.type,
            target,
            reason: "cname_target_elb_not_found",
          };
        }
      }
      if (targetType === "cloudfront") {
        if (known.cloudfrontDomains.size === 0) continue;
        if (!known.cloudfrontDomains.has(target)) {
          return {
            zoneId: record.zoneId,
            zoneName: record.zoneName,
            recordName: record.name,
            recordType: record.type,
            target,
            reason: "cname_target_cloudfront_not_found",
          };
        }
      }
      if (targetType === "s3") {
        if (known.s3Buckets.size === 0) continue;
        const bucketName = extractS3BucketName(target);
        if (!known.s3Buckets.has(bucketName.toLowerCase())) {
          return {
            zoneId: record.zoneId,
            zoneName: record.zoneName,
            recordName: record.name,
            recordType: record.type,
            target,
            reason: "cname_target_s3_bucket_not_found",
          };
        }
      }
      if (targetType === "beanstalk") continue;
    }
  }

  return null;
}

// =============================================================================
// Model
// =============================================================================

/** AWS Route 53 DNS observation model — discovers hosted zones, records, health checks, and query logging configuration. */
export const model = {
  type: "@webframp/aws/dns-observation",
  version: "2026.07.18.2",
  upgrades: [
    {
      toVersion: "2026.07.18.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,

  resources: {
    zones: {
      description: "Hosted zone inventory",
      schema: ZoneListSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
    records: {
      description: "Record set inventory across zones",
      schema: RecordListSchema,
      lifetime: "6h" as const,
      garbageCollection: 3,
    },
    orphans: {
      description:
        "Orphaned DNS records pointing at decommissioned infrastructure",
      schema: OrphanReportSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    list_zones: {
      description:
        "List all Route53 hosted zones with record counts and metadata.",
      arguments: z.object({
        includePrivate: z.boolean().optional().default(true).describe(
          "Include private hosted zones in results",
        ),
      }),
      execute: async (
        args: { includePrivate?: boolean },
        context: DnsObservationContext,
      ) => {
        const region = context.globalArgs.region;
        const accountId = await getAccountId(region);
        const client = new Route53Client({ region });

        try {
          const zones: z.infer<typeof HostedZoneSchema>[] = [];
          let marker: string | undefined;
          let pages = 0;

          do {
            const resp = await client.send(
              new ListHostedZonesCommand({ Marker: marker }),
            );

            for (const zone of resp.HostedZones ?? []) {
              if (!zone.Id || !zone.Name) continue;
              const isPrivate = zone.Config?.PrivateZone ?? false;
              if (!args.includePrivate && isPrivate) continue;

              const zoneId = extractZoneId(zone.Id);
              let vpcAssociations: Array<
                { vpcId: string; vpcRegion: string }
              > = [];

              if (isPrivate) {
                try {
                  const detail = await client.send(
                    new GetHostedZoneCommand({ Id: zone.Id }),
                  );
                  vpcAssociations = (detail.VPCs ?? [])
                    .filter((v) => v.VPCId && v.VPCRegion)
                    .map((v) => ({
                      vpcId: v.VPCId!,
                      vpcRegion: v.VPCRegion!,
                    }));
                } catch {
                  // Non-critical — proceed without VPC data
                }
              }

              zones.push({
                id: zoneId,
                name: stripTrailingDot(zone.Name),
                isPrivate,
                recordCount: zone.ResourceRecordSetCount ?? 0,
                comment: zone.Config?.Comment ?? null,
                vpcAssociations,
              });
            }

            marker = resp.NextMarker;
            pages++;
          } while (marker && pages < MAX_PAGES);

          const truncated = !!marker;
          const publicZones = zones.filter((z) => !z.isPrivate).length;
          const result: z.infer<typeof ZoneListSchema> = {
            fetchedAt: new Date().toISOString(),
            accountId,
            truncated,
            zones,
            summary: {
              totalZones: zones.length,
              publicZones,
              privateZones: zones.length - publicZones,
              totalRecords: zones.reduce((sum, z) => sum + z.recordCount, 0),
            },
          };

          const handle = await context.writeResource("zones", "latest", result);

          context.logger.info("Listed {count} hosted zones", {
            count: zones.length,
            public: publicZones,
            private: zones.length - publicZones,
          });

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_records: {
      description:
        "List all record sets across hosted zones. Primary output for drift-state consumption.",
      arguments: z.object({
        zoneFilter: z.array(z.string()).optional().describe(
          "Limit to specific zone IDs. Omit for all zones.",
        ),
        typeFilter: z.array(z.string()).optional().describe(
          "Limit to specific record types (A, AAAA, CNAME, etc.)",
        ),
      }),
      execute: async (
        args: { zoneFilter?: string[]; typeFilter?: string[] },
        context: DnsObservationContext,
      ) => {
        const region = context.globalArgs.region;
        const accountId = await getAccountId(region);
        const client = new Route53Client({ region });

        try {
          // Get zones — either from filter or list all
          const zoneIds: Array<{ id: string; name: string }> = [];
          let zoneListTruncated = false;

          if (args.zoneFilter && args.zoneFilter.length > 0) {
            for (const id of args.zoneFilter) {
              try {
                const detail = await client.send(
                  new GetHostedZoneCommand({ Id: id }),
                );
                const name = detail.HostedZone?.Name
                  ? stripTrailingDot(detail.HostedZone.Name)
                  : id;
                zoneIds.push({ id, name });
              } catch {
                zoneIds.push({ id, name: id });
              }
            }
          } else {
            let marker: string | undefined;
            let pages = 0;
            do {
              const resp = await client.send(
                new ListHostedZonesCommand({ Marker: marker }),
              );
              for (const zone of resp.HostedZones ?? []) {
                if (!zone.Id || !zone.Name) continue;
                zoneIds.push({
                  id: extractZoneId(zone.Id),
                  name: stripTrailingDot(zone.Name),
                });
              }
              marker = resp.NextMarker;
              pages++;
            } while (marker && pages < MAX_PAGES);
            if (marker) zoneListTruncated = true;
          }

          const records: z.infer<typeof RecordSetSchema>[] = [];
          const byType: Record<string, number> = {};
          let truncated = zoneListTruncated;

          for (const zone of zoneIds) {
            try {
              let startName: string | undefined;
              let startType: RRType | undefined;
              let pages = 0;

              do {
                const resp = await client.send(
                  new ListResourceRecordSetsCommand({
                    HostedZoneId: zone.id,
                    StartRecordName: startName,
                    StartRecordType: startType,
                  }),
                );

                for (const rrs of resp.ResourceRecordSets ?? []) {
                  if (!rrs.Name || !rrs.Type) continue;
                  if (
                    args.typeFilter && args.typeFilter.length > 0 &&
                    !args.typeFilter.includes(rrs.Type)
                  ) {
                    continue;
                  }

                  const values = (rrs.ResourceRecords ?? [])
                    .map((r) => r.Value)
                    .filter((v): v is string => !!v);

                  const aliasTarget = rrs.AliasTarget
                    ? {
                      dnsName: stripTrailingDot(
                        rrs.AliasTarget.DNSName ?? "",
                      ),
                      hostedZoneId: rrs.AliasTarget.HostedZoneId ?? "",
                      evaluateTargetHealth:
                        rrs.AliasTarget.EvaluateTargetHealth ?? false,
                    }
                    : null;

                  records.push({
                    zoneId: zone.id,
                    zoneName: zone.name || stripTrailingDot(rrs.Name),
                    name: stripTrailingDot(rrs.Name),
                    type: rrs.Type,
                    ttl: rrs.TTL ?? null,
                    values,
                    aliasTarget,
                  });

                  byType[rrs.Type] = (byType[rrs.Type] ?? 0) + 1;
                }

                if (resp.IsTruncated) {
                  startName = resp.NextRecordName;
                  startType = resp.NextRecordType;
                } else {
                  break;
                }
                pages++;
              } while (pages < MAX_PAGES);
              if (pages >= MAX_PAGES) truncated = true;
            } catch {
              context.logger.warn("Failed to list records for zone", {
                zoneId: zone.id,
              });
            }
          }

          const result: z.infer<typeof RecordListSchema> = {
            fetchedAt: new Date().toISOString(),
            accountId,
            truncated,
            records,
            summary: {
              totalRecords: records.length,
              zonesScanned: zoneIds.length,
              byType,
            },
          };

          const handle = await context.writeResource(
            "records",
            "record-scan",
            result,
          );

          context.logger.info(
            "Listed {count} records across {zones} zones",
            { count: records.length, zones: zoneIds.length },
          );

          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    detect_orphans: {
      description:
        "Cross-reference DNS records against inventory to find orphaned records pointing at decommissioned infrastructure.",
      arguments: z.object({
        inventoryModelName: z.string().optional().default("aws-inventory")
          .describe("Name of the @webframp/aws/inventory model instance"),
        adoptModelName: z.string().optional().default("aws-adopt").describe(
          "Name of the @webframp/aws/adopt model instance",
        ),
        skipTypes: z.array(z.string()).optional().default(["TXT", "MX", "SRV"])
          .describe("Record types to skip during orphan detection"),
      }),
      execute: async (
        args: {
          inventoryModelName: string;
          adoptModelName: string;
          skipTypes: string[];
        },
        context: DnsObservationContext,
      ) => {
        const region = context.globalArgs.region;
        const accountId = await getAccountId(region);

        // Read records from our own stored data
        let recordsData: z.infer<typeof RecordListSchema> | null = null;
        try {
          const stored = await context.readResource("record-scan");
          if (stored) {
            recordsData = stored.attributes as unknown as z.infer<
              typeof RecordListSchema
            >;
          }
        } catch {
          // No records data yet
        }

        if (!recordsData || recordsData.records.length === 0) {
          context.logger.warn("No record data available", {
            hint: "Run list_records first",
          });
          const handle = await context.writeResource("orphans", "latest", {
            fetchedAt: new Date().toISOString(),
            accountId,
            truncated: false,
            orphans: [],
            summary: {
              totalOrphans: 0,
              byReason: {},
              zonesScanned: 0,
              recordsAnalyzed: 0,
            },
          });
          return { dataHandles: [handle] };
        }

        // Read inventory data for cross-reference
        let inventoryAttrs: Record<string, unknown> | null = null;
        try {
          const data = await context.dataRepository.findBySpec(
            args.inventoryModelName,
            "scan",
          );
          if (data.length > 0) {
            const sorted = data.filter((d) => d.updatedAt).sort((a, b) =>
              new Date(b.updatedAt!).getTime() -
              new Date(a.updatedAt!).getTime()
            );
            inventoryAttrs = (sorted[0] ?? data[0]).attributes;
          }
        } catch {
          context.logger.warn("Could not read inventory data", {
            model: args.inventoryModelName,
          });
        }

        // Read adopt data for EIP cross-reference
        let adoptAttrs: Record<string, unknown> | null = null;
        try {
          const data = await context.dataRepository.findBySpec(
            args.adoptModelName,
            "discovery",
          );
          if (data.length > 0) {
            const sorted = data.filter((d) => d.updatedAt).sort((a, b) =>
              new Date(b.updatedAt!).getTime() -
              new Date(a.updatedAt!).getTime()
            );
            adoptAttrs = (sorted[0] ?? data[0]).attributes;
          }
        } catch {
          context.logger.warn("Could not read adopt data", {
            model: args.adoptModelName,
          });
        }

        if (!inventoryAttrs && !adoptAttrs) {
          context.logger.warn(
            "No upstream data available — orphan detection will be limited",
            { hint: "Run inventory scan and/or adopt discover first" },
          );
        } else if (!inventoryAttrs) {
          context.logger.warn(
            "Inventory data absent — ELB, CloudFront, S3, and IP checks skipped",
            { hint: "Run inventory scan for full orphan detection" },
          );
        } else if (!adoptAttrs) {
          context.logger.warn(
            "Adopt data absent — Elastic IP checks skipped",
            { hint: "Run adopt discover for Elastic IP cross-reference" },
          );
        }

        const known = buildKnownInfrastructure(inventoryAttrs, adoptAttrs);
        const orphans: z.infer<typeof OrphanedRecordSchema>[] = [];
        let recordsAnalyzed = 0;

        for (const record of recordsData.records) {
          if (args.skipTypes.includes(record.type)) continue;
          if (record.type === "NS" || record.type === "SOA") continue;
          recordsAnalyzed++;
          const orphan = detectOrphan(record, known);
          if (orphan) orphans.push(orphan);
        }

        const byReason: Record<string, number> = {};
        for (const o of orphans) {
          byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
        }

        const result: z.infer<typeof OrphanReportSchema> = {
          fetchedAt: new Date().toISOString(),
          accountId,
          truncated: recordsData.truncated ?? false,
          orphans,
          summary: {
            totalOrphans: orphans.length,
            byReason,
            zonesScanned: recordsData.summary.zonesScanned,
            recordsAnalyzed,
          },
        };

        const handle = await context.writeResource("orphans", "latest", result);

        context.logger.info("Orphan detection complete", {
          orphans: orphans.length,
          recordsAnalyzed,
          zones: recordsData.summary.zonesScanned,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
