/**
 * AWS CloudFormation recovery operations model for swamp.
 *
 * Mutating counterpart to `@webframp/aws/cfn-diagnostics`. It holds the stack
 * operations that change state, so the diagnostics extension can stay
 * read-only. Today that is `continue_update_rollback`, which resumes a stack
 * stuck in UPDATE_ROLLBACK_FAILED.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import {
  CloudFormationClient,
  type CloudFormationClientConfig,
  ContinueUpdateRollbackCommand,
  DescribeStacksCommand,
} from "npm:@aws-sdk/client-cloudformation@3.1139.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1139.0";

const EXTENSION_NAME = "@webframp/aws/cfn-operations";

/** Per-request deadline; the SDK default has none. */
const REQUEST_TIMEOUT_MS = 30_000;

const POLL_INTERVAL_MS = 5_000;

/** The only status ContinueUpdateRollback accepts. */
const REQUIRED_STATUS = "UPDATE_ROLLBACK_FAILED";

/** Statuses that mean the rollback is still running. */
const IN_PROGRESS_STATUSES = new Set([
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
]);

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region of the stack"),
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

const RollbackResultSchema = z.object({
  stackName: z.string(),
  stackId: z.string().nullable(),
  statusBefore: z.string(),
  statusAfter: z.string(),
  statusReason: z.string().nullable(),
  resourcesToSkip: z.array(z.string()),
  submitted: z.boolean().describe(
    "True when ContinueUpdateRollback was accepted by CloudFormation",
  ),
  settled: z.boolean().describe(
    "True when the stack left the in-progress rollback states before the wait ended",
  ),
  succeeded: z.boolean().describe(
    "True when the stack ended in UPDATE_ROLLBACK_COMPLETE",
  ),
  waitedMs: z.number(),
  fetchedAt: z.string(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reqOpts() {
  return { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function makeClient(g: GlobalArgs): CloudFormationClient {
  const config: CloudFormationClientConfig = {
    region: g.region,
    ...(g.profile ? { credentials: fromIni({ profile: g.profile }) } : {}),
  };
  return new CloudFormationClient(config);
}

async function describe(client: CloudFormationClient, stackName: string) {
  const res = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
    reqOpts(),
  );
  const stack = res.Stacks?.[0];
  if (!stack) throw new Error(`Stack ${stackName} not found`);
  return {
    stackId: stack.StackId ?? null,
    status: stack.StackStatus ?? "UNKNOWN",
    reason: stack.StackStatusReason ?? null,
  };
}

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
 * CloudFormation recovery operations. Method: `continue_update_rollback`.
 */
export const model = {
  type: "@webframp/aws/cfn-operations",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [{
    toVersion: "2026.10.14.1",
    description:
      "No schema changes — manifest now declares license: Apache-2.0 (SPDX)",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],

  resources: {
    rollback_result: {
      description: "Outcome of a ContinueUpdateRollback call",
      schema: RollbackResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    continue_update_rollback: {
      description:
        "Resume a stack stuck in UPDATE_ROLLBACK_FAILED. Refuses any other status. Optionally skips resources that cannot be rolled back, then waits for the rollback to settle. Mutating: run it with a profile that has cloudformation:ContinueUpdateRollback and the permissions the rollback itself needs.",
      arguments: z.object({
        stackName: z.string().min(1).describe(
          "Stack name or ID. Use the ID for a stack that was deleted.",
        ),
        resourcesToSkip: z
          .array(z.string().min(1))
          .default([])
          .describe(
            "Logical IDs of resources to skip when rollback cannot complete them. " +
              "Skipped resources are left in whatever state they are in.",
          ),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .default(300)
          .describe(
            "Seconds to wait for the rollback to settle. 0 submits and returns.",
          ),
        instanceName: z
          .string()
          .regex(/^[A-Za-z0-9._-]+$/)
          .refine((n) => n !== "latest" && n !== "." && n !== "..", {
            message: "'latest', '.' and '..' are reserved",
          })
          .default("rollback")
          .describe("Name of the data instance this result is written to"),
      }),
      execute: async (
        args: {
          stackName: string;
          resourcesToSkip: string[];
          waitSeconds: number;
          instanceName: string;
        },
        context: Context,
      ) => {
        const startMs = Date.now();
        const client = makeClient(context.globalArgs);
        try {
          const before = await describe(client, args.stackName);
          if (before.status !== REQUIRED_STATUS) {
            throw new Error(
              `Stack ${args.stackName} is ${before.status}; ContinueUpdateRollback ` +
                `only applies to ${REQUIRED_STATUS}. Nothing was changed.`,
            );
          }

          try {
            await client.send(
              new ContinueUpdateRollbackCommand({
                StackName: args.stackName,
                ResourcesToSkip: args.resourcesToSkip.length > 0
                  ? args.resourcesToSkip
                  : undefined,
              }),
              reqOpts(),
            );
          } catch (err) {
            throw new Error(
              `ContinueUpdateRollback failed for ${args.stackName} ` +
                `(region=${context.globalArgs.region}): ${errMsg(err)}`,
              { cause: err },
            );
          }
          context.logger.info("Submitted ContinueUpdateRollback for {name}", {
            name: args.stackName,
          });

          const waitStart = Date.now();
          let current = await describe(client, args.stackName);
          while (
            args.waitSeconds > 0 &&
            IN_PROGRESS_STATUSES.has(current.status) &&
            Date.now() - waitStart < args.waitSeconds * 1000
          ) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            current = await describe(client, args.stackName);
          }

          const handle = await context.writeResource(
            "rollback_result",
            args.instanceName,
            {
              stackName: args.stackName,
              stackId: current.stackId ?? before.stackId,
              statusBefore: before.status,
              statusAfter: current.status,
              statusReason: current.reason,
              resourcesToSkip: args.resourcesToSkip,
              submitted: true,
              settled: !IN_PROGRESS_STATUSES.has(current.status),
              succeeded: current.status === "UPDATE_ROLLBACK_COMPLETE",
              waitedMs: Date.now() - waitStart,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info("Stack {name} is now {status}", {
            name: args.stackName,
            status: current.status,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },
  },
};
