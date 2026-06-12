/**
 * AWS Bedrock AgentCore execution driver for swamp.
 *
 * Runs model methods in isolated AgentCore microVM sessions. The driver
 * stages the bundle and request to S3, invokes a pre-deployed AgentCore
 * runtime, and polls S3 for the output. The worker microVM pulls assets
 * reactively, executes the method, writes results back to S3, then
 * terminates.
 *
 * @module
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "npm:@aws-sdk/client-bedrock-agentcore@3.1066.0";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.1066.0";
import { fromNodeProviderChain } from "npm:@aws-sdk/credential-providers@3.1066.0";

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_S3_PREFIX = "swamp-agentcore/tasks";

/** Configuration accepted by the AgentCore driver's `createDriver` factory. */
interface AgentCoreDriverConfig {
  /** ARN of the deployed AgentCore runtime (required). */
  runtimeArn: string;
  /** AWS region for S3 and AgentCore API calls. */
  region: string;
  /** S3 bucket used as the coordination bus (required). */
  s3Bucket: string;
  /** Key prefix for task artifacts in S3. */
  s3Prefix?: string;
  /** Maximum time (ms) to wait for worker completion. */
  timeout?: number;
  /** Interval (ms) between S3 status polls. */
  pollInterval?: number;
  /** AWS profile name passed to the credential provider chain. */
  profile?: string;
  /** Extra environment variables forwarded to the worker process. */
  env?: Record<string, string>;
}

/** Validates raw config and applies defaults. Throws on missing required fields. */
function parseConfig(raw?: Record<string, unknown>): AgentCoreDriverConfig {
  const config = (raw ?? {}) as unknown as Partial<AgentCoreDriverConfig>;
  if (!config.runtimeArn) {
    throw new Error(
      "AgentCore driver requires 'runtimeArn' in config",
    );
  }
  if (!config.s3Bucket) {
    throw new Error(
      "AgentCore driver requires 's3Bucket' in config for coordination",
    );
  }
  return {
    runtimeArn: config.runtimeArn,
    region: config.region ?? "us-east-1",
    s3Bucket: config.s3Bucket,
    s3Prefix: config.s3Prefix ?? DEFAULT_S3_PREFIX,
    timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    pollInterval: config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    profile: config.profile,
    env: config.env ?? {},
  };
}

/** Serializable request envelope sent from swamp to the driver. */
interface ExecutionRequest {
  protocolVersion: number;
  modelType: string;
  modelId: string;
  methodName: string;
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  definitionMeta: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  bundle?: Uint8Array;
  traceHeaders?: Record<string, string>;
}

/** Real-time event callbacks streamed during execution. */
interface ExecutionCallbacks {
  onLog?: (line: string) => void;
}

/** Pending output returned by out-of-process drivers for swamp to persist. */
interface DriverOutput {
  kind: "pending";
  specName: string;
  name: string;
  type: "resource" | "file";
  content: Uint8Array;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/** Result returned by the driver after execution completes or fails. */
interface ExecutionResult {
  status: "success" | "error";
  error?: string;
  outputs: DriverOutput[];
  logs: string[];
  durationMs: number;
}

/** Payload sent to the worker via AgentCore invocation. */
interface TaskManifest {
  taskId: string;
  bucket: string;
  bundleKey: string;
  requestKey: string;
  outputPrefix: string;
  statusKey: string;
}

/** Status document written by the worker to S3 upon completion or failure. */
interface TaskStatus {
  state: "pending" | "running" | "success" | "error";
  error?: string;
  outputKeys?: string[];
  logs?: string[];
  durationMs?: number;
}

/** Produces a unique, human-readable task ID from the request metadata. */
function generateTaskId(request: ExecutionRequest): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const suffix = `-${ts}-${rand}`;
  const maxPrefix = 200 - suffix.length;
  const name = request.definitionMeta.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const method = request.methodName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefix = `${name}-${method}`.slice(0, maxPrefix);
  return `${prefix}${suffix}`;
}

