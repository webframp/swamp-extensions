/**
 * Datastore benchmarking harness model.
 *
 * Manages setup and execution for two test scenarios:
 * - **throughput**: N models per worker, varied operations, breadth test
 * - **write-stress**: 1 model per worker, continuous writes, depth test
 *
 * **Deployment model:** one harness instance per worker. Each worker creates
 * its own instance (e.g., `bench-harness-w001`) with its `worker_id` baked
 * into globalArguments. This ensures resource names never collide across
 * workers and each worker's data is isolated.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const GlobalArgsSchema = z.object({
  scenario: z
    .enum(["throughput", "write-stress"])
    .describe("Which benchmark scenario to configure for"),
  worker_id: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("Worker identifier (1-100), determines model ownership"),
  models_per_worker: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Models per worker (throughput scenario only)"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SetupResultSchema = z.object({
  scenario: z.string().describe("Scenario configured"),
  workerId: z.number().describe("Worker ID"),
  modelsCreated: z.number().describe("Number of models created"),
  modelPrefix: z.string().describe("Model name prefix for this worker"),
  readProbeName: z.string().describe("Read probe model name for this worker"),
  setupAt: z.string().describe("ISO 8601 timestamp"),
  durationMs: z.number().describe("Setup duration in ms"),
});

const ExecuteResultSchema = z.object({
  scenario: z.string().describe("Scenario executed"),
  workerId: z.number().describe("Worker ID"),
  iteration: z.number().describe("Iteration number"),
  operation: z.string().describe("Operation performed"),
  modelName: z.string().describe("Target model name"),
  payloadSize: z.string().describe("Payload size class"),
  payloadBytes: z.number().describe("Actual payload size in bytes"),
  startedAt: z.string().describe("Operation start ISO 8601"),
  completedAt: z.string().describe("Operation end ISO 8601"),
  durationMs: z.number().describe("Operation wall-clock duration"),
  success: z.boolean().describe("Whether the operation succeeded"),
  errorMessage: z
    .string()
    .describe("Error message if failed, empty if success"),
});

/** Generate a deterministic model name for a worker and index. */
function modelName(workerId: number, index: number): string {
  return `bench-w${String(workerId).padStart(3, "0")}-m${
    String(index).padStart(3, "0")
  }`;
}

/** Generate a read-probe model name for a worker. */
function readProbeName(workerId: number): string {
  return `bench-probe-w${String(workerId).padStart(3, "0")}`;
}

/**
 * Generate a payload of a given size class. Uses only safe ASCII characters
 * (hex digits) to avoid shell-quoting issues entirely.
 */
function generatePayload(
  size: "small" | "medium" | "large",
  iteration: number,
): string {
  const timestamp = new Date().toISOString();
  const header =
    `{"ts":"${timestamp}","iter":${iteration},"sz":"${size}","d":"`;
  const footer = '"}';
  // Fill with hex characters (safe for any shell context)
  const fillChar = (iteration % 16).toString(16);
  switch (size) {
    case "small":
      // ~100 bytes total
      return header + fillChar.repeat(100 - header.length - footer.length) +
        footer;
    case "medium":
      // ~10KB total
      return header + fillChar.repeat(10_000 - header.length - footer.length) +
        footer;
    case "large":
      // ~500KB total (exercises chunked storage at default 256KB maxChunkBytes)
      return header +
        fillChar.repeat(500_000 - header.length - footer.length) + footer;
  }
}

/** Available operation labels for the throughput scenario. */
const THROUGHPUT_OPS = [
  "write-small",
  "write-medium",
  "write-timestamp",
  "write-counter",
  "write-json",
] as const;

/** Payload size rotation for write-stress scenario. */
const PAYLOAD_SIZES = ["small", "medium", "large"] as const;

