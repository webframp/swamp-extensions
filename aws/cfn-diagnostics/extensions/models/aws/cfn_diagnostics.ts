/**
 * AWS CloudFormation failure diagnostics model for swamp.
 *
 * Read-only methods for investigating failed or rolled-back stack operations:
 * stack discovery, stack-event history (with failed events and root-cause
 * candidates pulled out), and CloudTrail LookupEvents for the API calls behind
 * those failures (AccessDenied, ExpiredToken, and so on).
 *
 * Only Describe*, List* and LookupEvents calls are made, so a ReadOnlyPlus
 * profile is sufficient.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import {
  CloudFormationClient,
  type CloudFormationClientConfig,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  type StackEvent,
  StackStatus,
} from "npm:@aws-sdk/client-cloudformation@3.1139.0";
import {
  CloudTrailClient,
  type CloudTrailClientConfig,
  type LookupAttributeKey,
  LookupEventsCommand,
} from "npm:@aws-sdk/client-cloudtrail@3.1139.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1139.0";

const EXTENSION_NAME = "@webframp/aws/cfn-diagnostics";

/** Safety bound on paginated calls so a runaway stack history cannot loop. */
const MAX_PAGES = 50;

/** LookupEvents is throttled at 2 requests/second per account per region. */
const LOOKUP_EVENTS_MAX_PAGES = 20;

/** Nested stacks followed per call across ALL levels; bounds fan-out. */
const MAX_NESTED_STACKS = 25;

/** Per-request deadline; the SDK default has none. */
const REQUEST_TIMEOUT_MS = 30_000;

const STACK_TYPE = "AWS::CloudFormation::Stack";

/** Every StackStatus except DELETE_COMPLETE, the default for list_stacks. */
const NON_DELETED_STATUSES = Object.values(StackStatus).filter((s) =>
  s !== "DELETE_COMPLETE"
);

/**
 * User-chosen data names. Data names are per model, so these share a namespace
 * with every resource this model writes: reject the swamp-reserved `latest`,
 * path-unsafe characters, and the `events-` / `detail-` prefixes used for
 * generated names.
 */
const UserNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' and '-' only")
  .refine((n) => n !== "latest" && n !== "." && n !== "..", {
    message: "'latest', '.' and '..' are reserved",
  })
  .refine((n) => !n.startsWith("events-") && !n.startsWith("detail-"), {
    message: "the 'events-' and 'detail-' prefixes are reserved",
  });

/**
 * Accepted time forms: relative (30m, 6h, 2d) or an ISO 8601 date/time. Stricter
 * than `new Date()`, which parses things like "10" as a valid date.
 */
const ISO_TIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region of the stack (and of CloudTrail for lookup_events)"),
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

const StackSummarySchema = z.object({
  stackName: z.string(),
  stackId: z.string().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  creationTime: z.string().nullable(),
  lastUpdatedTime: z.string().nullable(),
  deletionTime: z.string().nullable(),
  driftStatus: z.string().nullable(),
  parentId: z.string().nullable(),
  rootId: z.string().nullable(),
});

const StackListSchema = z.object({
  stacks: z.array(StackSummarySchema),
  count: z.number(),
  truncated: z.boolean().describe(
    "True when pagination hit the page cap, so more stacks may exist",
  ),
  ...Meta,
});