/** Writes a blob or string to an S3 key. */
async function stageToS3(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array | string,
): Promise<void> {
  const content = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
    }),
  );
}

/** Reads an S3 object, returning null if the key does not exist. */
async function readFromS3(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array | null> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) return null;
    return new Uint8Array(await response.Body.transformToByteArray());
  } catch (error: unknown) {
    if (
      error instanceof Error && "name" in error &&
      error.name === "NoSuchKey"
    ) {
      return null;
    }
    throw error;
  }
}

/** Polls S3 for the worker's status document until terminal or timeout. */
async function pollForStatus(
  s3: S3Client,
  bucket: string,
  statusKey: string,
  timeout: number,
  pollInterval: number,
  callbacks?: ExecutionCallbacks,
): Promise<TaskStatus> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const data = await readFromS3(s3, bucket, statusKey);
    if (data) {
      const status = JSON.parse(new TextDecoder().decode(data)) as TaskStatus;
      if (status.state === "success" || status.state === "error") {
        return status;
      }
      if (status.state === "running") {
        callbacks?.onLog?.("[agentcore] Worker is executing...");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return {
    state: "error",
    error: `Timed out waiting for worker after ${timeout}ms`,
  };
}

/** Sends the task manifest to the AgentCore runtime for execution. */
async function invokeRuntime(
  client: BedrockAgentCoreClient,
  runtimeArn: string,
  manifest: TaskManifest,
): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(manifest));

  await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      payload,
    }),
  );
}

/**
 * The AgentCore execution driver definition.
 *
 * Routes method execution to AWS Bedrock AgentCore microVM sessions.
 * Coordination happens via S3: bundle and request are staged before
 * invocation, the worker pulls them reactively, executes, and writes
 * output back to S3.
 */
