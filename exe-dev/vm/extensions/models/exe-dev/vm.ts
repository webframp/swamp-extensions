/**
 * exe.dev VM lifecycle model.
 *
 * Wraps the exe.dev HTTPS API (POST https://exe.dev/exec) to manage VMs as
 * typed swamp resources. The API mirrors the SSH CLI 1:1 — every command sent
 * over SSH works identically as a POST body. Auth uses a bearer token generated
 * via `ssh exe.dev ssh-key generate-api-key`.
 *
 * ## Bootstrap
 *
 * Run the `setup` method first. It generates a token with the full set of
 * commands this model needs (ls, new, rm, restart, resize, tag, stat, whoami,
 * comment) and stores it in the configured vault. Without setup, methods that
 * require commands beyond the exe.dev default token permissions will fail with
 * a 403 and an actionable error message explaining which command is missing and
 * how to fix it.
 *
 * ## Methods
 *
 * - setup — generate and vault a fully-permissioned API token
 * - sync — adopt/observe all VMs as versioned fleet data
 * - create, destroy, restart, resize, stat, tag — VM lifecycle
 * - exec — run a shell command on a VM via SSH
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  token: z.string().min(1).describe(
    "exe.dev API bearer token (use vault reference). Generate with: ssh exe.dev ssh-key generate-api-key --exp=30d",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SharingSchema = z.object({
  group: z.string(),
  publicProxy: z.boolean(),
  teamShared: z.boolean(),
  teamAccess: z.boolean(),
  namedUserCount: z.number(),
  shareLinkCount: z.number(),
});

const VmSchema = z.object({
  vmName: z.string(),
  httpsUrl: z.string(),
  sshDest: z.string(),
  sshHost: z.string(),
  sshUser: z.string().optional(),
  region: z.string(),
  regionDisplay: z.string(),
  status: z.string(),
  image: z.string().optional(),
  allocatedCpus: z.number().optional(),
  memoryGb: z.number().optional(),
  diskGb: z.number().optional(),
  proxyPort: z.number().optional(),
  proxyShare: z.string().optional(),
  sharing: SharingSchema.optional(),
  tags: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  comment: z.string().optional(),
  emoji: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastActiveAt: z.string().optional(),
  emailReceiveEnabled: z.boolean().optional(),
  shelleyUrl: z.string().optional(),
  terminalUrl: z.string().optional(),
});

const FleetSchema = z.object({
  fetchedAt: z.string(),
  vms: z.array(VmSchema),
  count: z.number(),
});

const VmDetailSchema = VmSchema;

const StatSchema = z.object({
  vmName: z.string(),
  fetchedAt: z.string(),
  range: z.string(),
  metrics: z.unknown(),
});

const ExecResultSchema = z.object({
  vmName: z.string(),
  command: z.string(),
  executedAt: z.string(),
  output: z.string(),
  exitCode: z.number(),
});

const ShelleyVersionSchema = z.object({
  vmName: z.string(),
  version: z.string().nullable(),
  error: z.string().optional(),
});

const ShelleyVersionsSchema = z.object({
  fetchedAt: z.string(),
  vms: z.array(ShelleyVersionSchema),
  count: z.number(),
  outdatedCount: z.number(),
  latestObserved: z.string().nullable(),
});

const ShelleyUpgradeResultSchema = z.object({
  vmName: z.string(),
  previousVersion: z.string().nullable(),
  upgraded: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
});

// =============================================================================
// Helpers
// =============================================================================

/** Commands this model requires for full operation. Used by setup and 403 diagnostics. */
const REQUIRED_CMDS = [
  "help",
  "ls",
  "new",
  "rm",
  "restart",
  "resize",
  "tag",
  "stat",
  "whoami",
  "comment",
] as const;

/**
 * Subcommands with spaces that need quoting in --cmds. These are appended
 * separately in the setup method with proper quoting.
 */
const REQUIRED_SUBCOMMANDS = [
  "shelley install",
  "share show",
  "share set-public",
  "share set-private",
  "share add",
  "share remove",
  "share add-link",
  "share remove-link",
] as const;

interface ExeApiResponse {
  ok: boolean;
  status: number;
  body: string;
}