const StackDetailSchema = z.object({
  stack: StackSummarySchema.extend({
    roleArn: z.string().nullable(),
    disableRollback: z.boolean().nullable(),
    rollbackConfiguration: z.unknown().nullable(),
    capabilities: z.array(z.string()),
    parameters: z.array(z.object({
      key: z.string(),
      value: z.string().nullable(),
    })),
    tags: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  resources: z.array(z.object({
    logicalId: z.string(),
    physicalId: z.string().nullable(),
    type: z.string(),
    status: z.string(),
    statusReason: z.string().nullable(),
    lastUpdated: z.string().nullable(),
  })),
  resourcesTruncated: z.boolean().describe(
    "True when pagination hit the page cap, so more resources may exist",
  ),
  ...Meta,
});

const EventSchema = z.object({
  eventId: z.string(),
  timestamp: z.string(),
  stackName: z.string(),
  logicalId: z.string().nullable(),
  physicalId: z.string().nullable(),
  resourceType: z.string().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  operationId: z.string().nullable().describe(
    "CloudFormation ClientRequestToken: groups events from one stack operation",
  ),
});

type Event = z.infer<typeof EventSchema>;

const StackEventsSchema = z.object({
  stackName: z.string(),
  stackStatus: z.string().nullable(),
  window: z.object({ since: z.string().nullable(), until: z.string() }),
  eventCount: z.number(),
  stackStatusError: z.string().nullable().describe(
    "Set when DescribeStacks failed for a reason other than the stack not existing",
  ),
  failedEvents: z.array(EventSchema).describe(
    "Events whose status ends in _FAILED, oldest first",
  ),
  rootCauseCandidates: z.array(EventSchema).describe(
    "Failed events that are neither a cascade (cancellations, a stack's own " +
      "status row, 'following resource(s) failed' wrappers) nor part of the " +
      "rollback phase. Includes DELETE_FAILED on a plain stack delete. Group " +
      "by operationId: the earliest per operation is the usual root cause",
  ),
  rollbackFailedEvents: z.array(EventSchema).describe(
    "Failed events that occurred after the stack began rolling back within " +
      "the same operation, or inside a nested stack during its parent's " +
      "rollback, i.e. what blocked cleanup",
  ),
  operations: z.array(z.object({
    stackName: z.string(),
    operationId: z.string().nullable(),
    start: z.string(),
    end: z.string(),
    rolledBack: z.boolean().describe(
      "True when the stack entered a rollback status in this operation",
    ),
    failedCount: z.number(),
    rootCauseEventIds: z.array(z.string()),
  })).describe(
    "Events grouped by (stack, operation), oldest first, so a retry's " +
      "failures are not mixed with an earlier attempt's",
  ),
  nestedStacksFollowed: z.array(z.string()),
  nestedErrors: z.array(z.object({
    stackId: z.string(),
    error: z.string(),
  })).describe("Nested stacks whose events could not be fetched"),
  events: z.array(EventSchema).describe("All events in window, oldest first"),
  truncated: z.boolean(),
  ...Meta,
});

const TrailEventSchema = z.object({
  eventId: z.string().nullable(),
  eventTime: z.string().nullable(),
  eventName: z.string().nullable(),
  eventSource: z.string().nullable(),
  username: z.string().nullable(),
  readOnly: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  principalArn: z.string().nullable(),
  principalType: z.string().nullable(),
  sessionIssuerArn: z.string().nullable(),
  invokedBy: z.string().nullable(),
  sourceIpAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  resources: z.array(z.object({
    type: z.string().nullable(),
    name: z.string().nullable(),
  })),
});

const TrailEventsSchema = z.object({
  window: z.object({ start: z.string(), end: z.string() }),
  filter: z.object({
    attribute: z.string().nullable(),
    value: z.string().nullable(),
    errorsOnly: z.boolean(),
    eventSource: z.string().nullable(),
  }),
  scanned: z.number(),
  count: z.number(),
  events: z.array(TrailEventSchema),
  errorSummary: z.array(z.object({
    errorCode: z.string(),
    eventName: z.string().nullable(),
    count: z.number(),
  })),
  truncated: z.boolean(),
  partialError: z.string().nullable().describe(
    "Set when a later page failed; earlier pages are kept and truncated is true",
  ),
  ...Meta,
});

// =============================================================================
// Helpers
// =============================================================================

function parseTime(timeStr: string): Date {
  const match = timeStr.match(/^(\d+)([mhd])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2] as "m" | "h" | "d"
    ];
    return new Date(Date.now() - value * ms);
  }
  const parsed = ISO_TIME_RE.test(timeStr) ? new Date(timeStr) : null;
  if (!parsed || isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid time "${timeStr}": use ISO 8601 (2026-10-13T12:00:00Z) or relative (30m, 2h, 3d)`,
    );
  }
  return parsed;
}

/** The stack name from a name or a full stack ARN. */
function stackNameOf(idOrName: string): string {
  const m = idOrName.match(
    /^arn:[^:]*:cloudformation:[^:]*:\d{12}:stack\/([^/]+)(?:\/.+)?$/,
  );
  return m ? m[1] : idOrName;
}

/**
 * Deterministic short hash (SHA-1, first 16 hex chars) for names that would
 * otherwise be truncated or empty.
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

/**
 * Data name for a stack: `<prefix>-<stack name>`. A name and the ARN of the same
 * stack map to the same data name. Over-long or unusable names get a hash
 * suffix instead of colliding after truncation.
 */
async function stackDataName(
  prefix: string,
  idOrName: string,
): Promise<string> {
  const base = stackNameOf(idOrName).replace(/[^A-Za-z0-9._-]/g, "-");
  const max = 100 - prefix.length - 1;
  if (base.length > 0 && base.length <= max) return `${prefix}-${base}`;
  const hash = await shortHash(stackNameOf(idOrName));
  return `${prefix}-${base.slice(0, Math.max(0, max - 17))}-${hash}`;
}

/** SDK timestamps may be Date or string depending on version. */
function iso(value: Date | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Options for every SDK call: a hard per-request deadline. */
function reqOpts() {
  return { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function credentials(globalArgs: GlobalArgs) {
  return globalArgs.profile
    ? { credentials: fromIni({ profile: globalArgs.profile }) }
    : {};
}

function makeCfnClient(g: GlobalArgs): CloudFormationClient {
  const config: CloudFormationClientConfig = {
    region: g.region,
    ...credentials(g),
  };
  return new CloudFormationClient(config);
}

function makeTrailClient(g: GlobalArgs): CloudTrailClient {
  const config: CloudTrailClientConfig = {
    region: g.region,
    ...credentials(g),
  };
  return new CloudTrailClient(config);
}

function toEvent(e: StackEvent): Event {
  return {
    eventId: e.EventId ?? "",
    timestamp: iso(e.Timestamp) ?? "",
    stackName: e.StackName ?? "",
    logicalId: e.LogicalResourceId ?? null,
    physicalId: e.PhysicalResourceId ?? null,
    resourceType: e.ResourceType ?? null,
    status: e.ResourceStatus ?? "UNKNOWN",
    statusReason: e.ResourceStatusReason ?? null,
    operationId: e.ClientRequestToken ?? null,
  };
}

/** The subset of the CloudTrailEvent JSON payload this model reads. */
type CloudTrailDetail = {
  errorCode?: string;
  errorMessage?: string;
  sourceIPAddress?: string;
  userAgent?: string;
  userIdentity?: {
    arn?: string;
    type?: string;
    invokedBy?: string;
    sessionContext?: { sessionIssuer?: { arn?: string } };
  };
};

/**
 * Reasons CloudFormation writes when a failure is a consequence of another one.
 * Anchored: a custom resource whose message merely contains these words is not
 * a cascade.
 */
const CASCADE_REASONS = [
  /^resource (creation|update|deletion) cancelled/i,
  /^the following resource\(s\) failed to (create|update|delete)/i,
  /^embedded stack .* was not successfully (created|updated|deleted)/i,
];

/**
 * A failure that restates another one: a cancellation, a wrapper row, or the
 * stack's own status row (its logical id is its own name). A nested stack that
 * fails for its OWN reason (bad TemplateURL, validation error) is not a cascade.
 */
function isCascade(e: Event): boolean {
  if (e.resourceType === STACK_TYPE && e.logicalId === e.stackName) return true;
  return CASCADE_REASONS.some((p) => p.test(e.statusReason ?? ""));
}

function isFailed(e: Event): boolean {
  return e.status.endsWith("_FAILED");
}

/** A stack's own status row (its logical id is its own name). */
function isOwnRow(e: Event): boolean {
  // A nested-stack resource that merely shares the parent's name carries the
  // NESTED stack's ARN as its physical id, so it is not the parent's own row.
  return e.resourceType === STACK_TYPE && e.logicalId === e.stackName &&
    (!e.physicalId || stackNameOf(e.physicalId) === e.stackName);
}

/**
 * A row that begins a new top-level operation on a stack. Rollback and cleanup
 * statuses continue the operation that failed, so they do not start one.
 */
function startsOperation(e: Event): boolean {
  return isOwnRow(e) && e.status.endsWith("_IN_PROGRESS") &&
    !e.status.includes("ROLLBACK") && !e.status.includes("CLEANUP");
}

type Operations = {
  /** eventId -> operation key (`<stack>|<token>` or a synthetic `<stack>|#n`) */
  keyOf: Map<string, string>;
  /** operation key -> events, oldest first */
  groups: Map<string, Event[]>;
  /** operation key -> the instant its stack first entered a rollback status */
  rollbackStart: Map<string, number>;
  /** true when the event is a cleanup blocker rather than a root cause */
  inRollbackPhase: (e: Event) => boolean;
};

/**
 * Group events (oldest first) into per-stack operations and find the rollback
 * phase of each.
 *
 * An operation is the CloudFormation ClientRequestToken. When an event has no
 * token, a new operation starts at each stack row that begins one, so a retry
 * is not merged with the attempt before it.
 *
 * An event is in the rollback phase when it falls strictly after its own
 * stack's rollback began in the same operation, OR within the rollback window
 * of any ancestor stack: a parent that rolls back deletes the nested stacks it
 * created, and a resource that fails to delete there is a cleanup blocker even
 * though the nested stack's own operation is a plain DELETE. A DELETE_FAILED
 * with no rollback anywhere above it is an ordinary delete failure.
 */
function analyzeOperations(events: Event[]): Operations {
  const keyOf = new Map<string, string>();
  const groups = new Map<string, Event[]>();
  const counter = new Map<string, number>();
  for (const e of events) {
    if (startsOperation(e)) {
      counter.set(e.stackName, (counter.get(e.stackName) ?? 0) + 1);
    }
    const key = e.operationId
      ? `${e.stackName}|${e.operationId}`
      : `${e.stackName}|#${counter.get(e.stackName) ?? 0}`;
    keyOf.set(e.eventId, key);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const rollbackStart = new Map<string, number>();
  const windows = new Map<string, { start: number; end: number }[]>();
  for (const [key, list] of groups) {
    let start: number | undefined;
    for (const e of list) {
      if (isOwnRow(e) && e.status.includes("ROLLBACK")) {
        const t = Date.parse(e.timestamp);
        if (!isNaN(t) && (start === undefined || t < start)) start = t;
      }
    }
    if (start === undefined) continue;
    rollbackStart.set(key, start);
    const end = Date.parse(list[list.length - 1].timestamp);
    const stack = list[0].stackName;
    // A rollback still running has no end yet: nested cleanup events can be
    // stamped after the last parent row we fetched.
    const lastOwn = [...list].reverse().find(isOwnRow);
    const live = lastOwn !== undefined &&
      lastOwn.status.includes("ROLLBACK") &&
      lastOwn.status.endsWith("_IN_PROGRESS");
    const w = windows.get(stack) ?? [];
    w.push({
      start,
      end: live ? Infinity : isNaN(end) ? start : end,
    });
    windows.set(stack, w);
  }

  // nested stack name -> the stack whose rows reference it
  const parentOf = new Map<string, string>();
  for (const e of events) {
    if (
      e.resourceType === STACK_TYPE && e.physicalId?.startsWith("arn:") &&
      stackNameOf(e.physicalId) !== e.stackName
    ) {
      parentOf.set(stackNameOf(e.physicalId), e.stackName);
    }
  }

  const inRollbackPhase = (e: Event): boolean => {
    const t = Date.parse(e.timestamp);
    if (isNaN(t)) return false;
    const own = rollbackStart.get(keyOf.get(e.eventId) ?? "");
    if (own !== undefined && t > own) return true;
    const seen = new Set<string>([e.stackName]);
    let ancestor = parentOf.get(e.stackName);
    while (ancestor !== undefined && !seen.has(ancestor)) {
      seen.add(ancestor);
      for (const w of windows.get(ancestor) ?? []) {
        if (t > w.start && t <= w.end) return true;
      }
      ancestor = parentOf.get(ancestor);
    }
    return false;
  };

  return { keyOf, groups, rollbackStart, inRollbackPhase };
}

/** Stack name when the id is an ARN, else the id; used to avoid self-follow. */
function nestedIdsFrom(events: Event[], rootName: string): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (
      e.resourceType === STACK_TYPE && e.physicalId?.startsWith("arn:") &&
      stackNameOf(e.physicalId) !== rootName
    ) {
      ids.add(e.physicalId);
    }
  }
  return [...ids];
}

