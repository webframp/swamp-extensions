/**
 * Swamp AgentCore worker runtime.
 *
 * Runs inside an AWS Bedrock AgentCore microVM (ARM64). Listens on
 * port 8080 for task manifests, pulls bundle + request from S3,
 * executes the method via dynamic import, writes outputs and status
 * back to S3.
 *
 * Conforms to the AgentCore runtime contract:
 * - GET /ping → health check
 * - POST /invocations → task execution
 *
 * @module
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const PORT = 8080;
const WORKER_TMP = "/tmp/swamp-worker";

interface TaskManifest {
  taskId: string;
  bucket: string;
  bundleKey: string;
  requestKey: string;
  outputPrefix: string;
  statusKey: string;
}

interface TaskRequest {
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
  resourceSpecs: Record<string, unknown>;
  fileSpecs: Record<string, unknown>;
  traceHeaders: Record<string, string>;
  env?: Record<string, string>;
}

interface TaskStatus {
  state: "pending" | "running" | "success" | "error";
  error?: string;
  outputKeys?: string[];
  logs?: string[];
  durationMs?: number;
}

const s3 = new S3Client({
  region: Deno.env.get("AWS_REGION") ?? "us-east-1",
});

const EXPECTED_BUCKET = Deno.env.get("SWAMP_S3_BUCKET");

function getBucket(manifest: TaskManifest): string {
  const bucket = manifest.bucket || EXPECTED_BUCKET;
  if (!bucket) {
    throw new Error(
      "Bucket not found in manifest or SWAMP_S3_BUCKET env var",
    );
  }
  if (EXPECTED_BUCKET && bucket !== EXPECTED_BUCKET) {
    throw new Error(
      `Manifest bucket "${bucket}" does not match expected bucket "${EXPECTED_BUCKET}"`,
    );
  }
  return bucket;
}

async function fetchFromS3(bucket: string, key: string): Promise<Uint8Array> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error(`Empty body for s3://${bucket}/${key}`);
  return new Uint8Array(await response.Body.transformToByteArray());
}

async function writeToS3(
  bucket: string,
  key: string,
  body: Uint8Array | string,
): Promise<void> {
  const content = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body;
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }),
  );
}

async function writeStatus(
  bucket: string,
  statusKey: string,
  status: TaskStatus,
): Promise<void> {
  await writeToS3(bucket, statusKey, JSON.stringify(status));
}

const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

async function executeTask(manifest: TaskManifest): Promise<Response> {
  if (!TASK_ID_PATTERN.test(manifest.taskId)) {
    return new Response(
      JSON.stringify({ status: "error", error: "Invalid taskId format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const bucket = getBucket(manifest);
  const start = performance.now();
  const logs: string[] = [];

  await Deno.mkdir(WORKER_TMP, { recursive: true });
  const bundlePath = `${WORKER_TMP}/${manifest.taskId}.ts`;
  const runnerPath = `${WORKER_TMP}/${manifest.taskId}-runner.ts`;
  const resultPath = `${WORKER_TMP}/${manifest.taskId}-result.json`;

  try {
    await writeStatus(bucket, manifest.statusKey, { state: "running" });

    logs.push(`[worker] Fetching bundle from ${manifest.bundleKey}`);
    const bundleBytes = await fetchFromS3(bucket, manifest.bundleKey);

    logs.push(`[worker] Fetching request from ${manifest.requestKey}`);
    const requestBytes = await fetchFromS3(bucket, manifest.requestKey);
    const request: TaskRequest = JSON.parse(
      new TextDecoder().decode(requestBytes),
    );

    await Deno.writeFile(bundlePath, bundleBytes);

    logs.push(
      `[worker] Executing ${request.modelType}::${request.methodName}`,
    );
    const runnerCode = `
import { model } from "./${manifest.taskId}.ts";

const request = ${JSON.stringify(request)};
const method = model.methods[request.methodName];
if (!method) {
  console.error("Method not found: " + request.methodName);
  Deno.exit(1);
}

const outputs = [];
const context = {
  globalArgs: request.globalArgs,
  logger: {
    info: (msg, ...a) => console.error("[model]", msg, ...a),
    warn: (msg, ...a) => console.error("[model:warn]", msg, ...a),
    error: (msg, ...a) => console.error("[model:error]", msg, ...a),
  },
  writeResource: async (specName, name, data) => {
    outputs.push({ specName, name, type: "resource", content: data });
    return { name };
  },
};

const result = await method.execute(request.methodArgs, context);
await Deno.writeTextFile(${
      JSON.stringify(resultPath)
    }, JSON.stringify({ outputs, dataHandles: result.dataHandles }));
`;
    await Deno.writeTextFile(runnerPath, runnerCode);

    const ENV_BLOCKED_PREFIXES = ["AWS_", "DENO_", "LD_", "DYLD_"];
    const ENV_BLOCKLIST = new Set([
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
    ]);
    const baseEnv = Deno.env.toObject();
    let taskEnv = baseEnv;
    if (request.env) {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.env)) {
        if (
          ENV_BLOCKLIST.has(k) ||
          ENV_BLOCKED_PREFIXES.some((p) => k.startsWith(p))
        ) continue;
        filtered[k] = v;
      }
      taskEnv = { ...baseEnv, ...filtered };
    }

    const command = new Deno.Command("deno", {
      args: ["run", "--allow-all", runnerPath],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: taskEnv,
    });

    const process = command.spawn();
    const [_stdout, stderr, status] = await Promise.all([
      readStream(process.stdout),
      readStream(process.stderr),
      process.status,
    ]);

    for (const line of stderr.split("\n").filter(Boolean)) {
      logs.push(`[worker:stderr] ${line}`);
    }

    const durationMs = Math.round(performance.now() - start);

    if (status.code !== 0) {
      await writeStatus(bucket, manifest.statusKey, {
        state: "error",
        error: stderr || `Process exited with code ${status.code}`,
        logs,
        durationMs,
      });
      return new Response(JSON.stringify({ status: "error" }), { status: 200 });
    }

    const outputKeys: string[] = [];
    try {
      const resultJson = await Deno.readTextFile(resultPath);
      const result = JSON.parse(resultJson);
      if (Array.isArray(result.outputs)) {
        for (let i = 0; i < result.outputs.length; i++) {
          const outputKey = `${manifest.outputPrefix}/output-${i}.json`;
          await writeToS3(bucket, outputKey, JSON.stringify(result.outputs[i]));
          outputKeys.push(outputKey);
        }
      }
    } catch (parseError: unknown) {
      const parseMsg = parseError instanceof Error
        ? parseError.message
        : String(parseError);
      logs.push(`[worker] Failed to read result file: ${parseMsg}`);
      await writeStatus(bucket, manifest.statusKey, {
        state: "error",
        error: `Runner completed but produced no valid result: ${parseMsg}`,
        logs,
        durationMs,
      });
      return new Response(JSON.stringify({ status: "error" }), { status: 200 });
    }

    await writeStatus(bucket, manifest.statusKey, {
      state: "success",
      outputKeys,
      logs,
      durationMs,
    });

    logs.push(`[worker] Task ${manifest.taskId} completed in ${durationMs}ms`);
    return new Response(JSON.stringify({ status: "success" }), { status: 200 });
  } catch (error: unknown) {
    const durationMs = Math.round(performance.now() - start);
    const msg = error instanceof Error ? error.message : String(error);
    logs.push(`[worker] Error: ${msg}`);
    try {
      await writeStatus(bucket, manifest.statusKey, {
        state: "error",
        error: msg,
        logs,
        durationMs,
      });
    } catch {
      logs.push("[worker] Failed to write error status to S3");
    }
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
    });
  } finally {
    await Promise.allSettled([
      Deno.remove(bundlePath).catch(() => {}),
      Deno.remove(runnerPath).catch(() => {}),
      Deno.remove(resultPath).catch(() => {}),
    ]);
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/ping") {
    return new Response(JSON.stringify({ status: "Healthy" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST" && url.pathname === "/invocations") {
    const body = await req.text();
    let manifest: TaskManifest;
    try {
      const parsed = JSON.parse(body);
      if (
        !parsed.taskId || !parsed.bucket || !parsed.bundleKey ||
        !parsed.requestKey || !parsed.outputPrefix || !parsed.statusKey
      ) {
        return new Response(
          JSON.stringify({
            status: "error",
            error:
              "Invalid manifest: requires taskId, bucket, bundleKey, requestKey, outputPrefix, statusKey",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      manifest = parsed as TaskManifest;
    } catch {
      return new Response(
        JSON.stringify({ status: "error", error: "Invalid JSON payload" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return await executeTask(manifest);
  }

  return new Response("Not Found", { status: 404 });
});
