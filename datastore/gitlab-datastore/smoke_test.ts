#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-sys
// GitLab Datastore Smoke Test
// SPDX-License-Identifier: Apache-2.0
//
// Usage:
//   export GITLAB_PROJECT_ID="123"           # or "mygroup/myproject"
//   export GITLAB_TOKEN="glpat-xxxx"
//   export GITLAB_BASE_URL="https://gitlab.example.com"  # optional
//   deno run --allow-net --allow-env --allow-read --allow-write --allow-sys smoke_test.ts

import { datastore } from "./extensions/datastores/gitlab_datastore/mod.ts";

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
  console.log("\n=== GitLab Datastore Smoke Test ===\n");

  // Check environment variables
  const projectId = Deno.env.get("GITLAB_PROJECT_ID");
  const token = Deno.env.get("GITLAB_TOKEN");
  const baseUrl = Deno.env.get("GITLAB_BASE_URL") || "https://gitlab.com";

  if (!projectId || !token) {
    fail("Missing required environment variables");
    console.log(`
Required:
  GITLAB_PROJECT_ID - GitLab project ID (numeric) or path (e.g., "mygroup/myproject")
  GITLAB_TOKEN      - Personal access token with 'api' scope

Optional:
  GITLAB_BASE_URL   - GitLab instance URL (default: https://gitlab.com)
`);
    Deno.exit(1);
  }

  log(`Project ID: ${projectId}`);
  log(`Base URL: ${baseUrl}`);
  log(`Token: ${token.substring(0, 10)}...`);

  // Create provider
  const config = { projectId, token, baseUrl, statePrefix: "smoke-test" };
  const provider = datastore.createProvider(config);

  // Test 1: Health Check
  log("\n--- Test 1: Health Check ---");
  try {
    const verifier = provider.createVerifier();
    const health = await verifier.verify();
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

  // Test 2: Lock Acquire/Release
  log("\n--- Test 2: Lock Acquire/Release ---");
  const lock = provider.createLock("/test", {
    ttlMs: 30000,
    maxWaitMs: 10000,
  });

  try {
    log("Acquiring lock...");
    await lock.acquire();
    pass("Lock acquired");

    const info = await lock.inspect();
    if (info) {
      pass(`Lock info: holder=${info.holder}, nonce=${info.nonce?.substring(0, 8)}...`);
    }

    log("Releasing lock...");
    await lock.release();
    pass("Lock released");

    const afterRelease = await lock.inspect();
    if (afterRelease === null) {
      pass("Lock confirmed released");
    } else {
      fail("Lock still present after release");
    }
  } catch (e) {
    fail(`Lock test error: ${e}`);
    // Try to release anyway
    try {
      await lock.release();
    } catch { /* ignore */ }
  }

  // Test 3: Sync Service - Push
  log("\n--- Test 3: Sync Push ---");
  const tempDir = await Deno.makeTempDir({ prefix: "gitlab-smoke-" });
  log(`Using temp dir: ${tempDir}`);

  try {
    // Create test files
    await Deno.mkdir(`${tempDir}/test-data`, { recursive: true });
    const testContent = JSON.stringify({
      test: true,
      timestamp: new Date().toISOString(),
      message: "Hello from smoke test!",
    }, null, 2);
    await Deno.writeTextFile(`${tempDir}/test-data/smoke.json`, testContent);
    pass("Created test file: test-data/smoke.json");

    // Push to GitLab
    const syncService = provider.createSyncService!(tempDir, tempDir);
    const pushCount = await syncService.pushChanged();
    pass(`Pushed ${pushCount} file(s) to GitLab`);
  } catch (e) {
    fail(`Push test error: ${e}`);
  }

  // Test 4: Sync Service - Pull
  log("\n--- Test 4: Sync Pull ---");
  const pullDir = await Deno.makeTempDir({ prefix: "gitlab-smoke-pull-" });
  log(`Using pull dir: ${pullDir}`);

  try {
    const syncService = provider.createSyncService!(pullDir, pullDir);
    const pullCount = await syncService.pullChanged();
    pass(`Pulled ${pullCount} file(s) from GitLab`);

    // Verify content
    try {
      const content = await Deno.readTextFile(`${pullDir}/test-data/smoke.json`);
      const parsed = JSON.parse(content);
      if (parsed.test === true) {
        pass("Verified pulled content matches");
      } else {
        fail("Pulled content doesn't match expected");
      }
    } catch (e) {
      fail(`Failed to read pulled file: ${e}`);
    }
  } catch (e) {
    fail(`Pull test error: ${e}`);
  }

  // Cleanup
  log("\n--- Cleanup ---");
  try {
    await Deno.remove(tempDir, { recursive: true });
    await Deno.remove(pullDir, { recursive: true });
    pass("Cleaned up temp directories");
  } catch (e) {
    log(`Cleanup warning: ${e}`);
  }

  // Note about GitLab state cleanup
  log(`
${YELLOW}Note:${RESET} Test states were created in GitLab with prefix "smoke-test--".
You may want to delete them manually:
  - smoke-test--lock
  - smoke-test--test-data--smoke.json

Or use the GitLab UI: Settings > Infrastructure > Terraform states
`);

  console.log(`\n${GREEN}=== Smoke Test Complete ===${RESET}\n`);
}

main().catch((e) => {
  fail(`Unexpected error: ${e}`);
  Deno.exit(1);
});