async function fetchStackEvents(
  client: CloudFormationClient,
  stackName: string,
  since: Date | null,
  region: string,
): Promise<{ events: Event[]; truncated: boolean }> {
  const events: Event[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  let reachedWindowStart = false;
  do {
    let res;
    try {
      res = await client.send(
        new DescribeStackEventsCommand({
          StackName: stackName,
          NextToken: nextToken,
        }),
        reqOpts(),
      );
    } catch (err) {
      throw new Error(
        `Failed to describe events for stack "${stackName}" (region=${region}): ${
          errMsg(err)
        }`,
        { cause: err },
      );
    }
    for (const raw of res.StackEvents ?? []) {
      const ev = toEvent(raw);
      // API returns newest first; stop once we pass the window start.
      if (since && new Date(ev.timestamp) < since) {
        reachedWindowStart = true;
        break;
      }
      events.push(ev);
    }
    nextToken = res.NextToken;
    pages++;
  } while (nextToken && !reachedWindowStart && pages < MAX_PAGES);

  return {
    events: events.reverse(),
    truncated: Boolean(nextToken) && !reachedWindowStart,
  };
}

function summarizeStack(
  s: {
    StackName?: string;
    StackId?: string;
    StackStatus?: string;
    StackStatusReason?: string;
    CreationTime?: Date;
    LastUpdatedTime?: Date;
    DeletionTime?: Date;
    DriftInformation?: { StackDriftStatus?: string };
    ParentId?: string;
    RootId?: string;
  },
): z.infer<typeof StackSummarySchema> {
  return {
    stackName: s.StackName ?? "",
    stackId: s.StackId ?? null,
    status: s.StackStatus ?? "UNKNOWN",
    statusReason: s.StackStatusReason ?? null,
    creationTime: iso(s.CreationTime),
    lastUpdatedTime: iso(s.LastUpdatedTime),
    deletionTime: iso(s.DeletionTime),
    driftStatus: s.DriftInformation?.StackDriftStatus ?? null,
    parentId: s.ParentId ?? null,
    rootId: s.RootId ?? null,
  };
}

// =============================================================================
// Model
// =============================================================================

type Context = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
};

