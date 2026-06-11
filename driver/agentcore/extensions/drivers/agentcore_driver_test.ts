import { assertEquals, assertStringIncludes } from "@std/assert";
import { driver } from "./agentcore_driver.ts";

const MOCK_CONFIG = {
  runtimeArn:
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent-runtime/test-worker",
  region: "us-east-1",
  s3Bucket: "test-swamp-coordination",
  s3Prefix: "swamp-agentcore/tasks",
  timeout: 5000,
  pollInterval: 100,
};

const MOCK_REQUEST = {
  protocolVersion: 1,
  modelType: "@webframp/aws/inventory",
  modelId: "test-model-id",
  methodName: "inventory_all",
  globalArgs: { region: "us-east-1" },
  methodArgs: {},
  definitionMeta: {
    id: "def-123",
    name: "inv-prd-us-east-1",
    version: 1,
    tags: { account: "prd" },
  },
  resourceSpecs: { inventory: {} },
  bundle: new TextEncoder().encode("// bundled model code"),
};

Deno.test("driver export has correct type and metadata", () => {
  assertEquals(driver.type, "@webframp/agentcore");
  assertEquals(driver.name, "AWS AgentCore");
  assertEquals(typeof driver.description, "string");
  assertEquals(typeof driver.createDriver, "function");
});

Deno.test("createDriver throws without runtimeArn", () => {
  try {
    driver.createDriver({ s3Bucket: "test" });
    throw new Error("Should have thrown");
  } catch (e) {
    assertEquals(
      (e as Error).message,
      "AgentCore driver requires 'runtimeArn' in config",
    );
  }
});

Deno.test("createDriver throws without s3Bucket", () => {
  try {
    driver.createDriver({ runtimeArn: "arn:aws:test" });
    throw new Error("Should have thrown");
  } catch (e) {
    assertEquals(
      (e as Error).message,
      "AgentCore driver requires 's3Bucket' in config for coordination",
    );
  }
});

Deno.test({
  name: "createDriver returns driver instance with correct type",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const instance = driver.createDriver(MOCK_CONFIG);
    assertEquals(instance.type, "@webframp/agentcore");
    assertEquals(typeof instance.execute, "function");
    assertEquals(typeof instance.shutdown, "function");
  },
});

Deno.test("execute rejects when no bundle provided", async () => {
  const instance = driver.createDriver(MOCK_CONFIG);
  const noBundleRequest = { ...MOCK_REQUEST, bundle: undefined };

  const result = await instance.execute(noBundleRequest);
  assertEquals(result.status, "error");
  assertEquals(
    result.error,
    "AgentCore driver requires a bundle for remote execution. " +
      "Ensure the model type has been bundled.",
  );
});

Deno.test("execute rejects with empty bundle", async () => {
  const instance = driver.createDriver(MOCK_CONFIG);
  const emptyBundleRequest = { ...MOCK_REQUEST, bundle: new Uint8Array(0) };

  const result = await instance.execute(emptyBundleRequest);
  assertEquals(result.status, "error");
});

Deno.test({
  name: "execute streams logs via callbacks",
  sanitizeResources: false,
  async fn() {
    const instance = driver.createDriver(MOCK_CONFIG);
    const capturedLogs: string[] = [];

    const result = await instance.execute(MOCK_REQUEST, {
      onLog: (line) => capturedLogs.push(line),
    });

    assertEquals(result.status, "error");
    const hasStartLog = capturedLogs.some((l) =>
      l.includes("[agentcore] Starting task")
    );
    assertEquals(hasStartLog, true);

    const hasRuntimeLog = capturedLogs.some((l) =>
      l.includes("[agentcore] Runtime:")
    );
    assertEquals(hasRuntimeLog, true);
  },
});

Deno.test({
  name: "shutdown destroys clients",
  sanitizeResources: false,
  async fn() {
    const instance = driver.createDriver(MOCK_CONFIG);
    await instance.shutdown!();
  },
});

// Mock-based tests using a local HTTP server to intercept AWS SDK calls.
// The S3 and AgentCore clients both use HTTP under the hood; by setting
// AWS_ENDPOINT_URL we route all calls to a local server that simulates
// the S3 coordination pattern.

