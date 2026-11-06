import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildServeFlags, model, redactSecrets } from "./swamp_serve_fleet.ts";

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
