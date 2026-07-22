// Opt-in integration test against DynamoDB Local. Never runs in default CI —
// only exercised when DYNAMODB_TEST_ENDPOINT is set:
//
//   docker run -p 8000:8000 amazon/dynamodb-local
//   DYNAMODB_TEST_ENDPOINT="http://localhost:8000" deno task test

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { datastore } from "./mod.ts";

const TEST_ENDPOINT = Deno.env.get("DYNAMODB_TEST_ENDPOINT");
const TABLE_NAME = `swamp-integration-test-${crypto.randomUUID().slice(0, 8)}`;

Deno.test({
  name:
    "integration: verify/acquire/heartbeat/release round-trip against DynamoDB Local",
  ignore: !TEST_ENDPOINT,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = datastore.createProvider({
      tableName: TABLE_NAME,
      region: "us-east-1",
      endpoint: TEST_ENDPOINT,
      autoCreateTable: true,
    });

    const healthBefore = await provider.createVerifier().verify();
    assertEquals(healthBefore.healthy, true);

    const lock = provider.createLock("/integration/path", {
      ttlMs: 3_000,
      retryIntervalMs: 100,
      maxWaitMs: 5_000,
    });
    await lock.acquire();
    assertExists(await lock.inspect());
    assertEquals(await lock.heartbeat(), true);
    await lock.release();
    assertEquals(await lock.inspect(), null);

    const lock2 = provider.createLock("/integration/path", { maxWaitMs: 500 });
    await lock2.acquire();
    const lock3 = provider.createLock("/integration/path", { maxWaitMs: 200 });
    await assertRejects(() => lock3.acquire(), Error, "Lock timeout");
    await lock2.release();
  },
});
