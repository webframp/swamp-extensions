// HashiCorp Vault Provider Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { assertVaultExportConformance } from "@systeminit/swamp-testing";
import { vault } from "./hashicorp.ts";

// ---------------------------------------------------------------------------
// Export conformance tests
// ---------------------------------------------------------------------------

Deno.test("vault export conforms to VaultProvider contract", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [
      { address: "https://vault.example.com:8200", token: "hvs.xxx" },
      {
        address: "https://vault.example.com",
        token: "hvs.xxx",
        mount: "kv",
      },
      {
        address: "https://vault.example.com",
        token: "hvs.xxx",
        kvVersion: "1",
      },
      {
        address: "https://vault.example.com",
        token: "hvs.xxx",
        namespace: "admin",
      },
    ],
    invalidConfigs: [
      {}, // Missing required fields
      { address: "https://vault.example.com" }, // Missing token
      { token: "hvs.xxx" }, // Missing address
      { address: "not-a-url", token: "hvs.xxx" }, // Invalid URL
    ],
  });
});

Deno.test("createProvider throws on missing address", () => {
  assertThrows(
    () => vault.createProvider("bad-vault", { token: "hvs.xxx" }),
    Error,
  );
});

Deno.test("createProvider throws on missing token", () => {
  assertThrows(
    () =>
      vault.createProvider("bad-vault", {
        address: "https://vault.example.com",
      }),
    Error,
  );
});

Deno.test("createProvider accepts valid config", () => {
  const provider = vault.createProvider("test-vault", {
    address: "https://vault.example.com:8200",
    token: "hvs.test-token",
  });
  assertEquals(provider.getName(), "test-vault");
});

// ---------------------------------------------------------------------------
// Mock Vault Server
// ---------------------------------------------------------------------------

interface MockVaultServer {
  url: string;
  server: Deno.HttpServer;
  secrets: Map<string, Record<string, unknown>>;
  lastHeaders: Headers | null;
}

function startMockVaultServer(kvVersion: "1" | "2" = "2"): MockVaultServer {
  const secrets = new Map<string, Record<string, unknown>>();
  let lastHeaders: Headers | null = null;

  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    lastHeaders = req.headers;
    const url = new URL(req.url);
    const path = url.pathname;

    // Verify token is present
    const token = req.headers.get("X-Vault-Token");
    if (!token) {
      return Response.json({ errors: ["missing client token"] }, {
        status: 403,
      });
    }

    // KV v2 paths: /v1/secret/data/<key> and /v1/secret/metadata/<key>
    // KV v1 paths: /v1/secret/<key>
    const dataMatch = path.match(/^\/v1\/secret\/data\/(.+)$/);
    const metadataMatch = path.match(/^\/v1\/secret\/metadata(?:\/(.*))?$/);
    const v1Match = path.match(/^\/v1\/secret\/([^/]+.*)$/);

    // Handle KV v2 data operations
    if (kvVersion === "2" && dataMatch) {
      const key = dataMatch[1];

      if (req.method === "GET") {
        const data = secrets.get(key);
        if (!data) {
          return Response.json({ errors: ["secret not found"] }, {
            status: 404,
          });
        }
        return Response.json({ data: { data } });
      }

      if (req.method === "POST") {
        const body = await req.json();
        secrets.set(key, body.data);
        return Response.json({ data: { version: 1 } });
      }
    }

    // Handle KV v2 list operations
    if (kvVersion === "2" && metadataMatch && req.method === "LIST") {
      const prefix = metadataMatch[1] || "";
      const keys: string[] = [];

      for (const key of secrets.keys()) {
        if (prefix) {
          if (key.startsWith(prefix + "/")) {
            const remainder = key.slice(prefix.length + 1);
            const parts = remainder.split("/");
            if (parts.length > 1) {
              const folder = parts[0] + "/";
              if (!keys.includes(folder)) keys.push(folder);
            } else {
              keys.push(parts[0]);
            }
          }
        } else {
          const parts = key.split("/");
          if (parts.length > 1) {
            const folder = parts[0] + "/";
            if (!keys.includes(folder)) keys.push(folder);
          } else {
            keys.push(parts[0]);
          }
        }
      }

      if (keys.length === 0) {
        return Response.json({ errors: ["no secrets found"] }, { status: 404 });
      }

      return Response.json({ data: { keys } });
    }

    // Handle KV v1 operations
    if (kvVersion === "1" && v1Match) {
      const key = v1Match[1];

      if (req.method === "GET") {
        const data = secrets.get(key);
        if (!data) {
          return Response.json({ errors: ["secret not found"] }, {
            status: 404,
          });
        }
        return Response.json({ data });
      }

      if (req.method === "POST") {
        const body = await req.json();
        secrets.set(key, body);
        return Response.json({});
      }

      if (req.method === "LIST") {
        const keys = [...secrets.keys()].filter((k) =>
          k === key || k.startsWith(key + "/")
        );
        if (keys.length === 0) {
          return Response.json({ errors: ["no secrets found"] }, {
            status: 404,
          });
        }
        return Response.json({ data: { keys } });
      }
    }

    return Response.json({ errors: ["not found"] }, { status: 404 });
  });

  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://localhost:${addr.port}`,
    server,
    secrets,
    lastHeaders,
  };
}

