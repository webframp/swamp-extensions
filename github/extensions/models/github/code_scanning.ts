/**
 * GitHub code-scanning alert triage for `@webframp/github`.
 *
 * Observes code-scanning alerts as typed, queryable data (one resource
 * instance per alert plus a snapshot summary) and exposes approval-gated,
 * idempotent actions to dismiss or reopen a single alert. All traffic goes
 * through the `gh` CLI, so it reuses the CLI's authentication.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.6.7";

/** `owner/name` slug. `.` and `..` segments are rejected: they would let a value rewrite the API path. */
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/).refine(
  (slug) => slug.split("/").every((part) => part !== "." && part !== ".."),
  "owner and name must not be . or ..",
);
/**
 * Idempotency key. No ":" (invalid in Windows paths, and instance names become
 * directory names) and no trailing "." (also invalid on Windows).
 */
const idempotencyKey = z.string().min(1).regex(
  /^[A-Za-z0-9._-]+$/,
  "must contain only alphanumerics, dot, underscore, or hyphen",
).refine((k) => !k.endsWith("."), "must not end with a dot");
/**
 * Caller-facing reason -> the exact string the REST API accepts. The API
 * rejects anything else with a 422, and its values contain spaces and an
 * apostrophe, so callers use snake_case keys instead.
 */
const DISMISS_REASONS = {
  false_positive: "false positive",
  wont_fix: "won't fix",
  used_in_tests: "used in tests",
  mitigated: "mitigated",
} as const;
const dismissReason = z.enum([
  "false_positive",
  "wont_fix",
  "used_in_tests",
  "mitigated",
]);
/** GitHub rejects dismissal comments longer than 280 characters. */
const MAX_DISMISS_COMMENT = 280;
const PAGE_SIZE = 100;
const MAX_ALERTS_CEILING = 1000;
/** Upper bound on alerts per bulk dismissal call. */
const MAX_BULK_DISMISS = 200;
/** One page beyond the ceiling is enough to prove truncation. */
const MAX_PAGES = Math.ceil((MAX_ALERTS_CEILING + 1) / PAGE_SIZE);