/** Escape embedded double-quotes in a value before interpolation into a quoted command string. */
export function escapeQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the `new` command string from create arguments. */
export function buildCreateCmd(args: {
  name?: string;
  image?: string;
  cpu?: number;
  memory?: string;
  disk?: string;
  comment?: string;
  tags?: string[];
  setupScript?: string;
  env?: Record<string, string>;
  integrations?: string[];
}): string {
  const parts: string[] = ["new --json"];
  if (args.name) parts.push(`--name=${args.name}`);
  if (args.image) parts.push(`--image=${args.image}`);
  if (args.cpu) parts.push(`--cpu=${args.cpu}`);
  if (args.memory) parts.push(`--memory=${args.memory}`);
  if (args.disk) parts.push(`--disk=${args.disk}`);
  if (args.comment) {
    parts.push(`--comment="${escapeQuotes(args.comment)}"`);
  }
  if (args.tags?.length) {
    parts.push(`--tag=${args.tags.join(",")}`);
  }
  if (args.setupScript) {
    parts.push(`--setup-script="${escapeQuotes(args.setupScript)}"`);
  }
  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) {
      parts.push(`--env ${k}="${escapeQuotes(v)}"`);
    }
  }
  if (args.integrations?.length) {
    parts.push(`--integration=${args.integrations.join(",")}`);
  }
  return parts.join(" ");
}

/** Build the `resize` command string. */
export function buildResizeCmd(args: {
  name: string;
  cpu?: number;
  memory?: string;
  disk?: string;
}): string {
  const parts: string[] = [`resize ${args.name} --json`];
  if (args.cpu) parts.push(`--cpu=${args.cpu}`);
  if (args.memory) parts.push(`--memory=${args.memory}`);
  if (args.disk) parts.push(`--disk=${args.disk}`);
  return parts.join(" ");
}

/** Build the `comment` command string. */
export function buildCommentCmd(name: string, text: string): string {
  return text
    ? `comment --json ${name} "${escapeQuotes(text)}"`
    : `comment --json ${name} ""`;
}

/** Build the `tag` command string (add or remove). */
export function buildTagCmd(
  name: string,
  tags: string[],
  remove: boolean,
): string {
  const quotedTags = tags.map((t) => `"${escapeQuotes(t)}"`).join(" ");
  return remove
    ? `tag --json -d ${name} ${quotedTags}`
    : `tag --json ${name} ${quotedTags}`;
}

async function exeApi(token: string, command: string): Promise<ExeApiResponse> {
  const resp = await fetch("https://exe.dev/exec", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: command,
  });
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}

/**
 * Parse a successful JSON response. On 403, produces an actionable error that
 * names the denied command and tells the caller how to fix it (run setup or
 * regenerate the token with the correct --cmds).
 */
function parseJsonResponse<T>(resp: ExeApiResponse, command?: string): T {
  if (resp.status === 403) {
    const baseCmd = (command ?? "unknown").split(" ")[0];
    const allCmds = [...REQUIRED_CMDS, ...REQUIRED_SUBCOMMANDS];
    throw new Error(
      `exe.dev API returned 403 (command not allowed): "${baseCmd}" is not ` +
        `permitted by the current token. Fix: run the "setup" method to ` +
        `generate a token with full permissions, or manually regenerate with:\n` +
        `  ssh exe.dev ssh-key generate-api-key --exp=30d ` +
        `--cmds=${allCmds.join(",")}`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `exe.dev API error (HTTP ${resp.status}): ${resp.body}`,
    );
  }
  return JSON.parse(resp.body) as T;
}

/** Map the raw `ls -l --json` keys (snake_case) to our schema (camelCase). */
export interface RawVm {
  vm_name: string;
  https_url: string;
  ssh_dest: string;
  ssh_host: string;
  ssh_user?: string;
  region: string;
  region_display: string;
  status: string;
  image?: string;
  allocated_cpus?: number;
  memory_capacity_bytes?: number;
  disk_capacity_bytes?: number;
  proxy_port?: number;
  proxy_share?: string;
  sharing?: {
    group: string;
    public_proxy: boolean;
    team_shared: boolean;
    team_access: boolean;
    named_user_count: number;
    share_link_count: number;
  };
  tags?: string[];
  domains?: string[];
  comment?: string;
  emoji?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  email_receive_enabled?: boolean;
  shelley_url?: string;
  terminal_url?: string;
}

