// AWS CloudWatch Alarm Investigation Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  GetMetricStatisticsCommand,
  type MetricAlarm,
} from "npm:@aws-sdk/client-cloudwatch@3.1010.0";
import {
  ListSubscriptionsByTopicCommand,
  SNSClient,
} from "npm:@aws-sdk/client-sns@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for CloudWatch and SNS"),
});

const SnsTopicSchema = z.object({
  arn: z.string(),
  subscriptionCount: z.number(),
  protocols: z.array(z.string()),
});

const AlarmDetailSchema = z.object({
  alarmName: z.string(),
  namespace: z.string().nullable(),
  metricName: z.string().nullable(),
  state: z.enum(["OK", "ALARM", "INSUFFICIENT_DATA"]),
  daysInCurrentState: z.number(),
  hasAlarmActions: z.boolean(),
  sns_topics: z.array(SnsTopicSchema),
  recentDataPoints: z.number().nullable(),
  lastMetricTimestamp: z.string().nullable(),
  verdict: z.enum([
    "stale",
    "silent",
    "noisy",
    "orphaned",
    "healthy",
    "unknown",
  ]),
  verdictReason: z.string(),
  fetchedAt: z.string(),
});

const TriageSummarySchema = z.object({
  total: z.number(),
  byVerdict: z.record(z.string(), z.number()),
  byState: z.record(z.string(), z.number()),
  fetchedAt: z.string(),
});

// =============================================================================
// Internal Types
// =============================================================================

type Verdict =
  | "stale"
  | "silent"
  | "noisy"
  | "orphaned"
  | "healthy"
  | "unknown";

type AlarmDetail = z.infer<typeof AlarmDetailSchema>;
type SnsTopicInfo = z.infer<typeof SnsTopicSchema>;

// =============================================================================
// Helper Functions
// =============================================================================

/** Sanitize an alarm name into a valid resource instance name. */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/**
 * Count StateUpdate history entries in the last N days for a given alarm.
 */
async function countRecentStateChanges(
  client: CloudWatchClient,
  alarmName: string,
  days: number,
): Promise<number> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const command = new DescribeAlarmHistoryCommand({
    AlarmName: alarmName,
    HistoryItemType: "StateUpdate",
    StartDate: startDate,
    EndDate: new Date(),
    MaxRecords: 100,
  });
  const response = await client.send(command);
  return (response.AlarmHistoryItems ?? []).length;
}

/**
 * Count non-null metric data points in the last 24 h for a given alarm's
 * metric. Returns null when no metric info is available (e.g. composite alarms
 * or alarms with no namespace).
 */
async function getRecentMetricStats(
  client: CloudWatchClient,
  alarm: MetricAlarm,
): Promise<{ count: number; lastTimestamp: string | null } | null> {
  if (!alarm.Namespace || !alarm.MetricName) return null;

  const endTime = new Date();
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const command = new GetMetricStatisticsCommand({
    Namespace: alarm.Namespace,
    MetricName: alarm.MetricName,
    StartTime: startTime,
    EndTime: endTime,
    Period: 3600, // 1-hour buckets → 24 data points max
    Statistics: ["SampleCount"],
    Dimensions: (alarm.Dimensions ?? []).map((d) => ({
      Name: d.Name ?? "",
      Value: d.Value ?? "",
    })),
  });

  let response;
  try {
    response = await client.send(command);
  } catch {
    // GetMetricStatistics can fail for anomaly-detection alarms etc.
    return null;
  }

  const pts = response.Datapoints ?? [];
  if (pts.length === 0) return { count: 0, lastTimestamp: null };

  pts.sort((a, b) =>
    new Date(b.Timestamp ?? 0).getTime() -
    new Date(a.Timestamp ?? 0).getTime()
  );
  return {
    count: pts.length,
    lastTimestamp: pts[0].Timestamp?.toISOString() ?? null,
  };
}

/**
 * Resolve SNS topic subscription counts and protocols for all alarm actions
 * that are SNS ARNs.
 */
async function resolveSnsTopics(
  snsClient: SNSClient,
  alarmActions: string[],
): Promise<SnsTopicInfo[]> {
  const snsArns = alarmActions.filter((a) => a.startsWith("arn:aws:sns:"));
  const results: SnsTopicInfo[] = [];

  for (const arn of snsArns) {
    try {
      const subscriptions: { Protocol?: string }[] = [];
      let nextToken: string | undefined;
      do {
        const response = await snsClient.send(
          new ListSubscriptionsByTopicCommand({
            TopicArn: arn,
            NextToken: nextToken,
          }),
        );
        subscriptions.push(...(response.Subscriptions ?? []));
        nextToken = response.NextToken;
      } while (nextToken);
      const protocols = [
        ...new Set(
          subscriptions.map((s) => s.Protocol).filter(Boolean) as string[],
        ),
      ];
      results.push({
        arn,
        subscriptionCount: subscriptions.length,
        protocols,
      });
    } catch {
      // Topic may have been deleted or IAM may not permit describe.
      results.push({ arn, subscriptionCount: 0, protocols: [] });
    }
  }
  return results;
}

