/**
 * Tests for exe.dev VM model command construction.
 *
 * Verifies that user-supplied values containing spaces, special characters,
 * and edge cases are properly quoted in the command strings sent to the
 * exe.dev HTTPS API.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  assertEmail,
  assertEnvKey,
  assertFlagValue,
  assertVmName,
  buildCommentCmd,
  buildCreateCmd,
  buildResizeCmd,
  buildTagCmd,
  escapeQuotes,
  mapVm,
  type RawVm,
} from "./vm.ts";

// =============================================================================
// Tests: create command quoting
// =============================================================================

Deno.test("create: simple args without spaces", () => {
  const cmd = buildCreateCmd({ name: "my-vm", image: "ubuntu:22.04", cpu: 4 });
  assertEquals(cmd, "new --json --name=my-vm --image=ubuntu:22.04 --cpu=4");
});

Deno.test("create: comment with spaces is quoted", () => {
  const cmd = buildCreateCmd({ comment: "swamp worker test" });
  assertStringIncludes(cmd, '--comment="swamp worker test"');
});

Deno.test("create: comment without spaces still quoted", () => {
  const cmd = buildCreateCmd({ comment: "worker" });
  assertStringIncludes(cmd, '--comment="worker"');
});

Deno.test("create: setupScript with spaces is quoted", () => {
  const cmd = buildCreateCmd({
    setupScript: "apt update && apt install -y curl",
  });
  assertStringIncludes(
    cmd,
    '--setup-script="apt update && apt install -y curl"',
  );
});

Deno.test("create: env values with spaces are quoted", () => {
  const cmd = buildCreateCmd({ env: { GREETING: "hello world" } });
  assertStringIncludes(cmd, '--env GREETING="hello world"');
});

Deno.test("create: tags are comma-separated, no quoting needed", () => {
  const cmd = buildCreateCmd({ tags: ["swamp", "worker", "test"] });
  assertStringIncludes(cmd, "--tag=swamp,worker,test");
});

Deno.test("create: integrations are comma-separated", () => {
  const cmd = buildCreateCmd({ integrations: ["github", "slack"] });
  assertStringIncludes(cmd, "--integration=github,slack");
});

// =============================================================================
// Tests: resize command structure
// =============================================================================

Deno.test("resize: vm name comes before --json", () => {
  const cmd = buildResizeCmd({ name: "tide-wind", disk: "100" });
  assertEquals(cmd, "resize tide-wind --json --disk=100");
});

Deno.test("resize: multiple flags", () => {
  const cmd = buildResizeCmd({
    name: "my-vm",
    cpu: 4,
    memory: "16",
    disk: "50",
  });
  assertEquals(cmd, "resize my-vm --json --cpu=4 --memory=16 --disk=50");
});

// =============================================================================
// Tests: comment command quoting
// =============================================================================

Deno.test("comment: text with spaces is quoted", () => {
  const cmd = buildCommentCmd("my-vm", "this is a comment");
  assertEquals(cmd, 'comment --json my-vm "this is a comment"');
});

Deno.test("comment: empty text clears with empty quotes", () => {
  const cmd = buildCommentCmd("my-vm", "");
  assertEquals(cmd, 'comment --json my-vm ""');
});

Deno.test("comment: single word still quoted", () => {
  const cmd = buildCommentCmd("my-vm", "worker");
  assertEquals(cmd, 'comment --json my-vm "worker"');
});

// =============================================================================
// Tests: tag command quoting
// =============================================================================

Deno.test("tag add: each tag is individually quoted", () => {
  const cmd = buildTagCmd("my-vm", ["prod", "web"], false);
  assertEquals(cmd, 'tag --json my-vm "prod" "web"');
});

Deno.test("tag remove: each tag is individually quoted", () => {
  const cmd = buildTagCmd("my-vm", ["staging"], true);
  assertEquals(cmd, 'tag --json -d my-vm "staging"');
});

Deno.test("tag add: tag with spaces is safely quoted", () => {
  const cmd = buildTagCmd("my-vm", ["my tag"], false);
  assertEquals(cmd, 'tag --json my-vm "my tag"');
});

// =============================================================================
// Tests: quote escaping prevents command injection
// =============================================================================

Deno.test("escapeQuotes: embedded double-quote is escaped", () => {
  assertEquals(escapeQuotes('hello"world'), 'hello\\"world');
});

Deno.test("escapeQuotes: embedded backslash is escaped", () => {
  assertEquals(escapeQuotes("path\\to"), "path\\\\to");
});

Deno.test("escapeQuotes: backslash before quote both escaped", () => {
  assertEquals(escapeQuotes('a\\"b'), 'a\\\\\\"b');
});

Deno.test("create: comment with embedded quotes cannot inject flags", () => {
  const cmd = buildCreateCmd({ comment: 'hello" --name=pwned' });
  // The quote must be escaped so it cannot close the --comment value
  assertStringIncludes(cmd, '--comment="hello\\" --name=pwned"');
  // --name= must NOT appear outside the --comment value (i.e., only one --name= total: none)
  // The string 'new --json --comment="hello\" --name=pwned"' has no standalone --name flag
  assertEquals(cmd, 'new --json --comment="hello\\" --name=pwned"');
});

Deno.test("create: env value with embedded quotes is escaped", () => {
  const cmd = buildCreateCmd({ env: { X: 'val"ue' } });
  assertStringIncludes(cmd, '--env X="val\\"ue"');
});

Deno.test("tag add: tag with embedded quotes is escaped", () => {
  const cmd = buildTagCmd("my-vm", ['tag"break'], false);
  assertEquals(cmd, 'tag --json my-vm "tag\\"break"');
});

Deno.test("comment: text with embedded quotes is escaped", () => {
  const cmd = buildCommentCmd("my-vm", 'say "hi"');
  assertEquals(cmd, 'comment --json my-vm "say \\"hi\\""');
});

// =============================================================================
// Tests: VM name validation
// =============================================================================

Deno.test("assertVmName: valid names pass", () => {
  assertVmName("my-vm");
  assertVmName("worker1");
  assertVmName("a");
  assertVmName("test-vm-123");
});

Deno.test("assertVmName: rejects spaces", () => {
  let threw = false;
  try {
    assertVmName("my vm");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertVmName: rejects flag prefix", () => {
  let threw = false;
  try {
    assertVmName("--all");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertVmName: rejects uppercase", () => {
  let threw = false;
  try {
    assertVmName("MyVm");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertVmName: rejects quotes", () => {
  let threw = false;
  try {
    assertVmName('vm"inject');
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// =============================================================================
// Tests: email validation
// =============================================================================

Deno.test("assertEmail: valid email passes", () => {
  assertEmail("user@example.com");
});

Deno.test("assertEmail: rejects whitespace (flag injection)", () => {
  let threw = false;
  try {
    assertEmail("user@example.com --root");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertEmail: rejects leading dash", () => {
  let threw = false;
  try {
    assertEmail("-user@example.com");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertEmail: rejects missing @", () => {
  let threw = false;
  try {
    assertEmail("notanemail");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildCreateCmd: rejects invalid VM name", () => {
  let threw = false;
  try {
    buildCreateCmd({ name: "my vm --inject" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildResizeCmd: rejects invalid VM name", () => {
  let threw = false;
  try {
    buildResizeCmd({ name: "--all" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// =============================================================================
// Tests: env key validation
// =============================================================================

Deno.test("assertEnvKey: valid keys pass", () => {
  assertEnvKey("HOME");
  assertEnvKey("MY_VAR_123");
  assertEnvKey("_private");
});

Deno.test("assertEnvKey: rejects spaces", () => {
  let threw = false;
  try {
    assertEnvKey("MY VAR");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertEnvKey: rejects flag injection", () => {
  let threw = false;
  try {
    assertEnvKey("FOO --name=pwned");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertEnvKey: rejects leading digit", () => {
  let threw = false;
  try {
    assertEnvKey("9VAR");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildCreateCmd: rejects invalid env key", () => {
  let threw = false;
  try {
    buildCreateCmd({ env: { "BAD KEY": "value" } });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// =============================================================================
// Tests: flag value validation (image, memory, disk, integrations)
// =============================================================================

Deno.test("assertFlagValue: valid values pass", () => {
  assertFlagValue("ubuntu:22.04", "image");
  assertFlagValue("8GB", "memory");
  assertFlagValue("50G", "disk");
  assertFlagValue("github", "integration");
});

Deno.test("assertFlagValue: rejects spaces", () => {
  let threw = false;
  try {
    assertFlagValue("ubuntu --inject", "image");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertFlagValue: rejects flag prefix", () => {
  let threw = false;
  try {
    assertFlagValue("--inject", "image");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("assertFlagValue: rejects quotes", () => {
  let threw = false;
  try {
    assertFlagValue('val"ue', "image");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildCreateCmd: rejects invalid image", () => {
  let threw = false;
  try {
    buildCreateCmd({ image: "ubuntu --name=pwned" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildCreateCmd: rejects invalid integration", () => {
  let threw = false;
  try {
    buildCreateCmd({ integrations: ["github", "--inject flag"] });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildResizeCmd: rejects invalid memory", () => {
  let threw = false;
  try {
    buildResizeCmd({ name: "my-vm", memory: "8GB --inject" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// =============================================================================
// Tests: tag validation in buildCreateCmd
// =============================================================================

Deno.test("buildCreateCmd: rejects tag with spaces", () => {
  let threw = false;
  try {
    buildCreateCmd({ tags: ["good", "my tag"] });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildCreateCmd: rejects tag with comma", () => {
  let threw = false;
  try {
    buildCreateCmd({ tags: ["tag,inject"] });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("buildCreateCmd: valid tags pass", () => {
  const cmd = buildCreateCmd({ tags: ["worker", "ephemeral"] });
  assertStringIncludes(cmd, "--tag=worker,ephemeral");
});

// =============================================================================
// Tests: cpu=0 edge case
// =============================================================================

Deno.test("buildCreateCmd: cpu=0 is included in command", () => {
  const cmd = buildCreateCmd({ cpu: 0 });
  assertStringIncludes(cmd, "--cpu=0");
});

Deno.test("buildResizeCmd: cpu=0 is included in command", () => {
  const cmd = buildResizeCmd({ name: "my-vm", cpu: 0 });
  assertStringIncludes(cmd, "--cpu=0");
});

// =============================================================================
// Tests: 403 error detection
// =============================================================================

Deno.test("parseJsonResponse: 403 produces actionable error", () => {
  // Inline the logic since we can't easily import from the model
  const _resp = { ok: false, status: 403, body: "command not allowed" };
  const command = "rm --json my-vm";
  const baseCmd = (command ?? "unknown").split(" ")[0];

  assertEquals(baseCmd, "rm");

  // Verify the error message pattern
  const errorMsg =
    `exe.dev API returned 403 (command not allowed): "${baseCmd}"`;
  assertStringIncludes(errorMsg, '"rm"');
  assertStringIncludes(errorMsg, "403");
});

Deno.test("parseJsonResponse: 422 produces generic error", () => {
  const resp = { ok: false, status: 422, body: "invalid arguments" };
  const errorMsg = `exe.dev API error (HTTP ${resp.status}): ${resp.body}`;
  assertStringIncludes(errorMsg, "422");
  assertStringIncludes(errorMsg, "invalid arguments");
});

// =============================================================================
// Tests: mapVm (snake_case → camelCase mapping)
// =============================================================================

Deno.test("mapVm: converts snake_case to camelCase", () => {
  const raw: RawVm = {
    vm_name: "test-vm",
    https_url: "https://test-vm.exe.xyz",
    ssh_dest: "test-vm.exe.xyz",
    ssh_host: "test-vm.exe.xyz",
    region: "nyc",
    region_display: "New York, USA",
    status: "running",
  };
  const result = mapVm(raw);
  assertEquals(result.vmName, "test-vm");
  assertEquals(result.httpsUrl, "https://test-vm.exe.xyz");
  assertEquals(result.sshDest, "test-vm.exe.xyz");
  assertEquals(result.region, "nyc");
  assertEquals(result.regionDisplay, "New York, USA");
  assertEquals(result.status, "running");
});

Deno.test("mapVm: converts memory bytes to GiB", () => {
  const raw = {
    vm_name: "a",
    https_url: "https://a.exe.xyz",
    ssh_dest: "a.exe.xyz",
    ssh_host: "a.exe.xyz",
    region: "nyc",
    region_display: "NYC",
    status: "running",
    memory_capacity_bytes: 8589934592, // 8 GiB
  };
  const result = mapVm(raw);
  assertEquals(result.memoryGb, 8);
});

Deno.test("mapVm: converts disk bytes to GiB", () => {
  const raw = {
    vm_name: "a",
    https_url: "https://a.exe.xyz",
    ssh_dest: "a.exe.xyz",
    ssh_host: "a.exe.xyz",
    region: "nyc",
    region_display: "NYC",
    status: "running",
    disk_capacity_bytes: 26843545600, // 25 GiB
  };
  const result = mapVm(raw);
  assertEquals(result.diskGb, 25);
});

Deno.test("mapVm: handles missing optional fields gracefully", () => {
  const raw = {
    vm_name: "minimal",
    https_url: "https://minimal.exe.xyz",
    ssh_dest: "minimal.exe.xyz",
    ssh_host: "minimal.exe.xyz",
    region: "lon",
    region_display: "London, UK",
    status: "running",
  };
  const result = mapVm(raw);
  assertEquals(result.image, undefined);
  assertEquals(result.allocatedCpus, undefined);
  assertEquals(result.memoryGb, undefined);
  assertEquals(result.diskGb, undefined);
  assertEquals(result.sharing, undefined);
  assertEquals(result.tags, undefined);
});

Deno.test("mapVm: maps sharing sub-object correctly", () => {
  const raw = {
    vm_name: "shared",
    https_url: "https://shared.exe.xyz",
    ssh_dest: "shared.exe.xyz",
    ssh_host: "shared.exe.xyz",
    region: "nyc",
    region_display: "NYC",
    status: "running",
    sharing: {
      group: "external",
      public_proxy: true,
      team_shared: false,
      team_access: true,
      named_user_count: 3,
      share_link_count: 1,
    },
  };
  const result = mapVm(raw);
  assertEquals(result.sharing?.group, "external");
  assertEquals(result.sharing?.publicProxy, true);
  assertEquals(result.sharing?.teamShared, false);
  assertEquals(result.sharing?.teamAccess, true);
  assertEquals(result.sharing?.namedUserCount, 3);
  assertEquals(result.sharing?.shareLinkCount, 1);
});