export function mapVm(raw: RawVm): z.infer<typeof VmSchema> {
  return {
    vmName: raw.vm_name,
    httpsUrl: raw.https_url,
    sshDest: raw.ssh_dest,
    sshHost: raw.ssh_host,
    sshUser: raw.ssh_user,
    region: raw.region,
    regionDisplay: raw.region_display,
    status: raw.status,
    image: raw.image,
    allocatedCpus: raw.allocated_cpus,
    memoryGb: raw.memory_capacity_bytes
      ? raw.memory_capacity_bytes / (1024 * 1024 * 1024)
      : undefined,
    diskGb: raw.disk_capacity_bytes
      ? raw.disk_capacity_bytes / (1024 * 1024 * 1024)
      : undefined,
    proxyPort: raw.proxy_port,
    proxyShare: raw.proxy_share,
    sharing: raw.sharing
      ? {
        group: raw.sharing.group,
        publicProxy: raw.sharing.public_proxy,
        teamShared: raw.sharing.team_shared,
        teamAccess: raw.sharing.team_access,
        namedUserCount: raw.sharing.named_user_count,
        shareLinkCount: raw.sharing.share_link_count,
      }
      : undefined,
    tags: raw.tags,
    domains: raw.domains,
    comment: raw.comment,
    emoji: raw.emoji,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    lastActiveAt: raw.last_active_at,
    emailReceiveEnabled: raw.email_receive_enabled,
    shelleyUrl: raw.shelley_url,
    terminalUrl: raw.terminal_url,
  };
}

// =============================================================================
// Model
// =============================================================================

/**
 * exe.dev VM lifecycle model.
 *
 * Manages VM creation, destruction, observation, and fleet-wide operations
 * (Shelley version auditing, upgrades, sharing) through the exe.dev HTTPS API.
 * Authenticates via bearer token stored in a swamp vault.
 */
