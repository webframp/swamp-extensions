// System Diagnostics Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./diagnostics.ts";

// =============================================================================
// Export Structure Tests
// =============================================================================

Deno.test("system model: has correct type", () => {
  assertEquals(model.type, "@webframp/system");
});

Deno.test("system model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("system model: has all 9 resource specs", () => {
  assertExists(model.resources.disk_usage);
  assertExists(model.resources.memory);
  assertExists(model.resources.network_interfaces);
  assertExists(model.resources.os_info);
  assertExists(model.resources.processes);
  assertExists(model.resources.uptime);
  assertExists(model.resources.services);
  assertExists(model.resources.listening_ports);
  assertExists(model.resources.search_results);
});

Deno.test("system model: has all 9 methods", () => {
  assertExists(model.methods.get_disk_usage);
  assertExists(model.methods.get_memory);
  assertExists(model.methods.get_network_interfaces);
  assertExists(model.methods.get_os_info);
  assertExists(model.methods.get_processes);
  assertExists(model.methods.get_uptime);
  assertExists(model.methods.list_services);
  assertExists(model.methods.list_ports);
  assertExists(model.methods.search_processes);
});

Deno.test("system model: each method has arguments and execute", () => {
  for (
    const name of [
      "get_disk_usage",
      "get_memory",
      "get_network_interfaces",
      "get_os_info",
      "get_processes",
      "get_uptime",
      "list_services",
      "list_ports",
      "search_processes",
    ] as const
  ) {
    const method = model.methods[name];
    assertExists(method.arguments, `${name} should have arguments`);
    assertExists(method.execute, `${name} should have execute`);
    assertEquals(typeof method.execute, "function");
  }
});

// =============================================================================
// Deno.Command Mock Helper
// =============================================================================

const OriginalCommand = Deno.Command;

type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  class MockCommand {
    #cmd: string;
    #args: string[];

    constructor(
      cmd: string,
      options: { args?: string[]; stdout?: string; stderr?: string },
    ) {
      this.#cmd = cmd;
      this.#args = options.args ?? [];
    }

    output(): Promise<{
      success: boolean;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }> {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode("command failed"),
      });
    }
  }

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = MockCommand;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

// =============================================================================
// Method Execution Tests
// =============================================================================

Deno.test("system model: get_disk_usage parses df output", async () => {
  const dfOutput = [
    "Filesystem     Type     Size  Used Avail Use% Mounted on",
    "/dev/sda1      ext4      50G   20G   28G  42% /",
    "tmpfs          tmpfs    7.8G     0  7.8G   0% /dev/shm",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: dfOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.get_disk_usage.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_disk_usage.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "disk_usage");

      const data = resources[0].data as {
        filesystems: Array<{
          source: string;
          fstype: string;
          size: string;
          used: string;
          avail: string;
          usePercent: string;
          target: string;
        }>;
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.filesystems[0].source, "/dev/sda1");
      assertEquals(data.filesystems[0].fstype, "ext4");
      assertEquals(data.filesystems[0].size, "50G");
      assertEquals(data.filesystems[0].used, "20G");
      assertEquals(data.filesystems[0].avail, "28G");
      assertEquals(data.filesystems[0].usePercent, "42%");
      assertEquals(data.filesystems[0].target, "/");
      assertEquals(data.filesystems[1].source, "tmpfs");
      assertEquals(data.filesystems[1].target, "/dev/shm");
    },
  );
});

Deno.test("system model: get_memory parses free output", async () => {
  const freeOutput = [
    "               total        used        free      shared  buff/cache   available",
    "Mem:           7.8Gi       3.2Gi       1.1Gi       256Mi       3.5Gi       4.1Gi",
    "Swap:          2.0Gi       512Mi       1.5Gi",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: freeOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.get_memory.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_memory.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "memory");

      const data = resources[0].data as {
        mem: {
          total: string;
          used: string;
          free: string;
          shared: string;
          cache: string;
          available: string;
        };
        swap: { total: string; used: string; free: string };
      };
      assertEquals(data.mem.total, "7.8Gi");
      assertEquals(data.mem.used, "3.2Gi");
      assertEquals(data.mem.free, "1.1Gi");
      assertEquals(data.mem.shared, "256Mi");
      assertEquals(data.mem.cache, "3.5Gi");
      assertEquals(data.mem.available, "4.1Gi");
      assertEquals(data.swap.total, "2.0Gi");
      assertEquals(data.swap.used, "512Mi");
      assertEquals(data.swap.free, "1.5Gi");
    },
  );
});