function createMockAwsServer(): {
  server: Deno.HttpServer;
  port: number;
  s3Objects: Map<string, Uint8Array>;
  invocations: Array<{ arn: string; payload: string }>;
} {
  const s3Objects = new Map<string, Uint8Array>();
  const invocations: Array<{ arn: string; payload: string }> = [];

  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    // AgentCore InvokeAgentRuntime — POST requests that aren't S3
    // S3 PUTs go to /bucket/key paths; AgentCore goes to service endpoints
    if (req.method === "POST" && !path.startsWith(`/${MOCK_CONFIG.s3Bucket}`)) {
      const body = await req.text();
      invocations.push({ arn: path, payload: body });
      return new Response("{}", { status: 200 });
    }

    // S3 path-style: /bucket/key — strip the bucket prefix
    const bucketPrefix = `/${MOCK_CONFIG.s3Bucket}/`;
    const key = path.startsWith(bucketPrefix)
      ? path.slice(bucketPrefix.length)
      : path.slice(1);

    // S3 PutObject
    if (req.method === "PUT") {
      const body = new Uint8Array(await req.arrayBuffer());
      s3Objects.set(key, body);
      return new Response("", { status: 200, headers: { ETag: '"mock"' } });
    }

    // S3 GetObject
    if (req.method === "GET" || req.method === "HEAD") {
      const obj = s3Objects.get(key);
      if (obj) {
        return new Response(new Uint8Array(obj) as unknown as BodyInit, { status: 200 });
      }
      return new Response(
        '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>',
        { status: 404, headers: { "Content-Type": "application/xml" } },
      );
    }

    return new Response("", { status: 404 });
  });

  const addr = server.addr as Deno.NetAddr;
  return { server, port: addr.port, s3Objects, invocations };
}

