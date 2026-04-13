// System Diagnostics Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists } from "jsr:@std/assert@1";
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

Deno.test("system model: has all 6 resource specs", () => {
  assertExists(model.resources.disk_usage);
  assertExists(model.resources.memory);
  assertExists(model.resources.network_interfaces);
  assertExists(model.resources.os_info);
  assertExists(model.resources.processes);
  assertExists(model.resources.uptime);
});

Deno.test("system model: has all 6 methods", () => {
  assertExists(model.methods.get_disk_usage);
  assertExists(model.methods.get_memory);
  assertExists(model.methods.get_network_interfaces);
  assertExists(model.methods.get_os_info);
  assertExists(model.methods.get_processes);
  assertExists(model.methods.get_uptime);
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