Deno.test("system model: get_uptime parses both uptime calls", async () => {
  const bootTimeOutput = "2026-04-10 08:30:00";
  const uptimeOutput =
    " 12:30:00 up 2 days,  4:00,  3 users,  load average: 0.15, 0.10, 0.05";

  await withMockedCommand(
    (_cmd, args) => {
      if (args.includes("-s")) {
        return { stdout: bootTimeOutput, success: true };
      }
      return { stdout: uptimeOutput, success: true };
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.get_uptime.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_uptime.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "uptime");

      const data = resources[0].data as {
        bootTime: string;
        uptimeString: string;
        loadAverage1m: string;
        loadAverage5m: string;
        loadAverage15m: string;
      };
      assertEquals(data.bootTime, "2026-04-10 08:30:00");
      assertEquals(data.uptimeString, uptimeOutput.trim());
      assertEquals(data.loadAverage1m, "0.15");
      assertEquals(data.loadAverage5m, "0.10");
      assertEquals(data.loadAverage15m, "0.05");
    },
  );
});

Deno.test("system model: get_processes parses ps aux output", async () => {
  // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
  const psOutput = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "root         1  2.5  0.1 169328 13296 ?        Ss   Apr10   1:23 /sbin/init splash",
    "www-data  1234  1.2  3.4 567890 12345 ?        Sl   Apr10   0:45 /usr/sbin/apache2 -k start",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: psOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.get_processes.execute(
        { count: 20 },
        context as unknown as Parameters<
          typeof model.methods.get_processes.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "processes");

      const data = resources[0].data as {
        processes: Array<{
          user: string;
          pid: number;
          cpu: number;
          mem: number;
          command: string;
        }>;
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.processes[0].user, "root");
      assertEquals(data.processes[0].pid, 1);
      assertEquals(data.processes[0].cpu, 2.5);
      assertEquals(data.processes[0].mem, 0.1);
      assertEquals(data.processes[0].command, "/sbin/init splash");
      assertEquals(data.processes[1].user, "www-data");
      assertEquals(data.processes[1].pid, 1234);
      assertEquals(
        data.processes[1].command,
        "/usr/sbin/apache2 -k start",
      );
    },
  );
});

Deno.test(
  "system model: get_network_interfaces parses ip json output",
  async () => {
    const ipJsonOutput = JSON.stringify([
      {
        ifindex: 1,
        ifname: "lo",
        flags: ["LOOPBACK", "UP"],
        mtu: 65536,
        addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }],
      },
      {
        ifindex: 2,
        ifname: "eth0",
        flags: ["BROADCAST", "MULTICAST", "UP"],
        mtu: 1500,
        addr_info: [
          { family: "inet", local: "192.168.1.100", prefixlen: 24 },
        ],
      },
    ]);

    await withMockedCommand(
      (_cmd, _args) => ({ stdout: ipJsonOutput, success: true }),
      async () => {
        const { context, getWrittenResources } = createModelTestContext({
          globalArgs: {},
          definition: { id: "test-id", name: "sys", version: 1, tags: {} },
        });

        const result = await model.methods.get_network_interfaces.execute(
          {},
          context as unknown as Parameters<
            typeof model.methods.get_network_interfaces.execute
          >[1],
        );

        assertEquals(result.dataHandles.length, 1);
        const resources = getWrittenResources();
        assertEquals(resources.length, 1);
        assertEquals(resources[0].specName, "network_interfaces");

        const data = resources[0].data as {
          interfaces: Array<Record<string, unknown>>;
          count: number;
        };
        assertEquals(data.count, 2);
        assertEquals(data.interfaces[0].ifname, "lo");
        assertEquals(data.interfaces[1].ifname, "eth0");
      },
    );
  },
);