type Ctx = {
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  deleteResource: (name: string) => Promise<void>;
  readModelData: (
    modelName: string,
    specName?: string,
  ) => Promise<{ name: string; attributes: unknown }[]>;
  definition: { name: string };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

/** Shape of the fields read from a code-scanning alert; everything is optional on purpose. */
type RawAlert = {
  number: number;
  state?: string;
  created_at?: string;
  updated_at?: string;
  fixed_at?: string | null;
  html_url?: string;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  dismissed_at?: string | null;
  dismissed_by?: { login?: string } | null;
  rule?: {
    id?: string;
    severity?: string | null;
    security_severity_level?: string | null;
    description?: string;
  };
  tool?: { name?: string | null; version?: string | null };
  most_recent_instance?: {
    ref?: string | null;
    location?: {
      path?: string;
      start_line?: number;
      end_line?: number;
    };
  };
};

const key = (slug: string) => encodeURIComponent(slug);

/**
 * Instance names. Names from every spec share one storage namespace, so they
 * must never collide across repos or kinds. "~" separates the parts: the
 * encoded repo slug ([A-Za-z0-9_.-] and "%2F"), the kind, the alert number
 * (digits), and the idempotency key can never contain it, so no two
 * (repo, kind, number, key) tuples produce the same name.
 */
const names = {
  alert: (slug: string, n: number) => `${key(slug)}~alert~${n}`,
  detail: (slug: string, n: number) => `${key(slug)}~alert-detail~${n}`,
  summary: (slug: string) => `${key(slug)}~summary`,
  dismiss: (slug: string, n: number, idem: string) =>
    `${key(slug)}~dismiss~${n}~${idem}`,
  reopen: (slug: string, n: number, idem: string) =>
    `${key(slug)}~reopen~${n}~${idem}`,
};

/** True when a gh failure says GitHub is throttling this client. */
const isRateLimited = (message: string) =>
  /rate limit|HTTP 429|abuse detection/i.test(message);

/** Redact fields whose values are caller-supplied free text before they reach an error message. */
const REDACTED_FIELDS = ["dismissed_comment="];
function redactArgs(args: string[]): string[] {
  return args.map((arg) => {
    const prefix = REDACTED_FIELDS.find((p) => arg.startsWith(p));
    return prefix ? `${prefix}[redacted]` : arg;
  });
}

async function ghApi(args: string[]): Promise<unknown> {
  const out = await new Deno.Command("gh", {
    args: ["api", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `gh api ${redactArgs(args).join(" ")} failed: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  const value = new TextDecoder().decode(out.stdout).trim();
  if (value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Return a full data handle for an action marker that already exists. The
 * runtime rejects name-only handles and `writeResource` is the only API that
 * produces a complete one, so the stored record is re-written unchanged.
 * Safe only because `triageAction` has no sensitive fields.
 */
async function existingHandle(
  context: Ctx,
  name: string,
  existing: Record<string, unknown>,
): Promise<{ dataHandles: { name: string }[] }> {
  return {
    dataHandles: [await context.writeResource("triageAction", name, existing)],
  };
}

/** Flatten a raw alert into the CEL-friendly shape stored per instance. */
function toAlert(slug: string, raw: RawAlert, snapshotId: string) {
  const loc = raw.most_recent_instance?.location;
  return {
    repo: slug,
    number: raw.number,
    state: raw.state ?? "unknown",
    snapshotId,
    ruleId: raw.rule?.id ?? "unknown",
    ruleSeverity: raw.rule?.severity ?? null,
    securitySeverityLevel: raw.rule?.security_severity_level ?? null,
    description: raw.rule?.description ?? "",
    tool: raw.tool?.name ?? null,
    ref: raw.most_recent_instance?.ref ?? null,
    path: loc?.path ?? null,
    startLine: loc?.start_line ?? null,
    endLine: loc?.end_line ?? null,
    dismissedReason: raw.dismissed_reason ?? null,
    dismissedComment: raw.dismissed_comment ?? null,
    dismissedAt: raw.dismissed_at ?? null,
    dismissedBy: raw.dismissed_by?.login ?? null,
    fixedAt: raw.fixed_at ?? null,
    htmlUrl: raw.html_url ?? "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Compact record of an alert returned by a state-changing call. */
function compactAlert(result: unknown): Record<string, unknown> {
  const alert = (result ?? {}) as RawAlert;
  return {
    number: alert.number,
    state: alert.state,
    dismissedReason: alert.dismissed_reason ?? null,
    dismissedAt: alert.dismissed_at ?? null,
    htmlUrl: alert.html_url,
  };
}

/**
 * Fail unless a state-changing call returned the alert in the expected state.
 * A marker is only written for a confirmed change: an empty or unexpected
 * response must not become durable evidence that suppresses every retry.
 */
function assertAlertState(
  result: unknown,
  number: number,
  expected: "dismissed" | "open",
): void {
  const alert = result as RawAlert | null;
  if (
    typeof alert !== "object" || alert === null || alert.number !== number ||
    alert.state !== expected
  ) {
    throw new Error(
      `Alert #${number} was not confirmed ${expected}: got ${
        typeof alert === "object" && alert !== null
          ? `state=${String(alert.state)}`
          : "no alert object"
      }`,
    );
  }
}

/**
 * Dismiss one alert unless a marker for this alert and key already exists.
 * Shared by the single and bulk methods so both write identical markers.
 */
async function dismissOne(
  context: Ctx,
  args: {
    repo: string;
    number: number;
    reason: keyof typeof DISMISS_REASONS;
    comment: string;
    idempotencyKey: string;
  },
): Promise<{ name: string }> {
  // The alert number is part of the marker so a reused key cannot make a
  // different alert look already dismissed.
  const resourceName = names.dismiss(
    args.repo,
    args.number,
    args.idempotencyKey,
  );
  const existing = await context.readResource(resourceName);
  if (existing) {
    return (await existingHandle(context, resourceName, existing))
      .dataHandles[0];
  }
  // -f (raw string), never -F: -F expands "@file" values, so a comment
  // beginning with "@" would read a local file.
  const result = await ghApi([
    "--method",
    "PATCH",
    `repos/${args.repo}/code-scanning/alerts/${args.number}`,
    "-f",
    "state=dismissed",
    "-f",
    `dismissed_reason=${DISMISS_REASONS[args.reason]}`,
    "-f",
    `dismissed_comment=${args.comment}`,
  ]);
  assertAlertState(result, args.number, "dismissed");
  return await context.writeResource("triageAction", resourceName, {
    repo: args.repo,
    action: "dismiss_code_scanning_alert",
    target: args.number,
    idempotencyKey: args.idempotencyKey,
    result: {
      alert: compactAlert(result),
      reason: args.reason,
      apiReason: DISMISS_REASONS[args.reason],
      comment: args.comment,
    },
    recordedAt: new Date().toISOString(),
  });
}

/** Code-scanning triage augmentation for `@webframp/github`. */
export const extension = {
  type: "@webframp/github",
  methods: [{
    list_code_scanning_alerts: {
      description:
        "Snapshot code-scanning alerts: one codeScanningAlert instance per alert plus a codeScanningSummary.",
      arguments: z.object({
        repo,
        state: z.enum(["open", "closed", "dismissed", "fixed"]).optional()
          .describe("Alert state filter; omit for every state"),
        severity: z.enum([
          "critical",
          "high",
          "medium",
          "low",
          "warning",
          "note",
          "error",
        ]).optional().describe("Severity filter, applied by GitHub"),
        tool: z.string().min(1).optional().describe("Tool name, e.g. CodeQL"),
        ref: z.string().min(1).optional().describe("Git ref filter"),
        maxAlerts: z.number().int().min(1).max(MAX_ALERTS_CEILING).default(
          MAX_ALERTS_CEILING,
        ),
      }).strict(),
      execute: async (
        args: {
          repo: string;
          state?: string;
          severity?: string;
          tool?: string;
          ref?: string;
          maxAlerts: number;
        },
        context: Ctx,
      ) => {
        const params = new URLSearchParams({ per_page: String(PAGE_SIZE) });
        if (args.state) params.set("state", args.state);
        if (args.severity) params.set("severity", args.severity);
        if (args.tool) params.set("tool_name", args.tool);
        if (args.ref) params.set("ref", args.ref);

        // Page offsets shift while alerts change, so one alert can appear on
        // two pages. Key by number so a repeat is counted once, and fetch one
        // unique item past maxAlerts so `truncated` is exact, not a guess.
        const unique = new Map<number, RawAlert>();
        for (let page = 1; page <= MAX_PAGES; page++) {
          params.set("page", String(page));
          const batch = await ghApi([
            `repos/${args.repo}/code-scanning/alerts?${params}`,
          ]);
          if (!Array.isArray(batch)) {
            throw new Error(
              `Unexpected code-scanning response for ${args.repo}: expected an array`,
            );
          }
          for (const raw of batch as RawAlert[]) {
            if (!Number.isInteger(raw?.number)) {
              throw new Error(
                `Unexpected code-scanning response for ${args.repo}: alert without an integer number`,
              );
            }
            if (!unique.has(raw.number)) unique.set(raw.number, raw);
          }
          if (batch.length < PAGE_SIZE || unique.size > args.maxAlerts) break;
        }
        const collected = [...unique.values()];
        const truncated = collected.length > args.maxAlerts;
        const alerts = collected.slice(0, args.maxAlerts);

        const summaryName = names.summary(args.repo);

        const fetchedAt = new Date().toISOString();
        const rows = alerts.map((raw) => toAlert(args.repo, raw, fetchedAt));
        const handles: { name: string }[] = [];
        for (const row of rows) {
          handles.push(
            await context.writeResource(
              "codeScanningAlert",
              names.alert(args.repo, row.number),
              row,
            ),
          );
        }
        // Written last: the summary is the commit marker for the snapshot.
        handles.push(
          await context.writeResource(
            "codeScanningSummary",
            summaryName,
            {
              repo: args.repo,
              snapshotId: fetchedAt,
              fetchedAt,
              filters: {
                state: args.state ?? null,
                severity: args.severity ?? null,
                tool: args.tool ?? null,
                ref: args.ref ?? null,
              },
              maxAlerts: args.maxAlerts,
              total: rows.length,
              truncated,
              alertNumbers: rows.map((r) => r.number),
              countsByRule: tally(rows.map((r) => r.ruleId)),
              countsBySeverity: tally(
                rows.map((r) =>
                  r.securitySeverityLevel ?? r.ruleSeverity ?? "unknown"
                ),
              ),
            },
          ),
        );
        // The newest snapshot replaces every earlier one for this repo.
        // Enumerate what is actually stored instead of trusting the last
        // summary: a run that died after writing some alerts but before its
        // summary would otherwise leave instances no later run could find.
        const current = new Set(rows.map((r) => r.number));
        const stored = await context.readModelData(
          context.definition.name,
          "codeScanningAlert",
        );
        const stale = stored.filter((record) => {
          const attrs = record.attributes as { repo?: string; number?: number };
          return attrs.repo === args.repo && !current.has(attrs.number ?? -1);
        }).map((record) => record.name);
        const pruneFailures: string[] = [];
        for (const name of stale) {
          try {
            await context.deleteResource(name);
          } catch (error) {
            pruneFailures.push(
              `${name}: ${String((error as Error)?.message ?? error)}`,
            );
          }
        }
        context.logger.info(
          "list_code_scanning_alerts: {total} alerts for {repo} (truncated={truncated}, pruned={pruned})",
          {
            total: rows.length,
            repo: args.repo,
            truncated,
            pruned: stale.length - pruneFailures.length,
          },
        );
        if (pruneFailures.length > 0) {
          // The snapshot is committed; the next run finds these again.
          throw new Error(
            `Snapshot written, but ${pruneFailures.length} superseded alert(s) could not be deleted (the next list retries):\n${
              pruneFailures.join("\n")
            }`,
          );
        }
        return { dataHandles: handles };
      },
    },
    get_code_scanning_alert: {
      description: "Retrieve one code-scanning alert with full rule detail.",
      arguments: z.object({ repo, number: z.number().int().positive() })
        .strict(),
      execute: async (args: { repo: string; number: number }, context: Ctx) => {
        const data = await ghApi([
          `repos/${args.repo}/code-scanning/alerts/${args.number}`,
        ]) as RawAlert | null;
        if (
          typeof data !== "object" || data === null ||
          data.number !== args.number
        ) {
          throw new Error(
            `Unexpected code-scanning response for ${args.repo}#${args.number}: expected that alert`,
          );
        }
        // "-alert-detail-" keeps this instance name distinct from the
        // codeScanningAlert instance "-alert-<n>": instance names share one
        // storage namespace across specs, so equal names would overwrite.
        const handle = await context.writeResource(
          "codeScanningAlertDetail",
          names.detail(args.repo, args.number),
          {
            repo: args.repo,
            number: args.number,
            context: data,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    dismiss_code_scanning_alert: {
      description:
        "Dismiss one approved code-scanning alert with a reason and comment.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        reason: dismissReason,
        comment: z.string().min(1).max(MAX_DISMISS_COMMENT),
        idempotencyKey,
      }).strict(),
      execute: async (
        args: {
          repo: string;
          number: number;
          reason: keyof typeof DISMISS_REASONS;
          comment: string;
          idempotencyKey: string;
        },
        context: Ctx,
      ) => ({ dataHandles: [await dismissOne(context, args)] }),
    },
    dismiss_code_scanning_alerts: {
      description:
        "Dismiss many approved code-scanning alerts with one reason and comment; resumable.",
      arguments: z.object({
        repo,
        numbers: z.array(z.number().int().positive()).min(1).max(
          MAX_BULK_DISMISS,
        ).refine(
          (list) => new Set(list).size === list.length,
          "numbers must not contain duplicates",
        ),
        reason: dismissReason,
        comment: z.string().min(1).max(MAX_DISMISS_COMMENT),
        idempotencyKey,
      }).strict(),
      execute: async (
        args: {
          repo: string;
          numbers: number[];
          reason: keyof typeof DISMISS_REASONS;
          comment: string;
          idempotencyKey: string;
        },
        context: Ctx,
      ) => {
        // One lock acquisition for the whole batch. A failure on one alert
        // does not stop the rest; every success keeps its marker, so running
        // the same call again skips them and retries only the failures.
        const handles: { name: string }[] = [];
        const failures: string[] = [];
        for (const [index, number] of args.numbers.entries()) {
          try {
            handles.push(
              await dismissOne(context, {
                repo: args.repo,
                number,
                reason: args.reason,
                comment: args.comment,
                idempotencyKey: args.idempotencyKey,
              }),
            );
          } catch (error) {
            const message = String((error as Error)?.message ?? error).trim();
            failures.push(`#${number}: ${message}`);
            if (isRateLimited(message)) {
              // Every further request would hit the same wall; stop and say
              // which alerts were never attempted.
              const skipped = args.numbers.slice(index + 1);
              if (skipped.length > 0) {
                failures.push(
                  `not attempted because GitHub is rate limiting: ${
                    skipped.map((n) => `#${n}`).join(", ")
                  }`,
                );
              }
              break;
            }
          }
        }
        context.logger.info(
          "dismiss_code_scanning_alerts: {done} dismissed, {failed} failed for {repo}",
          {
            done: handles.length,
            failed: failures.length,
            repo: args.repo,
          },
        );
        if (failures.length > 0) {
          throw new Error(
            `${failures.length} problem(s) in ${args.numbers.length} alerts (${handles.length} dismissed and recorded; rerun the same call to retry the rest):\n${
              failures.join("\n")
            }`,
          );
        }
        return { dataHandles: handles };
      },
    },
    reopen_code_scanning_alert: {
      description: "Reopen one approved dismissed code-scanning alert.",
      arguments: z.object({
        repo,
        number: z.number().int().positive(),
        idempotencyKey,
      }).strict(),
      execute: async (
        args: { repo: string; number: number; idempotencyKey: string },
        context: Ctx,
      ) => {
        const resourceName = names.reopen(
          args.repo,
          args.number,
          args.idempotencyKey,
        );
        const existing = await context.readResource(resourceName);
        if (existing) {
          return await existingHandle(context, resourceName, existing);
        }
        const result = await ghApi([
          "--method",
          "PATCH",
          `repos/${args.repo}/code-scanning/alerts/${args.number}`,
          "-f",
          "state=open",
        ]);
        assertAlertState(result, args.number, "open");
        const handle = await context.writeResource(
          "triageAction",
          resourceName,
          {
            repo: args.repo,
            action: "reopen_code_scanning_alert",
            target: args.number,
            idempotencyKey: args.idempotencyKey,
            result: { alert: compactAlert(result) },
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