// ---------------------------------------------------------------------------
// Behavioral tests - KV v2
// ---------------------------------------------------------------------------

Deno.test({
  name: "hashicorp vault: get returns stored secret (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      secrets.set("my-key", { value: "my-secret-value" });
      const result = await provider.get("my-key");
      assertEquals(result, "my-secret-value");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: get rejects for missing secret (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      await assertRejects(
        () => provider.get("nonexistent"),
        Error,
        "failed",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: put stores secret (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      await provider.put("new-key", "new-value");
      assertEquals(secrets.get("new-key"), { value: "new-value" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: put stores JSON object (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      await provider.put("json-key", '{"user":"admin","pass":"secret"}');
      assertEquals(secrets.get("json-key"), { user: "admin", pass: "secret" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: get returns JSON for multi-field secrets (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      secrets.set("multi-key", { user: "admin", pass: "secret" });
      const result = await provider.get("multi-key");
      assertEquals(JSON.parse(result), { user: "admin", pass: "secret" });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: list returns stored keys (KV v2)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("2");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "2",
      });

      secrets.set("key-a", { value: "a" });
      secrets.set("key-b", { value: "b" });

      const keys = await provider.list();
      assertEquals(keys.includes("key-a"), true);
      assertEquals(keys.includes("key-b"), true);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: custom mount path is used",
  sanitizeResources: false,
  fn: async () => {
    // Create a server that checks the path includes the custom mount
    let requestedPath = "";
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      requestedPath = new URL(req.url).pathname;
      return Response.json({ data: { data: { value: "test" } } });
    });

    const addr = server.addr as Deno.NetAddr;
    const url = `http://localhost:${addr.port}`;

    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        mount: "custom-kv",
        kvVersion: "2",
      });

      await provider.get("test-key");
      assertEquals(requestedPath.includes("custom-kv"), true);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: namespace header is sent when configured",
  sanitizeResources: false,
  fn: async () => {
    let capturedHeaders: Headers | null = null;
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      capturedHeaders = req.headers;
      return Response.json({ data: { data: { value: "test" } } });
    });

    const addr = server.addr as Deno.NetAddr;
    const url = `http://localhost:${addr.port}`;

    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        namespace: "admin/team-a",
      });

      await provider.get("test-key");
      assertEquals(capturedHeaders!.get("X-Vault-Namespace"), "admin/team-a");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: getName returns vault name",
  fn: () => {
    const provider = vault.createProvider("my-hashi-vault", {
      address: "https://vault.example.com",
      token: "test",
    });
    assertEquals(provider.getName(), "my-hashi-vault");
  },
});

// ---------------------------------------------------------------------------
// Behavioral tests - KV v1
// ---------------------------------------------------------------------------

Deno.test({
  name: "hashicorp vault: get returns stored secret (KV v1)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("1");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "1",
      });

      secrets.set("my-key", { value: "my-v1-secret" });
      const result = await provider.get("my-key");
      assertEquals(result, "my-v1-secret");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hashicorp vault: put stores secret (KV v1)",
  sanitizeResources: false,
  fn: async () => {
    const { url, server, secrets } = startMockVaultServer("1");
    try {
      const provider = vault.createProvider("test", {
        address: url,
        token: "test-token",
        kvVersion: "1",
      });

      await provider.put("v1-key", "v1-value");
      assertEquals(secrets.get("v1-key"), { value: "v1-value" });
    } finally {
      await server.shutdown();
    }
  },
});