/**
 * Read-only CloudFormation failure diagnostics. Methods: `list_stacks`,
 * `describe_stack`, `list_stack_events` (failed events, root-cause candidates
 * and rollback blockers, following nested stacks) and `lookup_events`
 * (CloudTrail LookupEvents with an error roll-up).
 */
export const model = {
  type: "@webframp/aws/cfn-diagnostics",
  version: "2026.10.13.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],

  resources: {
    stack_list: {
      description: "CloudFormation stacks matching a name filter",
      schema: StackListSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
    stack_detail: {
      description: "One stack's status, parameters, tags and resource states",
      schema: StackDetailSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
    stack_events: {
      description:
        "Stack event history for a time window, with failures and root-cause candidates extracted",
      schema: StackEventsSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    trail_events: {
      description: "CloudTrail LookupEvents results with error roll-up",
      schema: TrailEventsSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    list_stacks: {
      description:
        "List stacks whose name contains a substring. Excludes DELETE_COMPLETE stacks unless includeDeleted or statuses says otherwise. The name filter is client-side, so `truncated` can hide matches on a large account.",
      arguments: z.object({
        nameContains: z.string().optional().describe(
          "Case-insensitive substring of the stack name",
        ),
        statuses: z
          .array(z.enum(
            Object.values(StackStatus) as [StackStatus, ...StackStatus[]],
          ))
          .min(1, "omit statuses to use the default")
          .optional()
          .describe(
            'StackStatus filter, e.g. ["UPDATE_ROLLBACK_FAILED"]. Omit for every ' +
              "status except DELETE_COMPLETE (see includeDeleted).",
          ),
        includeDeleted: z.boolean().default(false).describe(
          "Include DELETE_COMPLETE stacks (kept by CloudFormation for 90 days). " +
            "Ignored when statuses is given. Deleted stacks can crowd out live " +
            "ones under the page cap, so leave this off unless you need them.",
        ),
        instanceName: UserNameSchema.default("stack-list").describe(
          "Name for the stored stack_list resource",
        ),
      }),
      execute: async (
        args: {
          nameContains?: string;
          statuses?: StackStatus[];
          includeDeleted: boolean;
          instanceName: string;
        },
        context: Context,
      ) => {
        const startMs = Date.now();
        const client = makeCfnClient(context.globalArgs);
        try {
          const stacks: z.infer<typeof StackSummarySchema>[] = [];
          let nextToken: string | undefined;
          let pages = 0;
          const needle = args.nameContains?.toLowerCase();
          do {
            let res;
            try {
              res = await client.send(
                new ListStacksCommand({
                  NextToken: nextToken,
                  StackStatusFilter: args.statuses ??
                    (args.includeDeleted
                      ? undefined
                      : (NON_DELETED_STATUSES as StackStatus[])),
                }),
                reqOpts(),
              );
            } catch (err) {
              throw new Error(
                `Failed to list stacks (region=${context.globalArgs.region}): ${
                  errMsg(err)
                }`,
                { cause: err },
              );
            }
            for (const s of res.StackSummaries ?? []) {
              if (
                needle && !(s.StackName ?? "").toLowerCase().includes(needle)
              ) {
                continue;
              }
              stacks.push(summarizeStack({
                StackName: s.StackName,
                StackId: s.StackId,
                StackStatus: s.StackStatus,
                StackStatusReason: s.StackStatusReason,
                CreationTime: s.CreationTime,
                LastUpdatedTime: s.LastUpdatedTime,
                DeletionTime: s.DeletionTime,
                DriftInformation: s.DriftInformation
                  ? { StackDriftStatus: s.DriftInformation.StackDriftStatus }
                  : undefined,
                ParentId: s.ParentId,
                RootId: s.RootId,
              }));
            }
            nextToken = res.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "stack_list",
            args.instanceName,
            {
              stacks,
              count: stacks.length,
              truncated: Boolean(nextToken),
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info("Found {count} stacks", { count: stacks.length });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    describe_stack: {
      description:
        "Describe one stack: status, reason, parameters, tags, and every resource's current state",
      arguments: z.object({
        stackName: z.string().min(1).describe(
          "Stack name or full stack ARN (required for deleted stacks)",
        ),
      }),
      execute: async (args: { stackName: string }, context: Context) => {
        const startMs = Date.now();
        const client = makeCfnClient(context.globalArgs);
        try {
          let described;
          try {
            described = await client.send(
              new DescribeStacksCommand({ StackName: args.stackName }),
              reqOpts(),
            );
          } catch (err) {
            throw new Error(
              `Failed to describe stack "${args.stackName}" (region=${context.globalArgs.region}): ${
                errMsg(err)
              }`,
              { cause: err },
            );
          }
          const s = described.Stacks?.[0];
          if (!s) throw new Error(`Stack "${args.stackName}" not found`);

          const resources: z.infer<typeof StackDetailSchema>["resources"] = [];
          let nextToken: string | undefined;
          let pages = 0;
          do {
            let res;
            try {
              res = await client.send(
                new ListStackResourcesCommand({
                  StackName: args.stackName,
                  NextToken: nextToken,
                }),
                reqOpts(),
              );
            } catch (err) {
              throw new Error(
                `Failed to list resources for stack "${args.stackName}" (region=${context.globalArgs.region}): ${
                  errMsg(err)
                }`,
                { cause: err },
              );
            }
            for (const r of res.StackResourceSummaries ?? []) {
              resources.push({
                logicalId: r.LogicalResourceId ?? "",
                physicalId: r.PhysicalResourceId ?? null,
                type: r.ResourceType ?? "",
                status: r.ResourceStatus ?? "UNKNOWN",
                statusReason: r.ResourceStatusReason ?? null,
                lastUpdated: iso(r.LastUpdatedTimestamp),
              });
            }
            nextToken = res.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          const handle = await context.writeResource(
            "stack_detail",
            await stackDataName("detail", s.StackName ?? args.stackName),
            {
              stack: {
                ...summarizeStack(s),
                roleArn: s.RoleARN ?? null,
                disableRollback: s.DisableRollback ?? null,
                rollbackConfiguration: s.RollbackConfiguration ?? null,
                capabilities: s.Capabilities ?? [],
                parameters: (s.Parameters ?? []).map((p) => ({
                  key: p.ParameterKey ?? "",
                  // NoEcho parameters come back masked as ****; pass through.
                  value: p.ParameterValue ?? null,
                })),
                tags: (s.Tags ?? []).map((t) => ({
                  key: t.Key ?? "",
                  value: t.Value ?? "",
                })),
              },
              resources,
              resourcesTruncated: Boolean(nextToken),
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info("Stack {name} is {status}", {
            name: s.StackName,
            status: s.StackStatus,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    list_stack_events: {
      description:
        "Fetch stack events in a time window and extract failed events, root-cause candidates and rollback blockers. Optionally follows nested stacks.",
      arguments: z.object({
        stackName: z.string().min(1).describe(
          "Stack name or full stack ARN (ARN required for deleted stacks)",
        ),
        since: z.string().default("24h").describe(
          "Window start (ISO date or relative: 30m, 6h, 2d)",
        ),
        followNested: z.boolean().default(true).describe(
          "Also fetch events for nested AWS::CloudFormation::Stack resources",
        ),
      }),
      execute: async (
        args: { stackName: string; since: string; followNested: boolean },
        context: Context,
      ) => {
        const startMs = Date.now();
        const since = parseTime(args.since);
        const client = makeCfnClient(context.globalArgs);
        try {
          const rootName = stackNameOf(args.stackName);
          const region = context.globalArgs.region;

          // Resolved once: the status goes in the output. A stack that does not
          // exist (deleted, or addressed by name after deletion) is expected;
          // any other failure is recorded instead of silently becoming null.
          let self: { StackId?: string; StackStatus?: string } | null = null;
          let stackStatusError: string | null = null;
          try {
            const d = await client.send(
              new DescribeStacksCommand({ StackName: args.stackName }),
              reqOpts(),
            );
            self = d.Stacks?.[0] ?? null;
          } catch (err) {
            if (!(err instanceof Error && err.name === "ValidationError")) {
              stackStatusError = errMsg(err);
            }
          }

          const root = await fetchStackEvents(
            client,
            args.stackName,
            since,
            region,
          );
          let events = root.events;
          let truncated = root.truncated;
          const followed: string[] = [];
          const nestedErrors: { stackId: string; error: string }[] = [];

          if (args.followNested) {
            // Breadth-first over every level, with a visited set and one cap
            // shared across levels, so a grandchild's failure is not missed.
            const visited = new Set<string>();
            if (self?.StackId) visited.add(self.StackId);
            let queue = nestedIdsFrom(events, rootName);
            while (queue.length > 0) {
              const next: string[] = [];
              for (const id of queue) {
                if (visited.has(id)) continue;
                if (
                  followed.length + nestedErrors.length >= MAX_NESTED_STACKS
                ) {
                  truncated = true;
                  continue;
                }
                visited.add(id);
                try {
                  const nested = await fetchStackEvents(
                    client,
                    id,
                    since,
                    region,
                  );
                  events = events.concat(nested.events);
                  truncated = truncated || nested.truncated;
                  followed.push(id);
                  next.push(...nestedIdsFrom(nested.events, rootName));
                } catch (err) {
                  // One unreadable nested stack (cross-account, deleted,
                  // throttled) must not discard everything already fetched.
                  nestedErrors.push({ stackId: id, error: errMsg(err) });
                  truncated = true;
                }
              }
              queue = next;
            }
          }

          const seen = new Set<string>();
          events = events.filter((e) =>
            seen.has(e.eventId) ? false : (seen.add(e.eventId), true)
          );
          events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

          const ops = analyzeOperations(events);
          const failed = events.filter(isFailed);
          const rollbackFailed = failed.filter((e) => ops.inRollbackPhase(e));
          const rootCauses = failed.filter((e) =>
            !isCascade(e) && !ops.inRollbackPhase(e)
          );

          const rootIds = new Set(rootCauses.map((e) => e.eventId));
          const operations = [...ops.groups.entries()].map(([key, list]) => ({
            stackName: list[0].stackName,
            operationId: list[0].operationId,
            start: list[0].timestamp,
            end: list[list.length - 1].timestamp,
            rolledBack: ops.rollbackStart.has(key),
            failedCount: list.filter(isFailed).length,
            rootCauseEventIds: list.filter((e) => rootIds.has(e.eventId)).map(
              (e) => e.eventId,
            ),
          })).sort((a, b) => a.start.localeCompare(b.start));

          const stackStatus = self?.StackStatus ?? null;

          const handle = await context.writeResource(
            "stack_events",
            await stackDataName("events", args.stackName),
            {
              stackName: args.stackName,
              stackStatus,
              stackStatusError,
              window: {
                since: since.toISOString(),
                until: new Date().toISOString(),
              },
              eventCount: events.length,
              failedEvents: failed,
              rootCauseCandidates: rootCauses,
              rollbackFailedEvents: rollbackFailed,
              operations,
              nestedStacksFollowed: followed,
              nestedErrors,
              events,
              truncated,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info(
            "{events} events, {failed} failed, {roots} root-cause candidates",
            {
              events: events.length,
              failed: failed.length,
              roots: rootCauses.length,
            },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    lookup_events: {
      description:
        "Query CloudTrail LookupEvents (management events, last 90 days) and roll up errors by code and API. Use to find AccessDenied / ExpiredToken calls behind a stack failure.",
      arguments: z.object({
        startTime: z.string().default("6h").describe(
          "Window start (ISO date or relative: 30m, 6h, 2d)",
        ),
        endTime: z.string().optional().describe("Window end (default now)"),
        lookupAttribute: z
          .enum([
            "EventName",
            "EventSource",
            "ResourceName",
            "ResourceType",
            "Username",
            "AccessKeyId",
            "EventId",
            "ReadOnly",
          ])
          .optional()
          .describe(
            "Server-side filter key (only one is supported by the API). " +
              "ResourceName with a stack or physical id is the most precise.",
          ),
        lookupValue: z.string().optional().describe(
          "Value for lookupAttribute",
        ),
        errorsOnly: z.boolean().default(true).describe(
          "Keep only events carrying an errorCode (client-side filter)",
        ),
        eventSource: z.string().optional().describe(
          "Client-side filter, e.g. rds.amazonaws.com (useful alongside a server-side filter)",
        ),
        maxEvents: z.number().int().min(1).max(5000).default(500).describe(
          "Maximum matching events to keep",
        ),
        instanceName: UserNameSchema.default("trail-lookup").describe(
          "Name for the stored trail_events resource",
        ),
      }),
      execute: async (
        args: {
          startTime: string;
          endTime?: string;
          lookupAttribute?: LookupAttributeKey;
          lookupValue?: string;
          errorsOnly: boolean;
          eventSource?: string;
          maxEvents: number;
          instanceName: string;
        },
        context: Context,
      ) => {
        if (Boolean(args.lookupAttribute) !== Boolean(args.lookupValue)) {
          throw new Error(
            "lookupAttribute and lookupValue must be provided together",
          );
        }
        const startMs = Date.now();
        const start = parseTime(args.startTime);
        const end = args.endTime ? parseTime(args.endTime) : new Date();
        if (end <= start) {
          throw new Error(
            `endTime (${end.toISOString()}) must be after startTime (${start.toISOString()})`,
          );
        }
        const client = makeTrailClient(context.globalArgs);
        try {
          const events: z.infer<typeof TrailEventSchema>[] = [];
          let scanned = 0;
          let nextToken: string | undefined;
          let pages = 0;
          let truncated = false;
          let partialError: string | null = null;

          do {
            let res;
            try {
              res = await client.send(
                new LookupEventsCommand({
                  StartTime: start,
                  EndTime: end,
                  NextToken: nextToken,
                  MaxResults: 50,
                  LookupAttributes: args.lookupAttribute
                    ? [{
                      AttributeKey: args.lookupAttribute,
                      AttributeValue: args.lookupValue!,
                    }]
                    : undefined,
                }),
                reqOpts(),
              );
            } catch (err) {
              const message =
                `CloudTrail LookupEvents failed (region=${context.globalArgs.region}): ${
                  errMsg(err)
                }`;
              if (pages === 0) throw new Error(message, { cause: err });
              // A later page failed (typically throttling): keep what was
              // gathered and say so, rather than discarding every earlier page.
              partialError = message;
              truncated = true;
              break;
            }

            for (const e of res.Events ?? []) {
              scanned++;
              let detail: CloudTrailDetail = {};
              try {
                detail = e.CloudTrailEvent ? JSON.parse(e.CloudTrailEvent) : {};
              } catch {
                // Leave detail empty; the summary fields below still populate.
              }
              const errorCode: string | null = detail.errorCode ?? null;
              if (args.errorsOnly && !errorCode) continue;
              if (args.eventSource && e.EventSource !== args.eventSource) {
                continue;
              }
              if (events.length >= args.maxEvents) {
                truncated = true;
                break;
              }
              const ui = detail.userIdentity ?? {};
              events.push({
                eventId: e.EventId ?? null,
                eventTime: iso(e.EventTime),
                eventName: e.EventName ?? null,
                eventSource: e.EventSource ?? null,
                username: e.Username ?? null,
                readOnly: e.ReadOnly ?? null,
                errorCode,
                errorMessage: detail.errorMessage ?? null,
                principalArn: ui.arn ?? null,
                principalType: ui.type ?? null,
                sessionIssuerArn: ui.sessionContext?.sessionIssuer?.arn ?? null,
                invokedBy: ui.invokedBy ?? null,
                sourceIpAddress: detail.sourceIPAddress ?? null,
                userAgent: detail.userAgent ?? null,
                resources: (e.Resources ?? []).map((r) => ({
                  type: r.ResourceType ?? null,
                  name: r.ResourceName ?? null,
                })),
              });
            }
            nextToken = truncated ? undefined : res.NextToken;
            pages++;
            if (nextToken && pages >= LOOKUP_EVENTS_MAX_PAGES) {
              truncated = true;
              break;
            }
            // Stay under the 2 req/s LookupEvents throttle.
            if (nextToken) await new Promise((r) => setTimeout(r, 550));
          } while (nextToken);

          const rollup = new Map<string, {
            errorCode: string;
            eventName: string | null;
            count: number;
          }>();
          for (const e of events) {
            if (!e.errorCode) continue;
            const key = `${e.errorCode}|${e.eventName}`;
            const row = rollup.get(key) ??
              { errorCode: e.errorCode, eventName: e.eventName, count: 0 };
            row.count++;
            rollup.set(key, row);
          }

          const handle = await context.writeResource(
            "trail_events",
            args.instanceName,
            {
              window: { start: start.toISOString(), end: end.toISOString() },
              filter: {
                attribute: args.lookupAttribute ?? null,
                value: args.lookupValue ?? null,
                errorsOnly: args.errorsOnly,
                eventSource: args.eventSource ?? null,
              },
              scanned,
              count: events.length,
              events,
              errorSummary: [...rollup.values()].sort((a, b) =>
                b.count - a.count
              ),
              truncated,
              partialError,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info("{count} matching of {scanned} events scanned", {
            count: events.length,
            scanned,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },
  },
};
