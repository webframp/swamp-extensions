/**
 * System diagnostics model for swamp.
 *
 * Queries local host health through standard Unix shell commands --
 * disk usage, memory, processes, uptime, network interfaces, and OS info.
 *
 * @module
 */

// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const EXTENSION_NAME = "@webframp/system";

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
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const UptimeSchema = z.object({
  bootTime: z.string(),
  uptimeString: z.string(),
  loadAverage1m: z.string(),
  loadAverage5m: z.string(),
  loadAverage15m: z.string(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const NetworkInterfacesSchema = z.object({
  interfaces: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const OsInfoSchema = z.object({
  osRelease: z.record(z.string(), z.string()),
  uname: z.string(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const ServiceEntrySchema = z.object({
  unit: z.string(),
  load: z.string(),
  active: z.string(),
  sub: z.string(),
  description: z.string(),
});

const ServiceListSchema = z.object({
  services: z.array(ServiceEntrySchema),
  count: z.number(),
  stateFilter: z.string().nullable(),
  typeFilter: z.string().nullable(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const ListeningPortSchema = z.object({
  protocol: z.string(),
  localAddress: z.string(),
  port: z.number(),
  process: z.string().nullable(),
  pid: z.number().nullable(),
});

const ListeningPortsSchema = z.object({
  ports: z.array(ListeningPortSchema),
  count: z.number(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const SearchProcessesSchema = z.object({
  processes: z.array(ProcessSchema),
  count: z.number(),
  truncated: z.boolean(),
  filters: z.object({
    name: z.string().nullable(),
    minCpu: z.number().nullable(),
    minMem: z.number().nullable(),
  }),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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

/** Execute a shell command and return its trimmed stdout, or throw on failure. */
async function runCommand(
  cmd: string[],
): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  let output: Deno.CommandOutput;
  try {
    output = await command.output();
  } catch (cause) {
    // The binary itself couldn't be spawned (e.g. not installed, not on
    // PATH, or not executable) — this is distinct from the command running
    // and exiting non-zero, and the raw OS error alone doesn't say which
    // command swamp was trying to run.
    throw new Error(
      `Failed to execute command "${cmd.join(" ")}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(
      `Command "${cmd.join(" ")}" exited with code ${output.code}: ${stderr}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

// =============================================================================
// Model Definition
// =============================================================================

/** System diagnostics model -- exposes methods for querying disk, memory, processes, uptime, network, and OS info. */
export const model = {
  type: "@webframp/system",
  version: "2026.08.26.1",
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description:
        "Tighten get_processes count to a positive integer — no behavioral change for valid inputs",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "No schema changes — command execution failures now name the failing command",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      description: "No schema changes — version bump for republish",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.3",
      description: "No schema changes — add missing upgrade description fields",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.4",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.5",
      description:
        "Added list_services, list_ports, and search_processes methods with " +
        "new services, listening_ports, and search_results resource specs",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    services: {
      description: "Systemd service units and their states",
      schema: ServiceListSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    listening_ports: {
      description: "TCP ports in LISTEN state with owning processes",
      schema: ListeningPortsSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
    },
    search_results: {
      description: "Filtered process search results",
      schema: SearchProcessesSchema,
      lifetime: "5m" as const,
      garbageCollection: 5,
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
        const startMs = Date.now();
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
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
        const startMs = Date.now();
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
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
        const startMs = Date.now();
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
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
          .int()
          .min(1)
          .default(20)
          .describe("Number of top processes to return"),
      }),
      execute: async (
        args: { count: number },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
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
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
        const startMs = Date.now();
        const raw = await runCommand(["ip", "-j", "addr", "show"]);
        let interfaces: Record<string, unknown>[];
        try {
          interfaces = JSON.parse(raw) as Record<string, unknown>[];
        } catch (cause) {
          throw new Error(
            `Failed to parse "ip -j addr show" output as JSON: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          );
        }

        const handle = await context.writeResource(
          "network_interfaces",
          "current",
          {
            interfaces,
            count: interfaces.length,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
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
        const startMs = Date.now();
        // Parse /etc/os-release into key-value pairs
        let osReleaseText: string;
        try {
          osReleaseText = await Deno.readTextFile("/etc/os-release");
        } catch (cause) {
          // /etc/os-release is absent on some minimal/non-Linux hosts —
          // that's tolerated, but silently continuing with no record of why
          // hides genuine problems (e.g. permission denied). Log it.
          osReleaseText = "";
          context.logger.info(
            "Could not read /etc/os-release, continuing with empty osRelease: {reason}",
            {
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          );
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
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        context.logger.info("OS: {name}, Kernel: {kernel}", {
          name: osRelease["PRETTY_NAME"] || "unknown",
          kernel: uname,
        });
        return { dataHandles: [handle] };
      },
    },

    list_services: {
      description:
        "List systemd service units, optionally filtered by active state",
      arguments: z.object({
        state: z
          .enum(["active", "inactive", "failed", "all"])
          .default("all")
          .describe("Filter by service active state"),
        type: z
          .enum(["service", "timer", "socket", "mount", "all"])
          .default("service")
          .describe("Unit type to list"),
      }),
      execute: async (
        args: { state: string; type: string },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const cmdArgs = [
          "systemctl",
          "list-units",
          "--no-pager",
          "--no-legend",
          "--plain",
        ];
        if (args.type !== "all") {
          cmdArgs.push(`--type=${args.type}`);
        }
        if (args.state !== "all") {
          cmdArgs.push(`--state=${args.state}`);
        }

        const raw = await runCommand(cmdArgs);
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);

        const services = lines.map((line) => {
          const parts = line.trim().split(/\s+/);
          return {
            unit: parts[0] || "",
            load: parts[1] || "",
            active: parts[2] || "",
            sub: parts[3] || "",
            description: parts.slice(4).join(" ") || "",
          };
        });

        const handle = await context.writeResource("services", "current", {
          services,
          count: services.length,
          stateFilter: args.state === "all" ? null : args.state,
          typeFilter: args.type === "all" ? null : args.type,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        context.logger.info(
          "Found {count} units (state={state}, type={type})",
          {
            count: services.length,
            state: args.state,
            type: args.type,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    list_ports: {
      description:
        "List TCP ports in LISTEN state with their owning processes via ss",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const raw = await runCommand(["ss", "-tlnp"]);
        const lines = raw.split("\n").slice(1); // skip header

        const ports = lines
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            // ss -tlnp output columns: State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
            const localAddr = parts[3] || "";
            const lastColon = localAddr.lastIndexOf(":");
            const address = lastColon >= 0
              ? localAddr.slice(0, lastColon)
              : localAddr;
            const port = lastColon >= 0
              ? parseInt(localAddr.slice(lastColon + 1), 10)
              : 0;

            // Process info is in the last column, format: users:(("name",pid=N,...))
            const processCol = parts.slice(5).join(" ");
            const procMatch = processCol.match(
              /\(\("([^"]+)",pid=(\d+)/,
            );
            const process = procMatch ? procMatch[1] : null;
            const pid = procMatch ? parseInt(procMatch[2], 10) : null;

            return {
              protocol: "tcp",
              localAddress: address,
              port,
              process,
              pid,
            };
          })
          .filter((entry) => entry.port > 0);

        const handle = await context.writeResource(
          "listening_ports",
          "current",
          {
            ports,
            count: ports.length,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        context.logger.info("Found {count} listening TCP ports", {
          count: ports.length,
        });
        return { dataHandles: [handle] };
      },
    },

    search_processes: {
      description:
        "Search running processes by name pattern and/or CPU/memory thresholds",
      arguments: z.object({
        name: z
          .string()
          .optional()
          .describe(
            "Substring to match against the command column (case-insensitive)",
          ),
        minCpu: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum %CPU threshold to include"),
        minMem: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum %MEM threshold to include"),
        limit: z
          .number()
          .int()
          .min(1)
          .default(50)
          .describe("Maximum number of results to return"),
      }),
      execute: async (
        args: {
          name?: string;
          minCpu?: number;
          minMem?: number;
          limit: number;
        },
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const raw = await runCommand(["ps", "aux", "--sort=-%cpu"]);
        const lines = raw.split("\n").slice(1); // skip header

        const namePattern = args.name?.toLowerCase();

        const filtered = lines
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return {
              user: parts[0] || "",
              pid: parseInt(parts[1] || "0", 10),
              cpu: parseFloat(parts[2] || "0"),
              mem: parseFloat(parts[3] || "0"),
              command: parts.slice(10).join(" ") || "",
            };
          })
          .filter((proc) => {
            if (
              namePattern && !proc.command.toLowerCase().includes(namePattern)
            ) {
              return false;
            }
            if (args.minCpu !== undefined && proc.cpu < args.minCpu) {
              return false;
            }
            if (args.minMem !== undefined && proc.mem < args.minMem) {
              return false;
            }
            return true;
          });

        const truncated = filtered.length > args.limit;
        const processes = filtered.slice(0, args.limit);

        const handle = await context.writeResource(
          "search_results",
          "current",
          {
            processes,
            count: processes.length,
            truncated,
            filters: {
              name: args.name ?? null,
              minCpu: args.minCpu ?? null,
              minMem: args.minMem ?? null,
            },
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        context.logger.info("search_processes matched {count} processes", {
          count: processes.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