/** Compute the verdict and reason for a single enriched alarm. */
function classify(
  alarm: MetricAlarm,
  daysInState: number,
  stateChanges7d: number,
  metricStats: { count: number; lastTimestamp: string | null } | null,
): { verdict: Verdict; verdictReason: string } {
  const state = alarm.StateValue;
  const hasActions = (alarm.AlarmActions ?? []).length > 0 &&
    (alarm.ActionsEnabled ?? false);

  // Orphaned: INSUFFICIENT_DATA for > 365 days (metric almost certainly dead)
  if (state === "INSUFFICIENT_DATA" && daysInState > 365) {
    return {
      verdict: "orphaned",
      verdictReason:
        `INSUFFICIENT_DATA for ${daysInState} days — metric likely deleted or filter broken`,
    };
  }

  // Silent: in ALARM but fires nowhere
  if (state === "ALARM" && !hasActions) {
    return {
      verdict: "silent",
      verdictReason: "In ALARM with no alarm actions — alert fires nowhere",
    };
  }

  // Stale: in ALARM for > 180 days
  if (state === "ALARM" && daysInState > 180) {
    return {
      verdict: "stale",
      verdictReason:
        `In ALARM for ${daysInState} days — likely unresolved or forgotten`,
    };
  }

  // Noisy: state changed > 5 times in last 7 days
  if (stateChanges7d > 5) {
    const capNote = stateChanges7d >= 100
      ? " (capped at 100 per API page)"
      : "";
    return {
      verdict: "noisy",
      verdictReason:
        `${stateChanges7d}${capNote} state changes in the last 7 days — threshold may need tuning`,
    };
  }

  // Healthy: OK, has actions, has recent data
  if (
    state === "OK" &&
    hasActions &&
    metricStats !== null &&
    metricStats.count > 0
  ) {
    return {
      verdict: "healthy",
      verdictReason:
        `OK with ${metricStats.count} data points in the last 24 h and active action targets`,
    };
  }

  return {
    verdict: "unknown",
    verdictReason: "Does not clearly match any known anti-pattern",
  };
}

/**
 * Full enrichment pipeline for a single alarm.
 * Calls CloudWatch for metric stats and history, SNS for subscriptions.
 */
