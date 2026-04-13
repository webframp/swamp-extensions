// System Diagnostics Operations Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({});

const FilesystemEntrySchema = z.object({
  source: z.string(),
  fstype: z.string(),
  size: z.string(),
  used: z.string(),
  avail: z.string(),
  usePercent: z.string(),
  target: z.string(),
});

const DiskUsageSchema = z.object({
  filesystems: z.array(FilesystemEntrySchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const MemoryRowSchema = z.object({
  total: z.string(),
  used: z.string(),
  free: z.string(),
  shared: z.string(),
  cache: z.string(),
  available: z.string(),
});

const MemorySchema = z.object({
  mem: MemoryRowSchema,
  swap: z.object({
    total: z.string(),
    used: z.string(),
    free: z.string(),
  }),
  fetchedAt: z.string(),
});

const UptimeSchema = z.object({
  bootTime: z.string(),
  uptimeString: z.string(),
  loadAverage1m: z.string(),
  loadAverage5m: z.string(),
  loadAverage15m: z.string(),
  fetchedAt: z.string(),
});

const ProcessSchema = z.object({
  user: z.string(),
  pid: z.number(),
  cpu: z.number(),
  mem: z.number(),
  command: z.string(),
});

const ProcessListSchema = z.object({
  processes: z.array(ProcessSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const NetworkInterfacesSchema = z.object({
  interfaces: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  fetchedAt: z.string(),
});

const OsInfoSchema = z.object({
  osRelease: z.record(z.string(), z.string()),
  uname: z.string(),
  fetchedAt: z.string(),
});

// =============================================================================
// Context Type
// =============================================================================

type MethodContext = {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Helper Functions
// =============================================================================

async function runCommand(
  cmd: string[],
): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`Command failed: ${cmd.join(" ")}: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/system",
  version: "2026.04.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    disk_usage: {
      description: "Filesystem disk usage",
      schema: DiskUsageSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    memory: {
      description: "Memory and swap usage",
      schema: MemorySchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    uptime: {
      description: "System uptime and load averages",
      schema: UptimeSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    processes: {
      description: "Top processes by CPU usage",
      schema: ProcessListSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    network_interfaces: {
      description: "Network interfaces and addresses",
      schema: NetworkInterfacesSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    os_info: {
      description: "Operating system information",
      schema: OsInfoSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    get_disk_usage: {
      description: "Get filesystem disk usage from df",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const raw = await runCommand([
          "df",
          "-h",
          "--output=source,fstype,size,used,avail,pcent,target",
        ]);

        const lines = raw.split("\n").slice(1); // skip header
        const filesystems = lines
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return {
              source: parts[0] || "",
              fstype: parts[1] || "",
              size: parts[2] || "",
              used: parts[3] || "",
              avail: parts[4] || "",
              usePercent: parts[5] || "",
              target: parts.slice(6).join(" ") || "",
            };
          });

        const handle = await context.writeResource("disk_usage", "current", {
          filesystems,
          count: filesystems.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} filesystems", {
          count: filesystems.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_memory: {
      description: "Get memory and swap usage from free",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const raw = await runCommand(["free", "-h"]);
        const lines = raw.split("\n");

        // Parse "Mem:" line
        const memLine = lines.find((l) => l.startsWith("Mem:"));
        const memParts = memLine?.trim().split(/\s+/) || [];
        const mem = {
          total: memParts[1] || "",
          used: memParts[2] || "",
          free: memParts[3] || "",
          shared: memParts[4] || "",
          cache: memParts[5] || "",
          available: memParts[6] || "",
        };

        // Parse "Swap:" line
        const swapLine = lines.find((l) => l.startsWith("Swap:"));
        const swapParts = swapLine?.trim().split(/\s+/) || [];
        const swap = {
          total: swapParts[1] || "",
          used: swapParts[2] || "",
          free: swapParts[3] || "",
        };

        const handle = await context.writeResource("memory", "current", {
          mem,
          swap,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Memory: {total} total, {used} used", {
          total: mem.total,
          used: mem.used,
        });
        return { dataHandles: [handle] };
      },
    },

    get_uptime: {
      description: "Get system boot time, uptime string, and load averages",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const bootTime = await runCommand(["uptime", "-s"]);
        const uptimeRaw = await runCommand(["uptime"]);

        // Parse load averages from uptime output
        // Format: "... load average: 0.00, 0.01, 0.05"
        const loadMatch = uptimeRaw.match(
          /load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/,
        );

        const handle = await context.writeResource("uptime", "current", {
          bootTime,
          uptimeString: uptimeRaw,
          loadAverage1m: loadMatch?.[1] || "",
          loadAverage5m: loadMatch?.[2] || "",
          loadAverage15m: loadMatch?.[3] || "",
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Boot time: {bootTime}, load: {load1m}", {
          bootTime,
          load1m: loadMatch?.[1] || "unknown",
        });
        return { dataHandles: [handle] };
      },
    },

    get_processes: {
      description: "Get top 20 processes sorted by CPU usage",
      arguments: z.object({
        count: z
          .number()
          .default(20)
          .describe("Number of top processes to return"),
      }),
      execute: async (
        args: { count: number },
        context: MethodContext,
      ) => {
        const raw = await runCommand(["ps", "aux", "--sort=-%cpu"]);
        const lines = raw.split("\n").slice(1); // skip header

        const processes = lines
          .filter((line) => line.trim().length > 0)
          .slice(0, args.count)
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return {
              user: parts[0] || "",
              pid: parseInt(parts[1] || "0", 10),
              cpu: parseFloat(parts[2] || "0"),
              mem: parseFloat(parts[3] || "0"),
              command: parts.slice(10).join(" ") || "",
            };
          });

        const handle = await context.writeResource("processes", "current", {
          processes,
          count: processes.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Captured top {count} processes", {
          count: processes.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_network_interfaces: {
      description: "Get network interfaces and addresses via ip",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const raw = await runCommand(["ip", "-j", "addr", "show"]);
        const interfaces = JSON.parse(raw) as Record<string, unknown>[];

        const handle = await context.writeResource(
          "network_interfaces",
          "current",
          {
            interfaces,
            count: interfaces.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} network interfaces", {
          count: interfaces.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_os_info: {
      description: "Get OS release information and kernel version",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        // Parse /etc/os-release into key-value pairs
        let osReleaseText: string;
        try {
          osReleaseText = await Deno.readTextFile("/etc/os-release");
        } catch {
          osReleaseText = "";
        }

        const osRelease: Record<string, string> = {};
        for (const line of osReleaseText.split("\n")) {
          const match = line.match(/^([A-Z_]+)=(.*)$/);
          if (match) {
            // Strip surrounding quotes if present
            osRelease[match[1]] = match[2].replace(/^["']|["']$/g, "");
          }
        }

        const uname = await runCommand(["uname", "-a"]);

        const handle = await context.writeResource("os_info", "current", {
          osRelease,
          uname,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("OS: {name}, Kernel: {kernel}", {
          name: osRelease["PRETTY_NAME"] || "unknown",
          kernel: uname,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
