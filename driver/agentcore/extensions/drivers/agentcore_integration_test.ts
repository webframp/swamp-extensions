/**
 * Integration test for the AgentCore driver against a live deployment.
 *
 * Requires:
 *   AGENTCORE_RUNTIME_ARN - ARN of a deployed AgentCore runtime
 *   AGENTCORE_S3_BUCKET   - S3 coordination bucket
 *   AWS_REGION            - Region (default: us-east-1)
 *
 * Skip conditions: if env vars are missing, tests are skipped gracefully.
 * Run with: deno test --allow-env --allow-net --allow-read extensions/drivers/agentcore_integration_test.ts
 */
import { assertEquals } from "@std/assert";
import { driver } from "./agentcore_driver.ts";

const RUNTIME_ARN = Deno.env.get("AGENTCORE_RUNTIME_ARN");
const S3_BUCKET = Deno.env.get("AGENTCORE_S3_BUCKET");
const REGION = Deno.env.get("AWS_REGION") ?? "us-east-1";
const PROFILE = Deno.env.get("AWS_PROFILE");

const SKIP = !RUNTIME_ARN || !S3_BUCKET;

const NOOP_BUNDLE = new TextEncoder().encode(`
import { z } from "npm:zod@4.4.3";
export const model = {
  type: "@test/integration-probe",
  version: "2026.06.11.1",
  globalArguments: z.object({}),
  resources: {
    probe: {
      description: "Integration test probe",
      schema: z.object({ ts: z.string(), echo: z.string() }).passthrough(),
      lifetime: "1d",
      garbageCollection: 5,
    },
  },
  methods: {
    ping: {
      description: "Return a timestamp and echo input",
      arguments: z.object({ echo: z.string() }),
      execute: async (args, context) => {
        const data = { ts: new Date().toISOString(), echo: args.echo };
        const handle = await context.writeResource("probe", "ping", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
`);

Deno.test({
  name: "integration: full round-trip through AgentCore",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const instance = driver.createDriver({
      runtimeArn: RUNTIME_ARN,
      region: REGION,
      s3Bucket: S3_BUCKET,
      timeout: 120_000,
      pollInterval: 3_000,
      profile: PROFILE,
    });

    const logs: string[] = [];

    const result = await instance.execute(
      {
        protocolVersion: 1,
        modelType: "@test/integration-probe",
        modelId: "integration-test",
        methodName: "ping",
        globalArgs: {},
        methodArgs: { echo: "hello-from-integration-test" },
        definitionMeta: {
          id: "integ-test-def",
          name: "integ-probe",
          version: 1,
          tags: { test: "true" },
        },
        resourceSpecs: { probe: {} },
        bundle: NOOP_BUNDLE,
      },
      { onLog: (line) => logs.push(line) },
    );

    console.log("Integration test logs:", logs);
    console.log("Result status:", result.status);

    assertEquals(result.status, "success");
    assertEquals(result.outputs.length > 0, true);

    const output = result.outputs[0]!;
    assertEquals(output.specName, "probe");
    const content = JSON.parse(new TextDecoder().decode(output.content));
    assertEquals(content.echo, "hello-from-integration-test");
    assertEquals(typeof content.ts, "string");

    await instance.shutdown!();
  },
});

Deno.test({
  name: "integration: execute respects timeout on unreachable runtime",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const instance = driver.createDriver({
      runtimeArn: RUNTIME_ARN!.replace(/[^/]+$/, "nonexistent_runtime"),
      region: REGION,
      s3Bucket: S3_BUCKET,
      timeout: 10_000,
      pollInterval: 1_000,
      profile: PROFILE,
    });

    const result = await instance.execute(
      {
        protocolVersion: 1,
        modelType: "@test/integration-probe",
        modelId: "timeout-test",
        methodName: "ping",
        globalArgs: {},
        methodArgs: { echo: "should-timeout" },
        definitionMeta: {
          id: "timeout-def",
          name: "timeout-probe",
          version: 1,
          tags: {},
        },
        bundle: NOOP_BUNDLE,
      },
    );

    assertEquals(result.status, "error");
    await instance.shutdown!();
  },
});