// =============================================================================
// Argument Schema Tests
// =============================================================================

Deno.test("system model: get_disk_usage takes no arguments", () => {
  const result = model.methods.get_disk_usage.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("system model: get_processes count defaults to 20", () => {
  const result = model.methods.get_processes.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.count, 20);
  }
});

Deno.test("system model: get_processes accepts custom count", () => {
  const result = model.methods.get_processes.arguments.safeParse({ count: 5 });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.count, 5);
  }
});

Deno.test("system model: globalArguments accepts empty object", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, true);
});

// =============================================================================
// Resource Schema Validation Tests
// =============================================================================

Deno.test("system model: disk_usage schema validates", () => {
  const result = model.resources.disk_usage.schema.safeParse({
    filesystems: [{
      source: "/dev/sda1",
      fstype: "ext4",
      size: "50G",
      used: "20G",
      avail: "28G",
      usePercent: "42%",
      target: "/",
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("system model: memory schema validates", () => {
  const result = model.resources.memory.schema.safeParse({
    mem: {
      total: "16Gi",
      used: "4Gi",
      free: "8Gi",
      shared: "512Mi",
      cache: "4Gi",
      available: "12Gi",
    },
    swap: { total: "8Gi", used: "100Mi", free: "7.9Gi" },
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("system model: uptime schema validates", () => {
  const result = model.resources.uptime.schema.safeParse({
    bootTime: "2026-04-01 00:00:00",
    uptimeString: "up 12 days",
    loadAverage1m: "0.50",
    loadAverage5m: "0.30",
    loadAverage15m: "0.20",
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// More Execution Tests
// =============================================================================

Deno.test("system model: command failure throws error", async () => {
  await withMockedCommand(
    (_cmd, _args) => ({ stdout: "", success: false }),
    async () => {
      const { context } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      let threw = false;
      try {
        await model.methods.get_disk_usage.execute(
          {},
          context as unknown as Parameters<
            typeof model.methods.get_disk_usage.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("failed"),
          true,
          "Error message should mention failure",
        );
      }
      assertEquals(threw, true, "Should have thrown an error");
    },
  );
});

Deno.test("system model: spawn failure names the command that could not run", async () => {
  await withMockedCommand(
    (_cmd, _args) => {
      throw new Deno.errors.NotFound("No such file or directory (os error 2)");
    },
    async () => {
      const { context } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const err = await assertRejects(
        () =>
          model.methods.get_disk_usage.execute(
            {},
            context as unknown as Parameters<
              typeof model.methods.get_disk_usage.execute
            >[1],
          ),
        Error,
      );
      assertStringIncludes(err.message, "df");
      assertStringIncludes(err.message, "No such file or directory");
    },
  );
});

Deno.test("system model: get_network_interfaces surfaces malformed JSON with context", async () => {
  await withMockedCommand(
    (_cmd, _args) => ({ stdout: "not-json{{{", success: true }),
    async () => {
      const { context } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const err = await assertRejects(
        () =>
          model.methods.get_network_interfaces.execute(
            {},
            context as unknown as Parameters<
              typeof model.methods.get_network_interfaces.execute
            >[1],
          ),
        Error,
      );
      assertStringIncludes(err.message, "ip -j addr show");
    },
  );
});

Deno.test("system model: get_os_info parses uname output", async () => {
  const unameOutput =
    "Linux testhost 6.6.87-generic #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux";

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: unameOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.get_os_info.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.get_os_info.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "os_info");

      const data = resources[0].data as {
        osRelease: Record<string, string>;
        uname: string;
      };
      assertEquals(data.uname, unameOutput);
      // osRelease is read from real /etc/os-release — just verify it exists
      assertExists(data.osRelease);
    },
  );
});

// =============================================================================
// list_services Tests
// =============================================================================

Deno.test("system model: list_services parses systemctl output", async () => {
  const systemctlOutput = [
    "sshd.service loaded active running OpenBSD Secure Shell server",
    "nginx.service loaded active running A high performance web server",
    "docker.service loaded active running Docker Application Container Engine",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: systemctlOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.list_services.execute(
        { state: "active", type: "service" },
        context as unknown as Parameters<
          typeof model.methods.list_services.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "services");

      const data = resources[0].data as {
        services: Array<{
          unit: string;
          load: string;
          active: string;
          sub: string;
          description: string;
        }>;
        count: number;
        stateFilter: string | null;
      };
      assertEquals(data.count, 3);
      assertEquals(data.stateFilter, "active");
      assertEquals(data.services[0].unit, "sshd.service");
      assertEquals(data.services[0].load, "loaded");
      assertEquals(data.services[0].active, "active");
      assertEquals(data.services[0].sub, "running");
      assertEquals(
        data.services[0].description,
        "OpenBSD Secure Shell server",
      );
      assertEquals(data.services[2].unit, "docker.service");
    },
  );
});

Deno.test("system model: list_services state=all sets stateFilter to null", async () => {
  await withMockedCommand(
    (_cmd, _args) => ({
      stdout: "foo.service loaded active running Foo",
      success: true,
    }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      await model.methods.list_services.execute(
        { state: "all", type: "all" },
        context as unknown as Parameters<
          typeof model.methods.list_services.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as { stateFilter: string | null };
      assertEquals(data.stateFilter, null);
    },
  );
});

Deno.test("system model: list_services argument defaults", () => {
  const result = model.methods.list_services.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.state, "all");
    assertEquals(result.data.type, "service");
  }
});

// =============================================================================
// list_ports Tests
// =============================================================================

Deno.test("system model: list_ports parses ss output", async () => {
  const ssOutput = [
    "State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process",
    'LISTEN 0      128     0.0.0.0:22           0.0.0.0:*         users:(("sshd",pid=1234,fd=3))',
    'LISTEN 0      511     127.0.0.1:6379       0.0.0.0:*         users:(("redis-server",pid=5678,fd=6))',
    'LISTEN 0      4096    *:8080               *:*               users:(("node",pid=9012,fd=18))',
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: ssOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.list_ports.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_ports.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "listening_ports");

      const data = resources[0].data as {
        ports: Array<{
          protocol: string;
          localAddress: string;
          port: number;
          process: string | null;
          pid: number | null;
        }>;
        count: number;
      };
      assertEquals(data.count, 3);
      assertEquals(data.ports[0].port, 22);
      assertEquals(data.ports[0].process, "sshd");
      assertEquals(data.ports[0].pid, 1234);
      assertEquals(data.ports[0].localAddress, "0.0.0.0");
      assertEquals(data.ports[1].port, 6379);
      assertEquals(data.ports[1].process, "redis-server");
      assertEquals(data.ports[1].pid, 5678);
      assertEquals(data.ports[1].localAddress, "127.0.0.1");
      assertEquals(data.ports[2].port, 8080);
      assertEquals(data.ports[2].process, "node");
      assertEquals(data.ports[2].pid, 9012);
    },
  );
});

Deno.test("system model: list_ports handles entries without process info", async () => {
  const ssOutput = [
    "State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process",
    "LISTEN 0      128     0.0.0.0:443          0.0.0.0:*",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: ssOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      await model.methods.list_ports.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_ports.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        ports: Array<{
          port: number;
          process: string | null;
          pid: number | null;
        }>;
      };
      assertEquals(data.ports[0].port, 443);
      assertEquals(data.ports[0].process, null);
      assertEquals(data.ports[0].pid, null);
    },
  );
});

// =============================================================================
// search_processes Tests
// =============================================================================

Deno.test("system model: search_processes filters by name", async () => {
  const psOutput = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "root         1  0.1  0.1 169328 13296 ?        Ss   Apr10   1:23 /sbin/init",
    "www-data  1234  1.2  3.4 567890 12345 ?        Sl   Apr10   0:45 /usr/sbin/nginx -g daemon off",
    "postgres  5678  0.5  2.0 345678 67890 ?        Ss   Apr10   0:12 /usr/lib/postgresql/16/bin/postgres",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: psOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      const result = await model.methods.search_processes.execute(
        { name: "nginx", limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.search_processes.execute
        >[1],
      );

      assertEquals(result.dataHandles.length, 1);
      const resources = getWrittenResources();
      const data = resources[0].data as {
        processes: Array<{ command: string; pid: number }>;
        count: number;
        filters: {
          name: string | null;
          minCpu: number | null;
          minMem: number | null;
        };
      };
      assertEquals(data.count, 1);
      assertEquals(data.processes[0].pid, 1234);
      assertStringIncludes(data.processes[0].command, "nginx");
      assertEquals(data.filters.name, "nginx");
    },
  );
});

Deno.test("system model: search_processes filters by minCpu", async () => {
  const psOutput = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "root         1  0.1  0.1 169328 13296 ?        Ss   Apr10   1:23 /sbin/init",
    "www-data  1234  5.2  3.4 567890 12345 ?        Sl   Apr10   0:45 /usr/sbin/nginx",
    "node      5678  8.0  4.0 345678 67890 ?        Sl   Apr10   0:12 /usr/bin/node app.js",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: psOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      await model.methods.search_processes.execute(
        { minCpu: 5.0, limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.search_processes.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        processes: Array<{ cpu: number; pid: number }>;
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.processes[0].pid, 1234);
      assertEquals(data.processes[0].cpu, 5.2);
      assertEquals(data.processes[1].pid, 5678);
      assertEquals(data.processes[1].cpu, 8.0);
    },
  );
});

Deno.test("system model: search_processes filters by minMem", async () => {
  const psOutput = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
    "root         1  0.1  0.1 169328 13296 ?        Ss   Apr10   1:23 /sbin/init",
    "java      2345  2.0 15.0 2345678 456789 ?      Sl   Apr10   5:00 /usr/bin/java -jar app.jar",
  ].join("\n");

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: psOutput, success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      await model.methods.search_processes.execute(
        { minMem: 10.0, limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.search_processes.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        processes: Array<{ mem: number; pid: number }>;
        count: number;
      };
      assertEquals(data.count, 1);
      assertEquals(data.processes[0].pid, 2345);
      assertEquals(data.processes[0].mem, 15.0);
    },
  );
});

Deno.test("system model: search_processes respects limit", async () => {
  const psLines = [
    "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
  ];
  for (let i = 1; i <= 10; i++) {
    psLines.push(
      `user     ${i}  ${i}.0  1.0 100000 10000 ?        S    Apr10   0:01 /proc${i}`,
    );
  }

  await withMockedCommand(
    (_cmd, _args) => ({ stdout: psLines.join("\n"), success: true }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        definition: { id: "test-id", name: "sys", version: 1, tags: {} },
      });

      await model.methods.search_processes.execute(
        { limit: 3 },
        context as unknown as Parameters<
          typeof model.methods.search_processes.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        processes: Array<{ pid: number }>;
        count: number;
      };
      assertEquals(data.count, 3);
    },
  );
});