export const driver = {
  type: "@webframp/agentcore",
  name: "AWS AgentCore",
  description:
    "Runs model methods in isolated AWS Bedrock AgentCore microVM sessions. " +
    "Uses S3 for coordination: stages bundle and inputs, invokes the runtime, " +
    "polls for results. Provides elastic remote execution without persistent workers.",

  createDriver: (config?: Record<string, unknown>): {
    type: string;
    initialize?: () => Promise<void>;
    shutdown?: () => Promise<void>;
    execute(
      request: ExecutionRequest,
      callbacks?: ExecutionCallbacks,
    ): Promise<ExecutionResult>;
  } => {
    const parsed = parseConfig(config);

    const credentials = fromNodeProviderChain({
      ...(parsed.profile ? { profile: parsed.profile } : {}),
    });
    const s3 = new S3Client({ region: parsed.region, credentials });
    const agentcore = new BedrockAgentCoreClient({
      region: parsed.region,
      credentials,
    });

    return {
      type: "@webframp/agentcore",

      async execute(
        request: ExecutionRequest,
        callbacks?: ExecutionCallbacks,
      ): Promise<ExecutionResult> {
        const start = performance.now();
        const logs: string[] = [];
        const log = (line: string): void => {
          logs.push(line);
          callbacks?.onLog?.(line);
        };

        const taskId = generateTaskId(request);
        const prefix = `${parsed.s3Prefix}/${taskId}`;
        const bundleKey = `${prefix}/bundle.js`;
        const requestKey = `${prefix}/request.json`;
        const outputPrefix = `${prefix}/outputs`;
        const statusKey = `${prefix}/status.json`;

        log(
          `[agentcore] Starting task ${taskId} for ${request.modelType}::${request.methodName}`,
        );
        log(`[agentcore] Runtime: ${parsed.runtimeArn}`);
        log(`[agentcore] S3 path: s3://${parsed.s3Bucket}/${prefix}`);

        try {
          // Stage bundle to S3
          if (request.bundle && request.bundle.length > 0) {
            await stageToS3(s3, parsed.s3Bucket, bundleKey, request.bundle);
            log(
              `[agentcore] Staged bundle (${request.bundle.byteLength} bytes)`,
            );
          } else {
            return {
              status: "error",
              error:
                "AgentCore driver requires a bundle for remote execution. " +
                "Ensure the model type has been bundled.",
              outputs: [],
              logs,
              durationMs: Math.round(performance.now() - start),
            };
          }

          // Stage request envelope to S3
          const requestData = {
            protocolVersion: request.protocolVersion,
            modelType: request.modelType,
            modelId: request.modelId,
            methodName: request.methodName,
            globalArgs: request.globalArgs,
            methodArgs: request.methodArgs,
            definitionMeta: request.definitionMeta,
            resourceSpecs: request.resourceSpecs ?? {},
            fileSpecs: request.fileSpecs ?? {},
            traceHeaders: request.traceHeaders ?? {},
            env: parsed.env,
          };
          await stageToS3(
            s3,
            parsed.s3Bucket,
            requestKey,
            JSON.stringify(requestData),
          );
          log("[agentcore] Staged request envelope");

          // Build task manifest for the worker
          const manifest: TaskManifest = {
            taskId,
            bucket: parsed.s3Bucket,
            bundleKey,
            requestKey,
            outputPrefix,
            statusKey,
          };

          // Invoke the AgentCore runtime
          log("[agentcore] Invoking runtime...");
          await invokeRuntime(agentcore, parsed.runtimeArn, manifest);
          log("[agentcore] Runtime invoked, polling for completion...");

          // Poll S3 for status
          const status = await pollForStatus(
            s3,
            parsed.s3Bucket,
            statusKey,
            parsed.timeout!,
            parsed.pollInterval!,
            callbacks,
          );

          const durationMs = Math.round(performance.now() - start);

          if (status.state === "error") {
            log(`[agentcore] Worker failed: ${status.error}`);
            return {
              status: "error",
              error: status.error ?? "Unknown worker error",
              outputs: [],
              logs: [...logs, ...(status.logs ?? [])],
              durationMs,
            };
          }

          // Fetch outputs from S3
          const outputs: DriverOutput[] = [];
          if (status.outputKeys) {
            for (const outputKey of status.outputKeys) {
              const data = await readFromS3(s3, parsed.s3Bucket, outputKey);
              if (!data) continue;

              try {
                const outputData = JSON.parse(new TextDecoder().decode(data));
                outputs.push({
                  kind: "pending",
                  specName: outputData.specName ?? request.methodName,
                  name: outputData.name ?? outputData.specName ??
                    request.methodName,
                  type: outputData.type ?? "resource",
                  content: new TextEncoder().encode(
                    typeof outputData.content === "string"
                      ? outputData.content
                      : JSON.stringify(outputData.content),
                  ),
                  tags: outputData.tags,
                  metadata: {
                    ...outputData.metadata,
                    taskId,
                    runtime: parsed.runtimeArn,
                    workerDurationMs: status.durationMs,
                  },
                });
              } catch {
                const specName = request.resourceSpecs
                  ? Object.keys(request.resourceSpecs)[0] ?? request.methodName
                  : request.methodName;
                outputs.push({
                  kind: "pending",
                  specName,
                  name: specName,
                  type: "resource",
                  content: data,
                  metadata: { taskId, runtime: parsed.runtimeArn },
                });
              }
            }
          }

          log(
            `[agentcore] Task completed: ${outputs.length} output(s) in ${durationMs}ms`,
          );

          return {
            status: "success",
            outputs,
            logs: [...logs, ...(status.logs ?? [])],
            durationMs,
          };
        } catch (error: unknown) {
          const durationMs = Math.round(performance.now() - start);
          const msg = error instanceof Error ? error.message : String(error);
          log(`[agentcore] Error: ${msg}`);
          return {
            status: "error",
            error: msg,
            outputs: [],
            logs,
            durationMs,
          };
        }
      },

      shutdown(): Promise<void> {
        s3.destroy();
        agentcore.destroy();
        return Promise.resolve();
      },
    };
  },
};