Deno.test({
  name: "execute success path: stages, invokes, polls, returns output",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { server, port, s3Objects, invocations } = createMockAwsServer();
    const endpoint = `http://127.0.0.1:${port}`;

    const origEndpoint = Deno.env.get("AWS_ENDPOINT_URL");
    const origKey = Deno.env.get("AWS_ACCESS_KEY_ID");
    const origSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
    const origProfile = Deno.env.get("AWS_PROFILE");

    Deno.env.set("AWS_ENDPOINT_URL", endpoint);
    Deno.env.set("AWS_ACCESS_KEY_ID", "test");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test");
    Deno.env.delete("AWS_PROFILE");

    try {
      const instance = driver.createDriver({
        ...MOCK_CONFIG,
        timeout: 5000,
        pollInterval: 50,
      });

      const executePromise = instance.execute(MOCK_REQUEST, {
        onLog: () => {},
      });

      // Wait for the bundle and request to be staged, then simulate worker
      while (s3Objects.size < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // Derive keys from the staged request path
      const requestKey = [...s3Objects.keys()].find((k) =>
        k.endsWith("/request.json")
      );
      const statusKey = requestKey?.replace("/request.json", "/status.json");
      const outputPrefix = requestKey?.replace("/request.json", "/outputs");

      if (statusKey && outputPrefix) {
        // Simulate worker writing output
        const outputKey = `${outputPrefix}/output-0.json`;
        const outputData = {
          specName: "inventory",
          name: "inventory",
          type: "resource",
          content: { region: "us-east-1", instances: 42 },
        };
        s3Objects.set(
          outputKey,
          new TextEncoder().encode(JSON.stringify(outputData)),
        );

        // Simulate worker writing success status
        const status = {
          state: "success",
          outputKeys: [outputKey],
          logs: ["[worker] Task completed"],
          durationMs: 150,
        };
        s3Objects.set(statusKey, new TextEncoder().encode(JSON.stringify(status)));
      }

      const result = await executePromise;

      assertEquals(result.status, "success");
      assertEquals(result.outputs.length, 1);
      const output = result.outputs[0]!;
      assertEquals(output.kind, "pending");
      assertEquals(output.specName, "inventory");
      assertEquals(output.type, "resource");

      const content = JSON.parse(
        new TextDecoder().decode(output.content),
      );
      assertEquals(content.region, "us-east-1");
      assertEquals(content.instances, 42);

      assertEquals(result.durationMs > 0, true);
      assertEquals(invocations.length, 1);

      // Verify bundle was staged
      const bundleKey = [...s3Objects.keys()].find((k) =>
        k.endsWith("/bundle.js")
      );
      assertEquals(bundleKey !== undefined, true);

      await instance.shutdown!();
    } finally {
      if (origEndpoint) Deno.env.set("AWS_ENDPOINT_URL", origEndpoint);
      else Deno.env.delete("AWS_ENDPOINT_URL");
      if (origKey) Deno.env.set("AWS_ACCESS_KEY_ID", origKey);
      else Deno.env.delete("AWS_ACCESS_KEY_ID");
      if (origSecret) Deno.env.set("AWS_SECRET_ACCESS_KEY", origSecret);
      else Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      if (origProfile) Deno.env.set("AWS_PROFILE", origProfile);
      else Deno.env.delete("AWS_PROFILE");
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "execute timeout path: returns error when worker never writes status",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { server, port } = createMockAwsServer();
    const endpoint = `http://127.0.0.1:${port}`;

    const origEndpoint = Deno.env.get("AWS_ENDPOINT_URL");
    const origKey = Deno.env.get("AWS_ACCESS_KEY_ID");
    const origSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
    const origProfile = Deno.env.get("AWS_PROFILE");

    Deno.env.set("AWS_ENDPOINT_URL", endpoint);
    Deno.env.set("AWS_ACCESS_KEY_ID", "test");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test");
    Deno.env.delete("AWS_PROFILE");

    try {
      const instance = driver.createDriver({
        ...MOCK_CONFIG,
        timeout: 300,
        pollInterval: 50,
      });

      const result = await instance.execute(MOCK_REQUEST);

      assertEquals(result.status, "error");
      assertStringIncludes(result.error!, "Timed out");
      assertEquals(result.outputs.length, 0);
      assertEquals(result.durationMs > 0, true);

      await instance.shutdown!();
    } finally {
      if (origEndpoint) Deno.env.set("AWS_ENDPOINT_URL", origEndpoint);
      else Deno.env.delete("AWS_ENDPOINT_URL");
      if (origKey) Deno.env.set("AWS_ACCESS_KEY_ID", origKey);
      else Deno.env.delete("AWS_ACCESS_KEY_ID");
      if (origSecret) Deno.env.set("AWS_SECRET_ACCESS_KEY", origSecret);
      else Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      if (origProfile) Deno.env.set("AWS_PROFILE", origProfile);
      else Deno.env.delete("AWS_PROFILE");
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "execute worker error path: returns error with worker message",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { server, port, s3Objects } = createMockAwsServer();
    const endpoint = `http://127.0.0.1:${port}`;

    const origEndpoint = Deno.env.get("AWS_ENDPOINT_URL");
    const origKey = Deno.env.get("AWS_ACCESS_KEY_ID");
    const origSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
    const origProfile = Deno.env.get("AWS_PROFILE");

    Deno.env.set("AWS_ENDPOINT_URL", endpoint);
    Deno.env.set("AWS_ACCESS_KEY_ID", "test");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test");
    Deno.env.delete("AWS_PROFILE");

    try {
      const instance = driver.createDriver({
        ...MOCK_CONFIG,
        timeout: 5000,
        pollInterval: 50,
      });

      const executePromise = instance.execute(MOCK_REQUEST);

      while (s3Objects.size < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      const statusKey = [...s3Objects.keys()].find((k) =>
        k.endsWith("/request.json")
      )?.replace("/request.json", "/status.json");
      if (statusKey) {
        const status = {
          state: "error",
          error: "Method 'inventory_all' threw: connection refused",
          logs: ["[worker] Fetching bundle", "[worker] Error: connection refused"],
          durationMs: 80,
        };
        s3Objects.set(statusKey, new TextEncoder().encode(JSON.stringify(status)));
      }

      const result = await executePromise;

      assertEquals(result.status, "error");
      assertStringIncludes(result.error!, "connection refused");
      assertEquals(result.outputs.length, 0);
      assertEquals(result.logs.length > 0, true);

      await instance.shutdown!();
    } finally {
      if (origEndpoint) Deno.env.set("AWS_ENDPOINT_URL", origEndpoint);
      else Deno.env.delete("AWS_ENDPOINT_URL");
      if (origKey) Deno.env.set("AWS_ACCESS_KEY_ID", origKey);
      else Deno.env.delete("AWS_ACCESS_KEY_ID");
      if (origSecret) Deno.env.set("AWS_SECRET_ACCESS_KEY", origSecret);
      else Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      if (origProfile) Deno.env.set("AWS_PROFILE", origProfile);
      else Deno.env.delete("AWS_PROFILE");
      await server.shutdown();
    }
  },
});