Deno.test("system model: search_processes argument defaults", () => {
  const result = model.methods.search_processes.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.limit, 50);
    assertEquals(result.data.name, undefined);
    assertEquals(result.data.minCpu, undefined);
    assertEquals(result.data.minMem, undefined);
  }
});

// =============================================================================
// New Resource Schema Validation Tests
// =============================================================================

Deno.test("system model: services schema validates", () => {
  const result = model.resources.services.schema.safeParse({
    services: [{
      unit: "sshd.service",
      load: "loaded",
      active: "active",
      sub: "running",
      description: "OpenBSD Secure Shell server",
    }],
    count: 1,
    stateFilter: "active",
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("system model: listening_ports schema validates", () => {
  const result = model.resources.listening_ports.schema.safeParse({
    ports: [{
      protocol: "tcp",
      localAddress: "0.0.0.0",
      port: 22,
      process: "sshd",
      pid: 1234,
    }],
    count: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("system model: search_results schema validates", () => {
  const result = model.resources.search_results.schema.safeParse({
    processes: [{
      user: "root",
      pid: 1,
      cpu: 2.5,
      mem: 0.1,
      command: "/sbin/init",
    }],
    count: 1,
    filters: { name: "init", minCpu: null, minMem: null },
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(result.success, true);
});
