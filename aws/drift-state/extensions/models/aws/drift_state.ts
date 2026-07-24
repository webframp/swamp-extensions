/**
 * Unified drift detection model for swamp.
 *
 * Composes observations from upstream models (adopt, inventory, terraform, config, dns, event_topology) into
 * a queryable drift surface. Makes zero AWS API calls — purely data-layer
 * composition via dataRepository.findBySpec().
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({});

const DriftStatus = z.enum(["in_sync", "drifted", "unknown"]);

const ChangedAttributeSchema = z.object({
  path: z.string(),
  baseline: z.unknown(),
  current: z.unknown(),
});

const DriftResourceSchema = z.object({
  canonicalId: z.string(),
  resourceType: z.string(),
  account: z.string().optional(),
  region: z.string().optional(),
  driftStatus: DriftStatus,
  changedAttributes: z.array(ChangedAttributeSchema).default([]),
  detectionSource: z.string(),
  firstDriftDetected: z.string().nullable(),
  lastChecked: z.string(),
});

const DriftSummarySchema = z.object({
  totalResources: z.number(),
  inSync: z.number(),
  drifted: z.number(),
  unknown: z.number(),
  driftRate: z.number(),
  oldestDrift: z.string().nullable(),
  unavailableSources: z.array(z.string()),
  staleSources: z.array(z.string()),
});

const DriftResultSchema = z.object({
  computedAt: z.string(),
  summary: DriftSummarySchema,
  resources: z.array(DriftResourceSchema),
});

const BaselineEntrySchema = z.object({
  canonicalId: z.string(),
  resourceType: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
});

const BaselineSchema = z.object({
  setAt: z.string(),
  source: z.string(),
  entries: z.array(BaselineEntrySchema),
});

const TimelineEventSchema = z.object({
  timestamp: z.string(),
  status: DriftStatus,
  changedAttributes: z.array(z.string()),
});

const TimelineSchema = z.object({
  canonicalId: z.string(),
  events: z.array(TimelineEventSchema),
});

const VelocitySchema = z.object({
  computedAt: z.string(),
  byResourceType: z.record(
    z.string(),
    z.object({
      driftRate: z.number(),
      driftedCount: z.number(),
      totalCount: z.number(),
    }),
  ),
  byTimeWindow: z.object({
    last24h: z.number(),
    last7d: z.number(),
    last30d: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Serialize a value with sorted keys and sorted arrays for stable comparison.
 * Key reordering and array element reordering (e.g., AWS Tags) produce
 * identical strings.
 */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) {
    const elements = v.map(canonicalJson);
    elements.sort();
    return "[" + elements.join(",") + "]";
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return "{" +
      Object.keys(obj).sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
        .join(",") +
      "}";
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Deep-diff two objects. Returns changed fields with their baseline and
 * current values.
 */
function diffObjects(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
): Array<{ path: string; baseline: unknown; current: unknown }> {
  const diffs: Array<{ path: string; baseline: unknown; current: unknown }> =
    [];
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const key of allKeys) {
    const a = baseline[key];
    const b = current[key];
    if (canonicalJson(a) !== canonicalJson(b)) {
      diffs.push({ path: key, baseline: a, current: b });
    }
  }
  return diffs;
}