export const model = {
  type: "@webframp/exe-dev/vm",
  version: "2026.08.04.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    fleet: {
      description:
        "Snapshot of all exe.dev VMs visible to the authenticated account.",
      schema: FleetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    vm: {
      description:
        "Individual VM state after create/restart/resize operations.",
      schema: VmDetailSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    stat: {
      description: "VM resource metrics (CPU, memory, disk, IO).",
      schema: StatSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    exec: {
      description: "Output of a command executed on a VM via SSH.",
      schema: ExecResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    shelleyVersions: {
      description:
        "Shelley/Claude Code version observed on each VM in the fleet.",
      schema: ShelleyVersionsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    shelleyUpgrade: {
      description: "Result of a Shelley upgrade operation per VM.",
      schema: z.object({
        executedAt: z.string(),
        results: z.array(ShelleyUpgradeResultSchema),
        upgradedCount: z.number(),
        failedCount: z.number(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    setup: {
      description:
        "Generate a fully-permissioned exe.dev API token and store it in the " +
        "vault. Requires SSH access to exe.dev (your SSH key must be " +
        "registered). The token covers all commands this model uses: " +
        "ls, new, rm, restart, resize, tag, stat, whoami, and comment. " +
        "Run this once to bootstrap the model, or again to rotate the token. " +
        "After running, ensure your model YAML " +
        'has: token: \'${{ vault.get("<vaultName>", "<secretKey>") }}\'',
      arguments: z.object({
        expiry: z.string().default("30d").describe(
          "Token lifetime (e.g. 7d, 30d, 90d)",
        ),
        vaultName: z.string().default("gitlab").describe(
          "Vault to store the token in",
        ),
        secretKey: z.string().default("exe-dev-api-token").describe(
          "Secret key name within the vault",
        ),
      }),
      execute: async (
        args: { expiry: string; vaultName: string; secretKey: string },
        ctx: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warn: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        // Build --cmds value: simple commands joined by comma, subcommands
        // with spaces wrapped in double quotes
        const quotedSubs = REQUIRED_SUBCOMMANDS.map((s) => `"${s}"`);
        const cmds = [...REQUIRED_CMDS, ...quotedSubs].join(",");

        ctx.logger.info(
          "Generating exe.dev API token with cmds: {cmds} (expiry: {expiry})",
          { cmds, expiry: args.expiry },
        );

        // Generate the token via SSH
        // SSH concatenates positional args after the host into the remote command
        const label = `swamp-${Date.now()}`;
        const sshCmd = new Deno.Command("ssh", {
          args: [
            "exe.dev",
            "ssh-key",
            "generate-api-key",
            `--exp=${args.expiry}`,
            `--cmds=${cmds}`,
            `--label=${label}`,
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const sshResult = await sshCmd.output();
        const sshStdout = new TextDecoder().decode(sshResult.stdout);
        const sshStderr = new TextDecoder().decode(sshResult.stderr);

        if (!sshResult.success) {
          throw new Error(
            `Failed to generate exe.dev API token (exit ${sshResult.code}): ` +
              `${sshStderr || sshStdout}`,
          );
        }

        // Parse the token — exe.dev outputs a token prefixed with "exe" + digit
        const tokenMatch = sshStdout.match(/^\s*(exe\d\.\S+)/m);
        if (!tokenMatch) {
          throw new Error(
            "Could not parse token from ssh output. Raw output:\n" +
              sshStdout,
          );
        }
        const token = tokenMatch[1];

        // Store in vault via swamp CLI
        const vaultCmd = new Deno.Command("swamp", {
          args: [
            "vault",
            "put",
            args.vaultName,
            args.secretKey,
            token,
            "--yes",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const vaultResult = await vaultCmd.output();

        if (!vaultResult.success) {
          const vaultStderr = new TextDecoder().decode(vaultResult.stderr);
          throw new Error(
            `Token generated but failed to store in vault ` +
              `"${args.vaultName}/${args.secretKey}": ${vaultStderr}`,
          );
        }

        ctx.logger.info(
          "Token stored in vault {vault} as {key}. Model config should use: " +
            '${{ vault.get("{vault}", "{key}") }}',
          { vault: args.vaultName, key: args.secretKey, expiry: args.expiry },
        );

        return {};
      },
    },

    sync: {
      description:
        "List all VMs and store as a fleet snapshot. The adopt/observe pattern " +
        "— captures current reality as versioned data.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warn: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const resp = await exeApi(ctx.globalArgs.token, "ls -l --json");
        const raw = parseJsonResponse<{ vms: RawVm[] }>(resp, "ls -l --json");
        const vms = (raw.vms ?? []).map(mapVm);

        ctx.logger.info("exe.dev sync: {count} VMs observed", {
          count: vms.length,
        });

        const handle = await ctx.writeResource("fleet", "all", {
          fetchedAt: new Date().toISOString(),
          vms,
          count: vms.length,
        });
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Provision a new exe.dev VM. Returns the created VM details.",
      arguments: z.object({
        name: z.string().optional().describe(
          "VM name (auto-generated if omitted)",
        ),
        image: z.string().optional().describe(
          "Container image (e.g. ubuntu:22.04)",
        ),
        cpu: z.number().optional().describe("Number of CPUs (default 2)"),
        memory: z.string().optional().describe(
          "Memory allocation (e.g. 4GB, 8G)",
        ),
        disk: z.string().optional().describe("Disk size (e.g. 20GB, 50G)"),
        tags: z.array(z.string()).optional().describe("Tags to apply"),
        comment: z.string().optional().describe(
          "Short comment about the VM (max 200 bytes)",
        ),
        setupScript: z.string().optional().describe(
          "Setup script to run on first boot (max 10KiB)",
        ),
        env: z.record(z.string(), z.string()).optional().describe(
          "Environment variables as KEY=VALUE pairs",
        ),
        integrations: z.array(z.string()).optional().describe(
          "Integration names to attach",
        ),
      }),
      execute: async (
        args: {
          name?: string;
          image?: string;
          cpu?: number;
          memory?: string;
          disk?: string;
          tags?: string[];
          comment?: string;
          setupScript?: string;
          env?: Record<string, string>;
          integrations?: string[];
        },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const cmd = buildCreateCmd(args);
        const resp = await exeApi(ctx.globalArgs.token, cmd);
        const raw = parseJsonResponse<RawVm>(resp, "new");
        const vm = mapVm(raw);

        ctx.logger.info("exe.dev VM created: {name} ({region})", {
          name: vm.vmName,
          region: vm.region,
        });

        const handle = await ctx.writeResource(
          "vm",
          vm.vmName,
          vm as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    destroy: {
      description: "Delete one or more exe.dev VMs by name.",
      arguments: z.object({
        names: z.array(z.string()).min(1).describe("VM name(s) to delete"),
      }),
      execute: async (
        args: { names: string[] },
        ctx: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const resp = await exeApi(
          ctx.globalArgs.token,
          `rm --json ${args.names.join(" ")}`,
        );
        parseJsonResponse<unknown>(resp, "rm");
        ctx.logger.info("exe.dev VMs destroyed: {names}", {
          names: args.names.join(", "),
        });
        return {};
      },
    },

    restart: {
      description: "Restart an exe.dev VM.",
      arguments: z.object({
        name: z.string().min(1).describe("VM name to restart"),
      }),
      execute: async (
        args: { name: string },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const resp = await exeApi(
          ctx.globalArgs.token,
          `restart --json ${args.name}`,
        );
        parseJsonResponse<unknown>(resp, "restart");
        ctx.logger.info("exe.dev VM restarted: {name}", { name: args.name });

        // Re-fetch VM state after restart
        const lsResp = await exeApi(ctx.globalArgs.token, "ls -l --json");
        const lsData = parseJsonResponse<{ vms: RawVm[] }>(lsResp, "ls");
        const found = lsData.vms?.find((v) => v.vm_name === args.name);
        if (found) {
          const vm = mapVm(found);
          const handle = await ctx.writeResource(
            "vm",
            vm.vmName,
            vm as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        }
        return {};
      },
    },

    resize: {
      description: "Resize a VM's CPU, memory, or disk.",
      arguments: z.object({
        name: z.string().min(1).describe("VM name to resize"),
        cpu: z.number().optional().describe("New CPU count"),
        memory: z.string().optional().describe("New memory (e.g. 8GB)"),
        disk: z.string().optional().describe(
          "New disk size (must be larger than current)",
        ),
      }),
      execute: async (
        args: { name: string; cpu?: number; memory?: string; disk?: string },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const cmd = buildResizeCmd(args);
        const resp = await exeApi(ctx.globalArgs.token, cmd);
        parseJsonResponse<unknown>(resp, "resize");
        ctx.logger.info("exe.dev VM resized: {name}", { name: args.name });

        // Re-fetch state
        const lsResp = await exeApi(ctx.globalArgs.token, "ls -l --json");
        const lsData = parseJsonResponse<{ vms: RawVm[] }>(lsResp, "ls");
        const found = lsData.vms?.find((v) => v.vm_name === args.name);
        if (found) {
          const vm = mapVm(found);
          const handle = await ctx.writeResource(
            "vm",
            vm.vmName,
            vm as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        }
        return {};
      },
    },

    stat: {
      description: "Fetch CPU, memory, disk, and IO metrics for a VM.",
      arguments: z.object({
        name: z.string().min(1).describe("VM name"),
        range: z.enum(["24h", "7d", "30d"]).default("24h").describe(
          "Time range for metrics",
        ),
      }),
      execute: async (
        args: { name: string; range: string },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const resp = await exeApi(
          ctx.globalArgs.token,
          `stat --json ${args.name} --range=${args.range}`,
        );
        const metrics = parseJsonResponse<unknown>(resp, "stat");

        ctx.logger.info("exe.dev stat fetched: {name} ({range})", {
          name: args.name,
          range: args.range,
        });

        const handle = await ctx.writeResource("stat", args.name, {
          vmName: args.name,
          fetchedAt: new Date().toISOString(),
          range: args.range,
          metrics,
        });
        return { dataHandles: [handle] };
      },
    },

    tag: {
      description: "Add or remove tags on a VM.",
      arguments: z.object({
        name: z.string().min(1).describe("VM name"),
        add: z.array(z.string()).optional().describe("Tags to add"),
        remove: z.array(z.string()).optional().describe("Tags to remove"),
      }),
      execute: async (
        args: { name: string; add?: string[]; remove?: string[] },
        ctx: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        if (args.add?.length) {
          const cmd = buildTagCmd(args.name, args.add, false);
          const resp = await exeApi(ctx.globalArgs.token, cmd);
          parseJsonResponse<unknown>(resp, "tag");
          ctx.logger.info("exe.dev tags added to {name}: {tags}", {
            name: args.name,
            tags: args.add.join(", "),
          });
        }

        if (args.remove?.length) {
          const cmd = buildTagCmd(args.name, args.remove, true);
          const resp = await exeApi(ctx.globalArgs.token, cmd);
          parseJsonResponse<unknown>(resp, "tag");
          ctx.logger.info("exe.dev tags removed from {name}: {tags}", {
            name: args.name,
            tags: args.remove.join(", "),
          });
        }
        return {};
      },
    },

    exec: {
      description:
        "Execute a shell command on a VM via SSH. Stores the output as " +
        "versioned data for downstream consumption.",
      arguments: z.object({
        name: z.string().min(1).describe("VM name to execute on"),
        command: z.string().min(1).describe("Shell command to run"),
        timeout: z.number().default(30).describe(
          "SSH command timeout in seconds",
        ),
      }),
      execute: async (
        args: { name: string; command: string; timeout: number },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warn: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const sshCmd = new Deno.Command("ssh", {
          args: [
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            `ConnectTimeout=${Math.min(args.timeout, 10)}`,
            `${args.name}.exe.xyz`,
            args.command,
          ],
          stdout: "piped",
          stderr: "piped",
        });

        const child = sshCmd.spawn();
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
        }, args.timeout * 1000);

        let result: Deno.CommandOutput;
        try {
          result = await child.output();
        } finally {
          clearTimeout(timer);
        }

        const stdout = new TextDecoder().decode(result.stdout);
        const stderr = new TextDecoder().decode(result.stderr);
        const output = stdout + (stderr ? `\n${stderr}` : "");

        ctx.logger.info("exe.dev exec on {name}: exit {code}", {
          name: args.name,
          code: result.code,
        });

        // Instance name uses a hash of vm+command for deterministic dedup,
        // suffixed with a short timestamp to allow re-runs of the same command.
        const instanceName = `${args.name}-${
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-1",
                new TextEncoder().encode(`${args.name}:${args.command}`),
              ),
            ),
          ).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8)
        }`;

        const handle = await ctx.writeResource(
          "exec",
          instanceName,
          {
            vmName: args.name,
            command: args.command,
            executedAt: new Date().toISOString(),
            output,
            exitCode: result.code,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    comment: {
      description: "Set or clear a short comment on a VM (max 200 bytes).",
      arguments: z.object({
        name: z.string().min(1).describe("VM name"),
        text: z.string().describe(
          "Comment text (empty string to clear)",
        ),
      }),
      execute: async (
        args: { name: string; text: string },
        ctx: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const cmd = buildCommentCmd(args.name, args.text);
        const resp = await exeApi(ctx.globalArgs.token, cmd);
        parseJsonResponse<unknown>(resp, "comment");

        ctx.logger.info("exe.dev comment set on {name}", { name: args.name });
        return {};
      },
    },

    share: {
      description:
        "Manage sharing on a VM: set public/private, add/remove users, " +
        "or manage share links. Only one action per invocation.",
      arguments: z.object({
        name: z.string().min(1).describe("VM name"),
        action: z.enum([
          "set-public",
          "set-private",
          "add",
          "remove",
          "add-link",
          "remove-link",
          "show",
        ]).describe("Sharing action to perform"),
        email: z.string().optional().describe(
          "Email address (required for add/remove actions)",
        ),
        linkToken: z.string().optional().describe(
          "Share link token (required for remove-link)",
        ),
        root: z.boolean().optional().describe(
          "Grant/revoke shell (SSH) access instead of web-only (for add/remove)",
        ),
      }),
      execute: async (
        args: {
          name: string;
          action: string;
          email?: string;
          linkToken?: string;
          root?: boolean;
        },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        let cmd: string;

        switch (args.action) {
          case "set-public":
            cmd = `share set-public --json ${args.name}`;
            break;
          case "set-private":
            cmd = `share set-private --json ${args.name}`;
            break;
          case "add":
            if (!args.email) {
              throw new Error("email is required for share add");
            }
            cmd = `share add --json ${args.name} ${args.email}`;
            if (args.root) cmd += " --root";
            break;
          case "remove":
            if (!args.email) {
              throw new Error("email is required for share remove");
            }
            cmd = `share remove --json ${args.name} ${args.email}`;
            if (args.root) cmd += " --root";
            break;
          case "add-link":
            cmd = `share add-link --json ${args.name}`;
            break;
          case "remove-link":
            if (!args.linkToken) {
              throw new Error("linkToken is required for share remove-link");
            }
            if (!/^[\w\-]+$/.test(args.linkToken)) {
              throw new Error(
                "linkToken must be alphanumeric (letters, digits, hyphens, underscores)",
              );
            }
            cmd = `share remove-link --json ${args.name} ${args.linkToken}`;
            break;
          case "show": {
            // Re-fetch full VM state (includes sharing details) via ls -l
            const lsResp = await exeApi(ctx.globalArgs.token, "ls -l --json");
            const lsData = parseJsonResponse<{ vms: RawVm[] }>(lsResp, "ls");
            const found = lsData.vms?.find((v) => v.vm_name === args.name);
            if (!found) {
              throw new Error(`VM "${args.name}" not found in fleet`);
            }
            const vm = mapVm(found);
            const handle = await ctx.writeResource(
              "vm",
              vm.vmName,
              vm as unknown as Record<string, unknown>,
            );
            ctx.logger.info("exe.dev share info fetched for {name}: {status}", {
              name: args.name,
              status: vm.proxyShare ?? "unknown",
            });
            return { dataHandles: [handle] };
          }
          default:
            throw new Error(`Unknown share action: ${args.action}`);
        }

        const resp = await exeApi(ctx.globalArgs.token, cmd);
        parseJsonResponse<unknown>(resp, `share ${args.action}`);

        ctx.logger.info("exe.dev share {action} on {name}", {
          name: args.name,
          action: args.action,
        });
        return {};
      },
    },

    shelley_versions: {
      description:
        "Fan out across all VMs (or a filtered subset) and check the " +
        "installed Shelley/Claude Code version via SSH. Produces a versioned " +
        "snapshot showing each VM's version, which are outdated relative to " +
        "the newest observed, and how many need upgrading.",
      arguments: z.object({
        filter: z.array(z.string()).optional().describe(
          "VM names to check (default: all VMs from latest fleet sync)",
        ),
      }),
      execute: async (
        args: { filter?: string[] },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warn: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        // Determine which VMs to check
        let vmNames: string[];
        if (args.filter?.length) {
          vmNames = args.filter;
        } else {
          // Read from latest fleet sync (instance name is "all")
          const fleet = await ctx.readResource("all") as
            | { vms: Array<{ vmName: string }> }
            | null;
          if (!fleet?.vms?.length) {
            throw new Error(
              "No fleet data available. Run sync first, or pass explicit VM " +
                "names via the filter argument.",
            );
          }
          vmNames = fleet.vms.map((v) => v.vmName);
        }

        ctx.logger.info("Checking Shelley version on {count} VMs", {
          count: vmNames.length,
        });

        // Fan out — check all VMs in parallel
        const results = await Promise.all(
          vmNames.map(async (vmName) => {
            try {
              const cmd = new Deno.Command("ssh", {
                args: [
                  "-o",
                  "StrictHostKeyChecking=accept-new",
                  "-o",
                  "ConnectTimeout=5",
                  `${vmName}.exe.xyz`,
                  "claude --version 2>/dev/null || echo NOT_INSTALLED",
                ],
                stdout: "piped",
                stderr: "piped",
              });
              const result = await cmd.output();
              const stdout = new TextDecoder().decode(result.stdout).trim();

              if (stdout === "NOT_INSTALLED" || !stdout) {
                return { vmName, version: null, error: "not installed" };
              }
              // Parse "2.1.85 (Claude Code)" -> "2.1.85"
              const verMatch = stdout.match(/^([\d.]+)/);
              return {
                vmName,
                version: verMatch ? verMatch[1] : stdout,
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { vmName, version: null, error: msg };
            }
          }),
        );

        // Determine latest observed version
        const versions = results
          .map((r) => r.version)
          .filter((v): v is string => v !== null);
        const sorted = [...versions].sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
            if (diff !== 0) return diff;
          }
          return 0;
        });
        const latestObserved = sorted[0] ?? null;

        const outdatedCount = results.filter(
          (r) => r.version !== null && r.version !== latestObserved,
        ).length;

        ctx.logger.info(
          "Shelley versions checked: latest observed {latest}, {outdated} outdated",
          { latest: latestObserved, outdated: outdatedCount },
        );

        const handle = await ctx.writeResource("shelleyVersions", "fleet", {
          fetchedAt: new Date().toISOString(),
          vms: results,
          count: results.length,
          outdatedCount,
          latestObserved,
        });
        return { dataHandles: [handle] };
      },
    },

    shelley_upgrade: {
      description: "Upgrade Shelley on one or more VMs via the exe.dev API " +
        "(shelley install). Fans out across the target VMs sequentially " +
        "(exe.dev rate limits apply). Records previous version and upgrade " +
        "output for each VM.",
      arguments: z.object({
        names: z.array(z.string()).optional().describe(
          "VM names to upgrade. Default: all VMs where shelley_versions " +
            "shows an outdated version.",
        ),
      }),
      execute: async (
        args: { names?: string[] },
        ctx: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            instanceName: string,
            version?: number,
          ) => Promise<Record<string, unknown> | null>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warn: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        let vmNames: string[];
        if (args.names?.length) {
          vmNames = args.names;
        } else {
          // Default: upgrade all outdated VMs from the latest version check
          const versions = await ctx.readResource("fleet") as
            | {
              vms: Array<{ vmName: string; version: string | null }>;
              latestObserved: string | null;
            }
            | null;
          if (!versions?.vms?.length) {
            throw new Error(
              "No Shelley version data available. Run shelley_versions first, " +
                "or pass explicit VM names.",
            );
          }
          const latest = versions.latestObserved;
          vmNames = versions.vms
            .filter((v) => v.version !== null && v.version !== latest)
            .map((v) => v.vmName);
          if (!vmNames.length) {
            ctx.logger.info(
              "All VMs are already at the latest observed version",
            );
            return {};
          }
        }

        ctx.logger.info("Upgrading Shelley on {count} VMs", {
          count: vmNames.length,
        });

        const results: Array<{
          vmName: string;
          previousVersion: string | null;
          upgraded: boolean;
          output: string;
          error?: string;
        }> = [];

        for (const vmName of vmNames) {
          try {
            // Check current version first
            const verCmd = new Deno.Command("ssh", {
              args: [
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "ConnectTimeout=5",
                `${vmName}.exe.xyz`,
                "claude --version 2>/dev/null || echo NOT_INSTALLED",
              ],
              stdout: "piped",
              stderr: "piped",
            });
            const verResult = await verCmd.output();
            const verOut = new TextDecoder().decode(verResult.stdout).trim();
            const verMatch = verOut.match(/^([\d.]+)/);
            const previousVersion = verMatch ? verMatch[1] : null;

            // Run shelley install via exe.dev API
            const resp = await exeApi(
              ctx.globalArgs.token,
              `shelley install ${vmName}`,
            );

            if (!resp.ok) {
              results.push({
                vmName,
                previousVersion,
                upgraded: false,
                output: resp.body,
                error: `HTTP ${resp.status}: ${resp.body}`,
              });
              ctx.logger.warn("Shelley upgrade failed on {vm}: {error}", {
                vm: vmName,
                error: resp.body,
              });
            } else {
              results.push({
                vmName,
                previousVersion,
                upgraded: true,
                output: resp.body,
              });
              ctx.logger.info(
                "Shelley upgraded on {vm} (was {prev})",
                { vm: vmName, prev: previousVersion ?? "unknown" },
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              vmName,
              previousVersion: null,
              upgraded: false,
              output: "",
              error: msg,
            });
            ctx.logger.warn("Shelley upgrade error on {vm}: {error}", {
              vm: vmName,
              error: msg,
            });
          }
        }

        const upgradedCount = results.filter((r) => r.upgraded).length;
        const failedCount = results.filter((r) => !r.upgraded).length;

        const handle = await ctx.writeResource("shelleyUpgrade", "run", {
          executedAt: new Date().toISOString(),
          results,
          upgradedCount,
          failedCount,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
