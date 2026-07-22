#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-sys
// DynamoDB Datastore Smoke Test — exercises the extension against real AWS.
// SPDX-License-Identifier: Apache-2.0
//
// Usage:
//   export DYNAMODB_TABLE_NAME="swamp-datastore"   # created if autoCreateTable is used below
//   export AWS_REGION="us-east-1"                  # or rely on AWS_PROFILE/default region
//   deno run --allow-net --allow-env --allow-read --allow-write --allow-sys smoke_test.ts

import { datastore } from "./extensions/datastores/dynamodb_datastore/mod.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function log(msg: string) {
  console.log(`${YELLOW}[smoke]${RESET} ${msg}`);
}

function pass(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function fail(msg: string) {
  console.log(`${RED}✗${RESET} ${msg}`);
}

async function main() {
  console.log("\n=== DynamoDB Datastore Smoke Test ===\n");

  const tableName = Deno.env.get("DYNAMODB_TABLE_NAME") ??
    "swamp-datastore-smoke";
  const region = Deno.env.get("AWS_REGION") ?? "us-east-1";

  log(`Table: ${tableName}`);
  log(`Region: ${region}`);

  const provider = datastore.createProvider({
    tableName,
    region,
    autoCreateTable: true,
  });

  log("\n--- Test 1: Health Check ---");
  try {
    const health = await provider.createVerifier().verify();
    if (health.healthy) {
      pass(`Health check passed (${health.latencyMs}ms)`);
    } else {
      fail(`Health check failed: ${health.message}`);
      Deno.exit(1);
    }
  } catch (e) {
    fail(`Health check error: ${e}`);
    Deno.exit(1);
  }

  log("\n--- Test 2: Lock Acquire/Release ---");
  const lock = provider.createLock("/smoke-test", {
    ttlMs: 30_000,
    maxWaitMs: 10_000,
  });
  try {
    log("Acquiring lock...");
    await lock.acquire();
    pass("Lock acquired");

    const info = await lock.inspect();
    if (info) {
      pass(
        `Lock info: holder=${info.holder}, nonce=${
          info.nonce?.substring(0, 8)
        }...`,
      );
    }

    log("Releasing lock...");
    await lock.release();
    pass("Lock released");

    const afterRelease = await lock.inspect();
    if (afterRelease === null) pass("Lock confirmed released");
    else fail("Lock still present after release");
  } catch (e) {
    fail(`Lock test error: ${e}`);
    try {
      await lock.release();
    } catch { /* ignore */ }
  }

  log("\n--- Test 3: Sync Push ---");
  const pushDir = await Deno.makeTempDir({ prefix: "dynamodb-smoke-push-" });
  try {
    await Deno.mkdir(`${pushDir}/data`, { recursive: true });
    const content = JSON.stringify(
      { test: true, timestamp: new Date().toISOString() },
      null,
      2,
    );
    await Deno.writeTextFile(`${pushDir}/data/smoke.json`, content);
    pass("Created test file: data/smoke.json");

    const syncService = provider.createSyncService!(pushDir, pushDir);
    await syncService.markDirty();
    const pushCount = await syncService.pushChanged();
    pass(`Pushed ${pushCount} file(s)`);
  } catch (e) {
    fail(`Push test error: ${e}`);
  }

  log("\n--- Test 4: Sync Pull ---");
  const pullDir = await Deno.makeTempDir({ prefix: "dynamodb-smoke-pull-" });
  try {
    const syncService = provider.createSyncService!(pullDir, pullDir);
    const pullCount = await syncService.pullChanged();
    pass(`Pulled ${pullCount} file(s)`);

    const parsed = JSON.parse(
      await Deno.readTextFile(`${pullDir}/data/smoke.json`),
    );
    if (parsed.test === true) pass("Verified pulled content matches");
    else fail("Pulled content doesn't match expected");
  } catch (e) {
    fail(`Pull test error: ${e}`);
  }

  log("\n--- Cleanup ---");
  try {
    await Deno.remove(pushDir, { recursive: true });
    await Deno.remove(pullDir, { recursive: true });
    pass("Cleaned up temp directories");
  } catch (e) {
    log(`Cleanup warning: ${e}`);
  }

  log(
    `\n${YELLOW}Note:${RESET} smoke-test items remain in DynamoDB table "${tableName}" under keys prefixed "LOCK#/smoke-test" and "FILE#data/smoke.json". Delete the table or those items manually if this was a throwaway run.`,
  );

  console.log(`\n${GREEN}=== Smoke Test Complete ===${RESET}\n`);
}

main().catch((e) => {
  fail(`Unexpected error: ${e}`);
  Deno.exit(1);
});