/** Harness model definition. */
export const model = {
  type: "@webframp/bench-datastore/harness",
  version: "2026.07.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    setup: {
      description: "Setup result — models created for this worker.",
      schema: SetupResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    result: {
      description: "Single iteration execution result with timing data.",
      schema: ExecuteResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1000,
    },
  },
  methods: {
    setup: {
      description:
        "Create the required models for this worker's scenario. Idempotent — safe to re-run.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { scenario, worker_id, models_per_worker } = context.globalArgs;
        const startMs = Date.now();

        const count = scenario === "write-stress" ? 1 : models_per_worker;
        const prefix = `bench-w${String(worker_id).padStart(3, "0")}`;
        const probeName = readProbeName(worker_id);

        // Create worker's owned models
        for (let i = 1; i <= count; i++) {
          const name = modelName(worker_id, i);
          const cmd = new Deno.Command("swamp", {
            args: ["model", "create", "command/shell", name, "--json"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            const stderr = new TextDecoder().decode(output.stderr);
            if (!stderr.includes("already exists")) {
              throw new Error(
                `Failed to create model ${name}: ${stderr.trim()}`,
              );
            }
          }
        }

        // Create worker's read-probe model (for data queries in workflows)
        const probeCmd = new Deno.Command("swamp", {
          args: ["model", "create", "command/shell", probeName, "--json"],
          stdout: "piped",
          stderr: "piped",
        });
        const probeOutput = await probeCmd.output();
        if (!probeOutput.success) {
          const stderr = new TextDecoder().decode(probeOutput.stderr);
          if (!stderr.includes("already exists")) {
            throw new Error(
              `Failed to create probe model ${probeName}: ${stderr.trim()}`,
            );
          }
        }

        const durationMs = Date.now() - startMs;
        const handle = await context.writeResource(
          "setup",
          `w${worker_id}`,
          {
            scenario,
            workerId: worker_id,
            modelsCreated: count,
            modelPrefix: prefix,
            readProbeName: probeName,
            setupAt: new Date().toISOString(),
            durationMs,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    execute: {
      description:
        "Run a single iteration of the configured scenario. Returns timing data.",
      arguments: z.object({
        iteration: z
          .number()
          .int()
          .min(1)
          .describe("Iteration counter (determines model/method rotation)"),
        payload_size: z
          .enum(["small", "medium", "large"])
          .optional()
          .describe(
            "Payload size for write-stress (default: rotates small→medium→large)",
          ),
      }),
      execute: async (
        args: {
          iteration: number;
          payload_size?: "small" | "medium" | "large";
        },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { scenario, worker_id, models_per_worker } = context.globalArgs;
        const { iteration, payload_size } = args;
        const startedAt = new Date().toISOString();
        const startMs = Date.now();

        let operation = "";
        let targetModel = "";
        let payloadSizeClass = "n/a";
        let payloadBytes = 0;
        let success = true;
        let errorMessage = "";

        try {
          if (scenario === "throughput") {
            // Rotate through models and operations
            const modelIdx = ((iteration - 1) % models_per_worker) + 1;
            const opIdx = (iteration - 1) % THROUGHPUT_OPS.length;
            targetModel = modelName(worker_id, modelIdx);
            operation = THROUGHPUT_OPS[opIdx]!;
            payloadSizeClass = "small";

            // Generate a small payload with operation-specific content
            const payload = JSON.stringify({
              op: operation,
              iter: iteration,
              ts: new Date().toISOString(),
              worker: worker_id,
            });
            payloadBytes = new TextEncoder().encode(payload).byteLength;

            const cmd = new Deno.Command("swamp", {
              args: [
                "model",
                "method",
                "run",
                targetModel,
                "execute",
                "--input",
                `run=printf '%s' ${JSON.stringify(payload)}`,
                "--skip-checks",
                "--skip-reports",
                "--json",
              ],
              stdout: "piped",
              stderr: "piped",
            });
            const output = await cmd.output();
            if (!output.success) {
              const stderr = new TextDecoder().decode(output.stderr);
              throw new Error(stderr.trim());
            }
          } else {
            // write-stress: single model, varying payloads
            targetModel = modelName(worker_id, 1);
            payloadSizeClass = payload_size ??
              PAYLOAD_SIZES[(iteration - 1) % PAYLOAD_SIZES.length]!;
            operation = `write-${payloadSizeClass}`;
            const payload = generatePayload(
              payloadSizeClass as "small" | "medium" | "large",
              iteration,
            );
            payloadBytes = new TextEncoder().encode(payload).byteLength;

            // Use printf with the payload as a JSON-escaped argument to avoid
            // shell interpretation of payload content entirely.
            const cmd = new Deno.Command("swamp", {
              args: [
                "model",
                "method",
                "run",
                targetModel,
                "execute",
                "--input",
                `run=printf '%s' ${JSON.stringify(payload)}`,
                "--skip-checks",
                "--skip-reports",
                "--json",
              ],
              stdout: "piped",
              stderr: "piped",
            });
            const output = await cmd.output();
            if (!output.success) {
              const stderr = new TextDecoder().decode(output.stderr);
              throw new Error(stderr.trim());
            }
          }
        } catch (err: unknown) {
          success = false;
          errorMessage = err instanceof Error ? err.message : String(err);
        }

        const durationMs = Date.now() - startMs;
        const completedAt = new Date().toISOString();

        // Only write result if we have meaningful data (operation was assigned)
        if (!operation) {
          operation = "unknown";
          targetModel = targetModel || "unknown";
        }

        const handle = await context.writeResource(
          "result",
          `w${worker_id}-iter-${iteration}`,
          {
            scenario,
            workerId: worker_id,
            iteration,
            operation,
            modelName: targetModel,
            payloadSize: payloadSizeClass,
            payloadBytes,
            startedAt,
            completedAt,
            durationMs,
            success,
            errorMessage,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