/** Short hash for use in resource instance names. */
function hashId(canonicalId: string): string {
  let hash = 0;
  for (let i = 0; i < canonicalId.length; i++) {
    const ch = canonicalId.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface NormalizedResource {
  canonicalId: string;
  resourceType: string;
  account?: string;
  region?: string;
  snapshot: Record<string, unknown>;
  source: string;
}

function normalizeAdoptResources(
  attrs: Record<string, unknown>,
): NormalizedResource[] {
  const results: NormalizedResource[] = [];

  const resourceTypes: Array<{
    key: string;
    type: string;
    idField: string;
  }> = [
    { key: "vpcs", type: "AWS::EC2::VPC", idField: "vpcId" },
    { key: "subnets", type: "AWS::EC2::Subnet", idField: "subnetId" },
    {
      key: "internetGateways",
      type: "AWS::EC2::InternetGateway",
      idField: "internetGatewayId",
    },
    {
      key: "routeTables",
      type: "AWS::EC2::RouteTable",
      idField: "routeTableId",
    },
    {
      key: "securityGroups",
      type: "AWS::EC2::SecurityGroup",
      idField: "groupId",
    },
    { key: "rdsClusters", type: "AWS::RDS::DBCluster", idField: "clusterId" },
    {
      key: "rdsInstances",
      type: "AWS::RDS::DBInstance",
      idField: "instanceId",
    },
    {
      key: "dbSubnetGroups",
      type: "AWS::RDS::DBSubnetGroup",
      idField: "name",
    },
    {
      key: "secrets",
      type: "AWS::SecretsManager::Secret",
      idField: "arn",
    },
  ];

  for (const rt of resourceTypes) {
    const items = attrs[rt.key] as Array<Record<string, unknown>> | undefined;
    if (!items || !Array.isArray(items)) continue;

    for (const item of items) {
      const id = item[rt.idField] as string | undefined;
      if (!id) continue;

      const canonicalId = (item.arn as string) ??
        `adopt:${rt.type}:${id}`;

      results.push({
        canonicalId,
        resourceType: rt.type,
        snapshot: item,
        source: "adopt",
      });
    }
  }

  return results;
}

function normalizeInventoryResources(
  attrs: Record<string, unknown>,
): NormalizedResource[] {
  const results: NormalizedResource[] = [];

  const typeMapping: Record<string, string> = {
    ec2: "AWS::EC2::Instance",
    rds: "AWS::RDS::DBInstance",
    dynamodb: "AWS::DynamoDB::Table",
    lambda: "AWS::Lambda::Function",
    s3: "AWS::S3::Bucket",
    ebs: "AWS::EC2::Volume",
  };

  for (const [key, awsType] of Object.entries(typeMapping)) {
    const items = attrs[key] as Array<Record<string, unknown>> | undefined;
    if (!items || !Array.isArray(items)) continue;

    for (const item of items) {
      const arn = item.arn as string | undefined;
      const id = arn ?? item.instanceId ?? item.tableArn ?? item.functionArn ??
        item.bucketName ?? item.volumeId;
      if (!id) continue;

      const canonicalId = arn ?? `inventory:${awsType}:${String(id)}`;

      results.push({
        canonicalId,
        resourceType: awsType,
        account: item.account as string | undefined,
        region: item.region as string | undefined,
        snapshot: item,
        source: "inventory",
      });
    }
  }

  return results;
}

function normalizeTerraformResources(
  attrs: Record<string, unknown>,
): NormalizedResource[] {
  const results: NormalizedResource[] = [];

  const resources = attrs.resources as
    | Array<Record<string, unknown>>
    | undefined;
  if (!resources || !Array.isArray(resources)) return results;

  for (const res of resources) {
    const values = (res.values ?? {}) as Record<string, unknown>;
    const tfType = res.type as string ?? "unknown";
    const arn = values.arn as string | undefined;
    const id = values.id as string | undefined;

    const canonicalId = arn ??
      (id ? `terraform:${tfType}:${id}` : `terraform:${tfType}:${res.address}`);

    results.push({
      canonicalId,
      resourceType: tfType,
      snapshot: values,
      source: "terraform",
    });
  }

  return results;
}

function normalizeConfigResources(
  attrs: Record<string, unknown>,
): NormalizedResource[] {
  const results: NormalizedResource[] = [];
  const evaluations = attrs.evaluations as
    | Array<Record<string, unknown>>
    | undefined;
  if (!evaluations || !Array.isArray(evaluations)) return results;

  for (const eval_ of evaluations) {
    if (eval_.complianceType !== "NON_COMPLIANT") continue;
    const resourceId = eval_.resourceId as string | undefined;
    const resourceType = eval_.resourceType as string | undefined;
    if (!resourceId || !resourceType) continue;
    const resourceArn = eval_.resourceArn as string | undefined;
    const canonicalId = (resourceArn && resourceArn.length > 0)
      ? resourceArn
      : `config:${resourceType}:${resourceId}`;

    results.push({
      canonicalId,
      resourceType,
      account: eval_.accountId as string | undefined,
      region: eval_.region as string | undefined,
      snapshot: eval_ as Record<string, unknown>,
      source: "config",
    });
  }

  return results;
}

function normalizeDnsResources(
  attrs: Record<string, unknown>,
): NormalizedResource[] {
  const results: NormalizedResource[] = [];
  const orphans = attrs.orphans as
    | Array<Record<string, unknown>>
    | undefined;
  if (!orphans || !Array.isArray(orphans)) return results;

  for (const orphan of orphans) {
    const recordName = orphan.recordName as string | undefined;
    const target = orphan.target as string | undefined;
    const recordType = orphan.recordType as string | undefined;
    const zoneId = orphan.zoneId as string | undefined;
    if (!recordName || !target) continue;

    const canonicalId = `dns:${zoneId || "unknown"}:${recordName}:${target}`;

    results.push({
      canonicalId,
      resourceType: `AWS::Route53::${recordType || "Record"}`,
      snapshot: orphan as Record<string, unknown>,
      source: "dns",
    });
  }

  return results;
}

function normalizeTopologyResources(
  attrs: Record<string, unknown>,
): NormalizedResource[] {
  const results: NormalizedResource[] = [];
  const nodes = attrs.nodes as
    | Array<Record<string, unknown>>
    | undefined;
  if (!nodes || !Array.isArray(nodes)) return results;

  for (const node of nodes) {
    const id = node.id as string | undefined;
    const type = node.type as string | undefined;
    if (!id || !type) continue;

    results.push({
      canonicalId: id,
      resourceType: `AWS::Events::${type}`,
      account: node.accountId as string | undefined,
      region: node.region as string | undefined,
      snapshot: node as Record<string, unknown>,
      source: "event_topology",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Context Type
// ---------------------------------------------------------------------------

type ModelContext = {
  globalArgs: Record<string, never>;
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

// ---------------------------------------------------------------------------
// Source Configuration
// ---------------------------------------------------------------------------

const SOURCES = {
  adopt: { specName: "discovery", defaultModelName: "aws-adopt" },
  inventory: { specName: "scan", defaultModelName: "aws-inventory" },
  terraform: { specName: "read_state", defaultModelName: "terraform" },
  config: { specName: "compliance", defaultModelName: "aws-config-compliance" },
  dns: { specName: "orphans", defaultModelName: "aws-dns-observation" },
  event_topology: { specName: "graph", defaultModelName: "aws-event-topology" },
} as const;

type SourceName = keyof typeof SOURCES;

const NORMALIZERS: Record<
  SourceName,
  (attrs: Record<string, unknown>) => NormalizedResource[]
> = {
  adopt: normalizeAdoptResources,
  inventory: normalizeInventoryResources,
  terraform: normalizeTerraformResources,
  config: normalizeConfigResources,
  dns: normalizeDnsResources,
  event_topology: normalizeTopologyResources,
};

// ---------------------------------------------------------------------------
// Model Definition
// ---------------------------------------------------------------------------

/** Unified drift detection model composing upstream observations into queryable state. */
export const model = {
  type: "@webframp/aws/drift-state",
  version: "2026.07.24.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.20.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    driftResult: {
      description: "Computed drift state across all sources",
      schema: DriftResultSchema,
      lifetime: "6h" as const,
      garbageCollection: 10,
    },
    baseline: {
      description: "Baseline snapshots per upstream source",
      schema: BaselineSchema,
      lifetime: "30d" as const,
      garbageCollection: 3,
    },
    timeline: {
      description: "Drift status change history per resource",
      schema: TimelineSchema,
      lifetime: "90d" as const,
      garbageCollection: 1,
    },
    drifted: {
      description: "Filtered view of currently drifted resources",
      schema: z.object({ resources: z.array(DriftResourceSchema) }),
      lifetime: "1h" as const,
      garbageCollection: 1,
    },
    velocity: {
      description: "Drift rate metrics",
      schema: VelocitySchema,
      lifetime: "1h" as const,
      garbageCollection: 1,
    },
  },

  methods: {
    compute_drift: {
      description:
        "Compare latest upstream snapshots against stored baselines to detect drift across adopt, inventory, terraform, config, dns, and event_topology sources.",
      arguments: z.object({
        sources: z.array(
          z.enum([
            "adopt",
            "inventory",
            "terraform",
            "config",
            "dns",
            "event_topology",
          ]),
        ).optional()
          .describe("Upstream sources to compose. Omit for all available."),
        adoptModelName: z.string().optional().default("aws-adopt").describe(
          "Name of the @webframp/aws/adopt model instance",
        ),
        inventoryModelName: z.string().optional().default("aws-inventory")
          .describe("Name of the @webframp/aws/inventory model instance"),
        terraformModelName: z.string().optional().default("terraform").describe(
          "Name of the @webframp/terraform model instance",
        ),
        configModelName: z.string().optional().default(
          "aws-config-compliance",
        ).describe(
          "Name of the @webframp/aws/config-compliance model instance",
        ),
        dnsModelName: z.string().optional().default(
          "aws-dns-observation",
        ).describe(
          "Name of the @webframp/aws/dns-observation model instance",
        ),
        topologyModelName: z.string().optional().default(
          "aws-event-topology",
        ).describe(
          "Name of the @webframp/aws/event-topology model instance",
        ),
        staleThresholdMinutes: z.number().optional().default(1440).describe(
          "Data older than this (minutes) is flagged as stale",
        ),
      }),
      execute: async (
        args: {
          sources?: string[];
          adoptModelName: string;
          inventoryModelName: string;
          terraformModelName: string;
          configModelName: string;
          dnsModelName: string;
          topologyModelName: string;
          staleThresholdMinutes: number;
        },
        context: ModelContext,
      ) => {
        const now = new Date();
        const activeSources: SourceName[] =
          (args.sources as SourceName[] | undefined) ??
            ([
              "adopt",
              "inventory",
              "terraform",
              "config",
              "dns",
              "event_topology",
            ] as SourceName[]);

        const modelNames: Record<SourceName, string> = {
          adopt: args.adoptModelName,
          inventory: args.inventoryModelName,
          terraform: args.terraformModelName,
          config: args.configModelName,
          dns: args.dnsModelName,
          event_topology: args.topologyModelName,
        };

        const unavailableSources: string[] = [];
        const staleSources: string[] = [];
        const allResources: NormalizedResource[] = [];

        // Read upstream data for each active source
        for (const source of activeSources) {
          const config = SOURCES[source];
          const modelName = modelNames[source];

          try {
            const data = await context.dataRepository.findBySpec(
              modelName,
              config.specName,
            );

            if (data.length === 0) {
              unavailableSources.push(source);
              context.logger.warn("No upstream data available", {
                source,
                modelName,
              });
              continue;
            }

            // Pick latest by updatedAt
            const sorted = data.filter((d) => d.updatedAt).sort((a, b) =>
              new Date(b.updatedAt!).getTime() -
              new Date(a.updatedAt!).getTime()
            );
            const latest = sorted[0] ?? data[0];

            // Check staleness — no timestamp means unknown age, treat as stale
            if (!latest.updatedAt) {
              staleSources.push(source);
              context.logger.warn("Source data has no timestamp", {
                source,
                modelName,
              });
            } else {
              const age =
                (now.getTime() - new Date(latest.updatedAt).getTime()) /
                60000;
              if (age > args.staleThresholdMinutes) {
                staleSources.push(source);
              }
            }

            // Normalize resources from this source
            const normalized = NORMALIZERS[source](latest.attributes);
            allResources.push(...normalized);
          } catch (err) {
            unavailableSources.push(source);
            context.logger.warn("Failed to read upstream data", {
              source,
              modelName,
              error: String(err),
            });
          }
        }

        // Read baselines and compute drift
        const driftResources: z.infer<typeof DriftResourceSchema>[] = [];

        for (const source of activeSources) {
          if (unavailableSources.includes(source)) continue;

          const sourceResources = allResources.filter((r) =>
            r.source === source
          );

          // Read stored baseline for this source
          let baselineMap: Map<
            string,
            { snapshot: Record<string, unknown>; resourceType: string }
          > = new Map();
          try {
            const baselineData = await context.readResource(source);
            if (baselineData) {
              const entries = (baselineData.attributes.entries as Array<{
                canonicalId: string;
                resourceType: string;
                snapshot: Record<string, unknown>;
              }>) ?? [];
              baselineMap = new Map(
                entries.map((e) => [e.canonicalId, {
                  snapshot: e.snapshot,
                  resourceType: e.resourceType,
                }]),
              );
            }
          } catch {
            // No baseline stored yet
          }

          for (const resource of sourceResources) {
            const baselineEntry = baselineMap.get(resource.canonicalId);

            if (!baselineEntry) {
              driftResources.push({
                canonicalId: resource.canonicalId,
                resourceType: resource.resourceType,
                account: resource.account,
                region: resource.region,
                driftStatus: "unknown",
                changedAttributes: [],
                detectionSource: source,
                firstDriftDetected: null,
                lastChecked: now.toISOString(),
              });
              continue;
            }

            const diffs = diffObjects(
              baselineEntry.snapshot,
              resource.snapshot,
            );

            if (diffs.length === 0) {
              driftResources.push({
                canonicalId: resource.canonicalId,
                resourceType: resource.resourceType,
                account: resource.account,
                region: resource.region,
                driftStatus: "in_sync",
                changedAttributes: [],
                detectionSource: source,
                firstDriftDetected: null,
                lastChecked: now.toISOString(),
              });
            } else {
              // Check if previously drifted to preserve firstDriftDetected
              let firstDriftDetected: string | null = null;
              try {
                const timelineData = await context.readResource(
                  `timeline-${hashId(resource.canonicalId)}`,
                );
                if (timelineData) {
                  const events = (timelineData.attributes.events as Array<{
                    timestamp: string;
                    status: string;
                  }>) ?? [];
                  const firstDrift = events.find((e) => e.status === "drifted");
                  firstDriftDetected = firstDrift?.timestamp ?? null;
                }
              } catch {
                // No timeline yet
              }

              driftResources.push({
                canonicalId: resource.canonicalId,
                resourceType: resource.resourceType,
                account: resource.account,
                region: resource.region,
                driftStatus: "drifted",
                changedAttributes: diffs,
                detectionSource: source,
                firstDriftDetected: firstDriftDetected ?? now.toISOString(),
                lastChecked: now.toISOString(),
              });
            }
          }

          // Check for resources in baseline that are missing from current
          for (const [canonicalId, entry] of baselineMap) {
            const exists = sourceResources.some((r) =>
              r.canonicalId === canonicalId
            );
            if (!exists) {
              driftResources.push({
                canonicalId,
                resourceType: entry.resourceType,
                driftStatus: "drifted",
                changedAttributes: [
                  {
                    path: "_resource",
                    baseline: "present",
                    current: "missing",
                  },
                ],
                detectionSource: source,
                firstDriftDetected: now.toISOString(),
                lastChecked: now.toISOString(),
              });
            }
          }
        }

        // Compute summary
        const inSync =
          driftResources.filter((r) => r.driftStatus === "in_sync").length;
        const drifted =
          driftResources.filter((r) => r.driftStatus === "drifted").length;
        const unknown =
          driftResources.filter((r) => r.driftStatus === "unknown").length;
        const assessable = driftResources.length - unknown;
        const driftRate = assessable > 0 ? drifted / assessable : 0;

        const driftDates = driftResources
          .filter((r) => r.firstDriftDetected)
          .map((r) => r.firstDriftDetected!)
          .sort();
        const oldestDrift = driftDates[0] ?? null;

        const result: z.infer<typeof DriftResultSchema> = {
          computedAt: now.toISOString(),
          summary: {
            totalResources: driftResources.length,
            inSync,
            drifted,
            unknown,
            driftRate,
            oldestDrift,
            unavailableSources,
            staleSources,
          },
          resources: driftResources,
        };

        // Update timelines — only write on status transitions
        for (const resource of driftResources) {
          if (resource.driftStatus === "unknown") continue;

          const instanceName = `timeline-${hashId(resource.canonicalId)}`;
          let events: z.infer<typeof TimelineEventSchema>[] = [];

          try {
            const existing = await context.readResource(instanceName);
            if (existing) {
              events = (existing.attributes.events as z.infer<
                typeof TimelineEventSchema
              >[]) ?? [];
            }
          } catch {
            // No existing timeline
          }

          // Skip in_sync resources with no prior timeline (no information value)
          if (resource.driftStatus === "in_sync" && events.length === 0) {
            continue;
          }

          const lastEvent = events[events.length - 1];
          if (!lastEvent || lastEvent.status !== resource.driftStatus) {
            events.push({
              timestamp: now.toISOString(),
              status: resource.driftStatus,
              changedAttributes: resource.changedAttributes.map(
                (c: { path: string }) => c.path,
              ),
            });

            await context.writeResource("timeline", instanceName, {
              canonicalId: resource.canonicalId,
              events,
            });
          }
        }

        const handle = await context.writeResource(
          "driftResult",
          "latest",
          result,
        );

        context.logger.info("Drift computation complete", {
          total: driftResources.length,
          drifted,
          inSync,
          unknown,
          driftRate: Math.round(driftRate * 100),
        });

        return { dataHandles: [handle] };
      },
    },

    set_baseline: {
      description:
        "Set baseline from current upstream data. Future compute_drift runs compare against this baseline.",
      arguments: z.object({
        source: z.enum([
          "adopt",
          "inventory",
          "terraform",
          "config",
          "dns",
          "event_topology",
          "all",
        ])
          .default("all")
          .describe("Which upstream source to baseline"),
        adoptModelName: z.string().optional().default("aws-adopt").describe(
          "Name of the @webframp/aws/adopt model instance",
        ),
        inventoryModelName: z.string().optional().default("aws-inventory")
          .describe("Name of the @webframp/aws/inventory model instance"),
        terraformModelName: z.string().optional().default("terraform").describe(
          "Name of the @webframp/terraform model instance",
        ),
        configModelName: z.string().optional().default(
          "aws-config-compliance",
        ).describe(
          "Name of the @webframp/aws/config-compliance model instance",
        ),
        dnsModelName: z.string().optional().default(
          "aws-dns-observation",
        ).describe(
          "Name of the @webframp/aws/dns-observation model instance",
        ),
        topologyModelName: z.string().optional().default(
          "aws-event-topology",
        ).describe(
          "Name of the @webframp/aws/event-topology model instance",
        ),
      }),
      execute: async (
        args: {
          source: string;
          adoptModelName: string;
          inventoryModelName: string;
          terraformModelName: string;
          configModelName: string;
          dnsModelName: string;
          topologyModelName: string;
        },
        context: ModelContext,
      ) => {
        const now = new Date();
        const sourcesToBaseline: SourceName[] = args.source === "all"
          ? [
            "adopt",
            "inventory",
            "terraform",
            "config",
            "dns",
            "event_topology",
          ]
          : [args.source as SourceName];

        const modelNames: Record<SourceName, string> = {
          adopt: args.adoptModelName,
          inventory: args.inventoryModelName,
          terraform: args.terraformModelName,
          config: args.configModelName,
          dns: args.dnsModelName,
          event_topology: args.topologyModelName,
        };

        const handles: Array<{ name: string }> = [];

        for (const source of sourcesToBaseline) {
          const config = SOURCES[source];
          const modelName = modelNames[source];

          try {
            const data = await context.dataRepository.findBySpec(
              modelName,
              config.specName,
            );

            if (data.length === 0) {
              context.logger.warn("No upstream data to baseline", {
                source,
                modelName,
              });
              continue;
            }

            const sorted = data.filter((d) => d.updatedAt).sort((a, b) =>
              new Date(b.updatedAt!).getTime() -
              new Date(a.updatedAt!).getTime()
            );
            const latest = sorted[0] ?? data[0];

            const normalized = NORMALIZERS[source](latest.attributes);

            const entries: z.infer<typeof BaselineEntrySchema>[] = normalized
              .map((r) => ({
                canonicalId: r.canonicalId,
                resourceType: r.resourceType,
                snapshot: JSON.parse(canonicalJson(r.snapshot)),
              }));

            const baseline: z.infer<typeof BaselineSchema> = {
              setAt: now.toISOString(),
              source,
              entries,
            };

            const handle = await context.writeResource(
              "baseline",
              source,
              baseline,
            );
            handles.push(handle);

            context.logger.info("Baseline set", {
              source,
              resourceCount: entries.length,
            });
          } catch (err) {
            context.logger.error("Failed to set baseline", {
              source,
              modelName,
              error: String(err),
            });
          }
        }

        return { dataHandles: handles };
      },
    },

    get_drifted: {
      description:
        "Query resources currently in drifted state from the latest drift computation.",
      arguments: z.object({
        resourceType: z.string().optional().describe(
          "Filter by AWS resource type (e.g., AWS::EC2::VPC)",
        ),
        source: z.string().optional().describe(
          "Filter by detection source (adopt, inventory, terraform)",
        ),
      }),
      execute: async (
        args: { resourceType?: string; source?: string },
        context: ModelContext,
      ) => {
        let driftResult: z.infer<typeof DriftResultSchema> | null = null;

        try {
          const stored = await context.readResource("latest");
          if (stored) {
            driftResult = stored.attributes as unknown as z.infer<
              typeof DriftResultSchema
            >;
          }
        } catch {
          // No drift result yet
        }

        if (!driftResult) {
          context.logger.warn("No drift result available", {
            hint: "Run compute_drift first",
          });
          const handle = await context.writeResource("drifted", "query", {
            resources: [],
          });
          return { dataHandles: [handle] };
        }

        let drifted = driftResult.resources.filter((r) =>
          r.driftStatus === "drifted"
        );

        if (args.resourceType) {
          drifted = drifted.filter((r) => r.resourceType === args.resourceType);
        }
        if (args.source) {
          drifted = drifted.filter((r) => r.detectionSource === args.source);
        }

        const handle = await context.writeResource("drifted", "query", {
          resources: drifted,
        });

        context.logger.info("Drifted resources queried", {
          count: drifted.length,
          filters: { resourceType: args.resourceType, source: args.source },
        });

        return { dataHandles: [handle] };
      },
    },

    get_drift_timeline: {
      description: "View the drift status change history for a resource.",
      arguments: z.object({
        canonicalId: z.string().describe(
          "Canonical resource ID (ARN or composite key)",
        ),
        limit: z.number().min(1).optional().default(50).describe(
          "Maximum events to return",
        ),
      }),
      execute: async (
        args: { canonicalId: string; limit: number },
        context: ModelContext,
      ) => {
        const instanceName = `timeline-${hashId(args.canonicalId)}`;
        let events: z.infer<typeof TimelineEventSchema>[] = [];

        try {
          const stored = await context.readResource(instanceName);
          if (stored) {
            events = (stored.attributes.events as z.infer<
              typeof TimelineEventSchema
            >[]) ?? [];
          }
        } catch {
          // No timeline for this resource
        }

        // Most recent first, capped at limit
        const limited = events.slice(-args.limit).reverse();

        const result = {
          canonicalId: args.canonicalId,
          events: limited,
        };

        const handle = await context.writeResource(
          "timeline",
          `query-${hashId(args.canonicalId)}`,
          result,
        );

        return { dataHandles: [handle] };
      },
    },

    get_drift_velocity: {
      description:
        "Compute aggregate drift rate metrics by resource type and time window.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ) => {
        const now = new Date();

        // Read latest drift result for current state
        let driftResult: z.infer<typeof DriftResultSchema> | null = null;
        try {
          const stored = await context.readResource("latest");
          if (stored) {
            driftResult = stored.attributes as unknown as z.infer<
              typeof DriftResultSchema
            >;
          }
        } catch {
          // No drift result
        }

        if (!driftResult) {
          context.logger.warn("No drift result available for velocity", {});
          const handle = await context.writeResource("velocity", "latest", {
            computedAt: now.toISOString(),
            byResourceType: {},
            byTimeWindow: { last24h: 0, last7d: 0, last30d: 0 },
          });
          return { dataHandles: [handle] };
        }

        // Compute by resource type
        const byType: Record<
          string,
          { driftedCount: number; totalCount: number }
        > = {};
        for (const r of driftResult.resources) {
          if (r.driftStatus === "unknown") continue;
          if (!byType[r.resourceType]) {
            byType[r.resourceType] = { driftedCount: 0, totalCount: 0 };
          }
          byType[r.resourceType].totalCount++;
          if (r.driftStatus === "drifted") {
            byType[r.resourceType].driftedCount++;
          }
        }

        const byResourceType: z.infer<typeof VelocitySchema>["byResourceType"] =
          {};
        for (const [type, counts] of Object.entries(byType)) {
          byResourceType[type] = {
            ...counts,
            driftRate: counts.totalCount > 0
              ? counts.driftedCount / counts.totalCount
              : 0,
          };
        }

        // Compute time windows from drift detection dates
        const thresholds = {
          last24h: now.getTime() - 24 * 60 * 60 * 1000,
          last7d: now.getTime() - 7 * 24 * 60 * 60 * 1000,
          last30d: now.getTime() - 30 * 24 * 60 * 60 * 1000,
        };

        const byTimeWindow = {
          last24h: driftResult.resources.filter((r) =>
            r.firstDriftDetected &&
            new Date(r.firstDriftDetected).getTime() > thresholds.last24h
          ).length,
          last7d: driftResult.resources.filter((r) =>
            r.firstDriftDetected &&
            new Date(r.firstDriftDetected).getTime() > thresholds.last7d
          ).length,
          last30d: driftResult.resources.filter((r) =>
            r.firstDriftDetected &&
            new Date(r.firstDriftDetected).getTime() > thresholds.last30d
          ).length,
        };

        const velocity: z.infer<typeof VelocitySchema> = {
          computedAt: now.toISOString(),
          byResourceType,
          byTimeWindow,
        };

        const handle = await context.writeResource(
          "velocity",
          "latest",
          velocity,
        );

        context.logger.info("Velocity computed", {
          types: Object.keys(byResourceType).length,
          last24h: byTimeWindow.last24h,
          last7d: byTimeWindow.last7d,
        });

        return { dataHandles: [handle] };
      },
    },

    refresh: {
      description:
        "Recompute drift from current upstream data. For full upstream refresh (re-run discover/scan), use the drift-state-refresh workflow.",
      arguments: z.object({
        adoptModelName: z.string().optional().default("aws-adopt").describe(
          "Name of the @webframp/aws/adopt model instance",
        ),
        inventoryModelName: z.string().optional().default("aws-inventory")
          .describe("Name of the @webframp/aws/inventory model instance"),
        terraformModelName: z.string().optional().default("terraform").describe(
          "Name of the @webframp/terraform model instance",
        ),
        configModelName: z.string().optional().default(
          "aws-config-compliance",
        ).describe(
          "Name of the @webframp/aws/config-compliance model instance",
        ),
        dnsModelName: z.string().optional().default(
          "aws-dns-observation",
        ).describe(
          "Name of the @webframp/aws/dns-observation model instance",
        ),
        topologyModelName: z.string().optional().default(
          "aws-event-topology",
        ).describe(
          "Name of the @webframp/aws/event-topology model instance",
        ),
      }),
      execute: async (
        args: {
          adoptModelName: string;
          inventoryModelName: string;
          terraformModelName: string;
          configModelName: string;
          dnsModelName: string;
          topologyModelName: string;
        },
        context: ModelContext,
      ) => {
        context.logger.info("Refreshing drift state from current data", {
          hint:
            "For full upstream refresh, run: swamp workflow run @webframp/drift-state-refresh",
        });

        // Delegate to compute_drift with all sources
        return await model.methods.compute_drift.execute(
          {
            adoptModelName: args.adoptModelName,
            inventoryModelName: args.inventoryModelName,
            terraformModelName: args.terraformModelName,
            configModelName: args.configModelName,
            dnsModelName: args.dnsModelName,
            topologyModelName: args.topologyModelName,
            staleThresholdMinutes: 1440,
          },
          context,
        );
      },
    },
  },
};