async function enrichAlarm(
  cwClient: CloudWatchClient,
  snsClient: SNSClient,
  alarm: MetricAlarm,
): Promise<AlarmDetail> {
  const now = Date.now();
  const stateTs = alarm.StateUpdatedTimestamp
    ? alarm.StateUpdatedTimestamp.getTime()
    : now;
  const daysInCurrentState = Math.floor(
    (now - stateTs) / (1000 * 60 * 60 * 24),
  );

  const [stateChanges7d, metricStats, sns_topics] = await Promise.all([
    countRecentStateChanges(cwClient, alarm.AlarmName ?? "", 7),
    getRecentMetricStats(cwClient, alarm),
    resolveSnsTopics(snsClient, alarm.AlarmActions ?? []),
  ]);

  const hasAlarmActions = (alarm.AlarmActions ?? []).length > 0 &&
    (alarm.ActionsEnabled ?? false);

  const { verdict, verdictReason } = classify(
    alarm,
    daysInCurrentState,
    stateChanges7d,
    metricStats,
  );

  return {
    alarmName: alarm.AlarmName ?? "",
    namespace: alarm.Namespace ?? null,
    metricName: alarm.MetricName ?? null,
    state: (alarm.StateValue as "OK" | "ALARM" | "INSUFFICIENT_DATA") ??
      "INSUFFICIENT_DATA",
    daysInCurrentState,
    hasAlarmActions,
    sns_topics,
    recentDataPoints: metricStats?.count ?? null,
    lastMetricTimestamp: metricStats?.lastTimestamp ?? null,
    verdict,
    verdictReason,
    fetchedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * CloudWatch alarm investigation and triage model.
 *
 * Enriches alarms with metric activity, SNS subscriptions, state-change
 * history, and a verdict classifying each alarm as healthy, stale, silent,
 * noisy, orphaned, or unknown.
 */
export const model = {
  type: "@webframp/aws/alarm-investigation",
  version: "2026.04.22.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    alarm_detail: {
      description: "Enriched detail for a single CloudWatch alarm",
      schema: AlarmDetailSchema,
      lifetime: "2h" as const,
      garbageCollection: 10,
    },
    triage_summary: {
      description: "Aggregate verdict counts from a triage run",
      schema: TriageSummarySchema,
      lifetime: "2h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    investigate: {
      description:
        "Deep-dive enrichment for a single alarm: metric data, SNS subscriptions, days in state, and a verdict",
      arguments: z.object({
        alarmName: z
          .string()
          .describe("The exact CloudWatch alarm name to investigate"),
      }),
      execute: async (
        args: { alarmName: string },
        context: {
          globalArgs: { region: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { region } = context.globalArgs;
        const { alarmName } = args;

        context.logger.info("Investigating alarm {alarmName}", { alarmName });

        const cwClient = new CloudWatchClient({ region });
        const snsClient = new SNSClient({ region });

        const command = new DescribeAlarmsCommand({
          AlarmNames: [alarmName],
        });
        const response = await cwClient.send(command);

        const alarms: MetricAlarm[] = [
          ...(response.MetricAlarms ?? []),
        ];

        if (alarms.length === 0) {
          throw new Error(
            `Alarm not found: "${alarmName}" in region ${region}`,
          );
        }

        const alarm = alarms[0];
        context.logger.info(
          "Fetched alarm definition for {alarmName}, enriching",
          { alarmName },
        );

        const detail = await enrichAlarm(cwClient, snsClient, alarm);

        context.logger.info(
          "Alarm {alarmName} verdict: {verdict} — {reason}",
          {
            alarmName,
            verdict: detail.verdict,
            reason: detail.verdictReason,
          },
        );

        const handle = await context.writeResource(
          "alarm_detail",
          sanitize(alarmName),
          detail,
        );
        return { dataHandles: [handle] };
      },
    },

    triage: {
      description:
        "Enrich all alarms in the account and assign a verdict to each (factory method — one alarm_detail resource per alarm, plus a triage_summary)",
      arguments: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .default(100)
          .describe("Maximum number of alarms to process"),
        stateFilter: z
          .enum(["OK", "ALARM", "INSUFFICIENT_DATA"])
          .optional()
          .describe("Restrict triage to alarms in this state"),
      }),
      execute: async (
        args: {
          limit: number;
          stateFilter?: "OK" | "ALARM" | "INSUFFICIENT_DATA";
        },
        context: {
          globalArgs: { region: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warn: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { region } = context.globalArgs;
        const { limit, stateFilter } = args;

        context.logger.info(
          "Starting triage (limit={limit}, stateFilter={stateFilter})",
          { limit, stateFilter: stateFilter ?? "all" },
        );

        const cwClient = new CloudWatchClient({ region });
        const snsClient = new SNSClient({ region });

        // Fetch all alarms, paginating up to `limit`
        const alarms: MetricAlarm[] = [];
        let nextToken: string | undefined;

        do {
          const command = new DescribeAlarmsCommand({
            StateValue: stateFilter,
            NextToken: nextToken,
            MaxRecords: Math.min(100, limit - alarms.length),
          });
          const response = await cwClient.send(command);

          if (response.MetricAlarms) {
            for (const alarm of response.MetricAlarms) {
              if (alarms.length >= limit) break;
              alarms.push(alarm);
            }
          }

          nextToken = response.NextToken;
        } while (nextToken && alarms.length < limit);

        context.logger.info(
          "Fetched {count} alarms, beginning enrichment",
          { count: alarms.length },
        );

        // Enrich sequentially to avoid rate-limiting CloudWatch/SNS APIs.
        const handles: { name: string }[] = [];
        const verdictCounts: Record<string, number> = {};
        const stateCounts: Record<string, number> = {};

        for (let i = 0; i < alarms.length; i++) {
          const alarm = alarms[i];
          context.logger.info("Enriching {alarmName}", {
            alarmName: alarm.AlarmName ?? "",
          });

          let detail: AlarmDetail;
          try {
            detail = await enrichAlarm(cwClient, snsClient, alarm);
          } catch (err) {
            context.logger.warn(
              "Failed to enrich alarm {alarmName}: {error}",
              {
                alarmName: alarm.AlarmName ?? "",
                error: String(err),
              },
            );
            // Write a degraded record so the alarm still appears in output.
            detail = {
              alarmName: alarm.AlarmName ?? "",
              namespace: alarm.Namespace ?? null,
              metricName: alarm.MetricName ?? null,
              state: (alarm.StateValue as
                | "OK"
                | "ALARM"
                | "INSUFFICIENT_DATA") ?? "INSUFFICIENT_DATA",
              daysInCurrentState: 0,
              hasAlarmActions: (alarm.AlarmActions ?? []).length > 0 &&
                (alarm.ActionsEnabled ?? false),
              sns_topics: [],
              recentDataPoints: null,
              lastMetricTimestamp: null,
              verdict: "unknown",
              verdictReason: `Enrichment failed: ${String(err)}`,
              fetchedAt: new Date().toISOString(),
            };
          }

          verdictCounts[detail.verdict] = (verdictCounts[detail.verdict] ?? 0) +
            1;
          stateCounts[detail.state] = (stateCounts[detail.state] ?? 0) + 1;

          const handle = await context.writeResource(
            "alarm_detail",
            `${sanitize(alarm.AlarmName ?? "unknown")}-${i}`,
            detail,
          );
          handles.push(handle);
        }

        context.logger.info(
          "Triage complete — {total} alarms processed",
          { total: alarms.length },
        );

        const summaryHandle = await context.writeResource(
          "triage_summary",
          "summary",
          {
            total: alarms.length,
            byVerdict: verdictCounts,
            byState: stateCounts,
            fetchedAt: new Date().toISOString(),
          },
        );
        handles.push(summaryHandle);

        return { dataHandles: handles };
      },
    },
  },
};
