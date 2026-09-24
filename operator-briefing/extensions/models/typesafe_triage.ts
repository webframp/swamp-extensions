/**
 * Bounded, privacy-preserving batch triage for `@swamp/typesafe-ai`.
 *
 * The upstream `ask` method evaluates one state. Daily queues contain many
 * independent items, so this extension fans them out while holding the Swamp
 * model lock once. It persists one batch resource with answers only: raw
 * states and questions are never retained. A fingerprint of the compact queue
 * is calculated before evaluation so a downstream board can reject a verdict
 * from another snapshot rather than silently reusing it.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { z } from "npm:zod@4.6.5";

const EntrySchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const DescriptionSchema = EntrySchema.nullable();
const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: EntrySchema,
  criteria: z.object({
    true: DescriptionSchema.optional(),
    false: DescriptionSchema.optional(),
  }).optional(),
});
const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: EntrySchema,
  criteria: z.record(z.string(), DescriptionSchema).refine(
    (criteria) => Object.keys(criteria).length >= 2,
    "choice questions need at least two criteria",
  ),
});
const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: EntrySchema,
  criteria: z.array(DescriptionSchema).min(2),
});
const QuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);
const QuestionsSchema = z.record(z.string(), QuestionSchema).refine(
  (questions) => Object.keys(questions).length > 0,
  "at least one question is required",
);

const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), DescriptionSchema),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
]);
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const TriageArgsSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200),
    state: EntrySchema,
  })).min(1).max(100).superRefine((items, ctx) => {
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate item id: ${item.id}`,
          path: [index, "id"],
        });
      }
      ids.add(item.id);
    }
  }),
  questions: QuestionsSchema,
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).default("latest"),
  concurrency: z.number().int().min(1).max(10).default(4),
  model: z.string().min(1).optional(),
});

const TriageBatchSchema = z.object({
  sourceFingerprint: z.string(),
  results: z.array(z.object({
    id: z.string(),
    answers: z.record(z.string(), AnswerSchema),
  })),
  failures: z.array(z.object({ id: z.string(), reason: z.string() })),
  model: z.string(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  evaluatedAt: z.string(),
});

type TriageArgs = z.infer<typeof TriageArgsSchema>;
type TriageResponse = z.infer<typeof ResponseSchema>;

interface Context {
  globalArgs: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
  };
  signal?: AbortSignal;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning?(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Deterministic JSON for a queue fingerprint; resource storage receives none of it. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")
  }}`;
}

async function fingerprint(items: TriageArgs["items"]): Promise<string> {
  const snapshot = items.map(({ id, state }) => ({ id, state }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(snapshot)),
  );
  return `sha256-${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function apiKey(context: Context): string {
  let environmentKey: string | undefined;
  try {
    environmentKey = Deno.env.get("TYPESAFE_API_KEY") ?? undefined;
  } catch {
    // Sandboxed runtimes may prohibit environment access; explicit vault args work.
  }
  const key = context.globalArgs.apiKey ?? environmentKey;
  if (!key) {
    throw new Error(
      "No TypeSafe API key configured. Set the apiKey global argument or TYPESAFE_API_KEY.",
    );
  }
  return key;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

function retryDelayMs(attempt: number, headers: Headers): number {
  const retryAfterMs = Number(headers.get("retry-after-ms"));
  if (
    Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 60_000
  ) {
    return retryAfterMs;
  }
  const retryAfter = headers.get("retry-after");
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1_000 <= 60_000) {
    return seconds * 1_000;
  }
  const retryDate = retryAfter === null ? Number.NaN : Date.parse(retryAfter);
  if (!Number.isNaN(retryDate)) {
    const delay = Math.max(0, retryDate - Date.now());
    if (delay <= 60_000) return delay;
  }
  return Math.round(
    Math.min(500 * 2 ** attempt, 5_000) * (1 - Math.random() * 0.25),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryableError(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError");
}

function assertCompleteAnswers(
  response: TriageResponse,
  questions: z.infer<typeof QuestionsSchema>,
): void {
  for (const [id, question] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type) {
      throw new Error(
        `TypeSafe response did not return a ${question.type} answer for ${id}`,
      );
    }
  }
}

async function evaluate(
  context: Context,
  state: z.infer<typeof EntrySchema>,
  questions: z.infer<typeof QuestionsSchema>,
  model: string,
): Promise<TriageResponse> {
  const base = (context.globalArgs.baseUrl ?? "https://api.typesafe.ai")
    .replace(/\/+$/, "");
  const maxRetries = context.globalArgs.maxRetries ?? 2;
  for (let attempt = 0;; attempt++) {
    const timeout = AbortSignal.timeout(context.globalArgs.timeoutMs ?? 30_000);
    const signal = context.signal
      ? AbortSignal.any([context.signal, timeout])
      : timeout;
    try {
      const response = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey(context)}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "webframp-operator-briefing-triage/1",
        },
        body: JSON.stringify({ state, questions, model }),
        signal,
      });
      if (response.ok) {
        const parsed = ResponseSchema.parse(await response.json());
        assertCompleteAnswers(parsed, questions);
        return parsed;
      }
      if (attempt >= maxRetries || !RETRYABLE_STATUSES.has(response.status)) {
        throw new Error(`TypeSafe returned HTTP ${response.status}`);
      }
      const delay = retryDelayMs(attempt, response.headers);
      context.logger.warning?.("TypeSafe batch evaluation retrying", {
        status: response.status,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await sleep(delay, context.signal);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      if (attempt >= maxRetries || !retryableError(error)) throw error;
      const delay = retryDelayMs(attempt, new Headers());
      context.logger.warning?.(
        "TypeSafe batch evaluation retrying after connection error",
        {
          attempt: attempt + 1,
          delayMs: delay,
        },
      );
      await sleep(delay, context.signal);
    }
  }
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Extension methods added to the official `@swamp/typesafe-ai` type. */
export const extension = {
  type: "@swamp/typesafe-ai",
  resources: {
    triageBatch: {
      description:
        "One source-scoped batch of TypeSafe triage answers; raw caller state is never retained",
      schema: TriageBatchSchema,
      lifetime: "infinite",
      garbageCollection: 40,
    },
  },
  methods: [{
    triage_batch: {
      description:
        "Evaluate compact queue items with shared typed questions, returning one source-scoped batch and isolating individual failures",
      arguments: TriageArgsSchema,
      execute: async (args: TriageArgs, context: Context) => {
        const model = args.model ?? context.globalArgs.model ?? "jev-latest";
        const sourceFingerprint = await fingerprint(args.items);
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        const outcomes = await mapBounded(args.items, args.concurrency, async (
          item,
        ) => {
          try {
            const response = await evaluate(
              context,
              item.state,
              args.questions,
              model,
            );
            totalInputTokens += response.usage.input_tokens;
            totalOutputTokens += response.usage.output_tokens;
            return { id: item.id, answers: response.answers };
          } catch (error) {
            if (context.signal?.aborted) throw error;
            // Do not persist provider errors: they can contain request content.
            return { id: item.id, failed: true as const };
          }
        });
        const results = outcomes.filter(
          (
            outcome,
          ): outcome is { id: string; answers: TriageResponse["answers"] } =>
            "answers" in outcome,
        );
        const failures = outcomes.filter(
          (outcome): outcome is { id: string; failed: true } =>
            "failed" in outcome,
        ).map(({ id }) => ({ id, reason: "evaluation unavailable" }));
        const evaluatedAt = new Date().toISOString();
        context.logger.info("TypeSafe batch triage completed", {
          succeeded: results.length,
          failed: failures.length,
        });
        const handle = await context.writeResource(
          "triageBatch",
          `triage-batch-${args.name}`,
          {
            sourceFingerprint,
            results,
            failures,
            model,
            totalInputTokens,
            totalOutputTokens,
            evaluatedAt,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
