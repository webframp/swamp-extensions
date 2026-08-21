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
  token: z.string().optional().describe(
    "exe.dev API bearer token (use vault reference). Generate with the " +
      "setup method or: ssh exe.dev ssh-key generate-api-key --exp=30d. " +
      "Required for all methods except setup.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SharingSchema = z.object({
  group: z.string().describe("Sharing group identifier for the VM"),
  publicProxy: z.boolean().describe(
    "Whether the VM's HTTPS proxy is publicly accessible",
  ),
  teamShared: z.boolean().describe("Whether the VM is shared with the team"),
  teamAccess: z.boolean().describe(
    "Whether team members currently have access to the VM",
  ),
  namedUserCount: z.number().describe(
    "Number of individually named users granted access",
  ),
  shareLinkCount: z.number().describe("Number of active share links"),
});

const VmSchema = z.object({
  vmName: z.string().describe("Unique exe.dev VM name"),
  httpsUrl: z.string().describe("HTTPS URL for the VM's web proxy"),
  sshDest: z.string().describe("SSH destination string for the VM"),
  sshHost: z.string().describe("SSH hostname for the VM"),
  sshUser: z.string().optional().describe("SSH user configured for the VM"),
  region: z.string().describe("Region code where the VM is running"),
  regionDisplay: z.string().describe("Human-readable region name"),
  status: z.string().describe("Current lifecycle status of the VM"),
  image: z.string().optional().describe(
    "Container image the VM was created from",
  ),
  allocatedCpus: z.number().optional().describe(
    "Number of CPUs allocated to the VM",
  ),
  memoryGb: z.number().optional().describe(
    "Memory allocated to the VM, in GiB",
  ),
  diskGb: z.number().optional().describe("Disk allocated to the VM, in GiB"),
  proxyPort: z.number().optional().describe(
    "Port the VM's proxy listens on",
  ),
  proxyShare: z.string().optional().describe(
    "Current sharing state of the VM's proxy",
  ),
  sharing: SharingSchema.optional().describe(
    "Detailed sharing configuration for the VM",
  ),
  tags: z.array(z.string()).optional().describe("Tags applied to the VM"),
  domains: z.array(z.string()).optional().describe(
    "Custom domains attached to the VM",
  ),
  comment: z.string().optional().describe("Short comment set on the VM"),
  emoji: z.string().optional().describe("Emoji icon associated with the VM"),
  createdAt: z.string().optional().describe("Timestamp the VM was created"),
  updatedAt: z.string().optional().describe(
    "Timestamp the VM was last updated",
  ),
  lastActiveAt: z.string().optional().describe(
    "Timestamp of the VM's last observed activity",
  ),
  emailReceiveEnabled: z.boolean().optional().describe(
    "Whether the VM can receive inbound email",
  ),
  shelleyUrl: z.string().optional().describe(
    "URL for the VM's Shelley (Claude Code) web session",
  ),
  terminalUrl: z.string().optional().describe(
    "URL for the VM's web terminal",
  ),
});

const FleetSchema = z.object({
  fetchedAt: z.string().describe(
    "Timestamp the fleet snapshot was fetched",
  ),
  vms: z.array(VmSchema).describe("VMs observed in the fleet"),
  count: z.number().describe("Number of VMs in the fleet"),
});

const VmDetailSchema = VmSchema;

const StatSchema = z.object({
  vmName: z.string().describe("VM the metrics were fetched for"),
  fetchedAt: z.string().describe("Timestamp the metrics were fetched"),
  range: z.string().describe("Time range covered by the metrics"),
  metrics: z.unknown().describe(
    "Raw metrics payload returned by the exe.dev stat API",
  ),
});

const ExecResultSchema = z.object({
  vmName: z.string().describe("VM the command was executed on"),
  command: z.string().describe("Shell command that was executed"),
  executedAt: z.string().describe("Timestamp the command was executed"),
  output: z.string().describe(
    "Combined stdout/stderr output of the command",
  ),
  exitCode: z.number().describe("Exit code of the executed command"),
  truncated: z.boolean().describe(
    "Whether output was truncated by the 10MB per-stream cap",
  ),
});

const ShelleyVersionSchema = z.object({
  vmName: z.string().describe("VM the version was checked on"),
  version: z.string().nullable().describe(
    "Installed Shelley/Claude Code version, or null if not installed or unreachable",
  ),
  error: z.string().optional().describe(
    "Error encountered while checking the version",
  ),
});

const ShelleyVersionsSchema = z.object({
  fetchedAt: z.string().describe(
    "Timestamp the version check was performed",
  ),
  vms: z.array(ShelleyVersionSchema).describe(
    "Per-VM Shelley version results",
  ),
  count: z.number().describe("Number of VMs checked"),
  outdatedCount: z.number().describe(
    "Number of VMs running a version older than the latest observed",
  ),
  latestObserved: z.string().nullable().describe(
    "Newest Shelley version observed across the checked VMs",
  ),
});

const ShelleyUpgradeResultSchema = z.object({
  vmName: z.string().describe("VM the upgrade was attempted on"),
  previousVersion: z.string().nullable().describe(
    "Shelley version installed before the upgrade attempt",
  ),
  upgraded: z.boolean().describe("Whether the upgrade succeeded"),
  output: z.string().describe("Raw output from the upgrade command"),
  error: z.string().optional().describe(
    "Error encountered during the upgrade attempt",
  ),
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

/** Escape characters that could break the exe.dev line-delimited text protocol. */
export function escapeQuotes(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * exe.dev VM names are DNS-label-like: lowercase alphanumeric and hyphens,
 * no spaces, no flag prefixes. Rejects anything that could split into multiple
 * tokens or inject flags in the text-based API protocol.
 */
const VM_NAME_RE = /^[a-z0-9][a-z0-9\-]*[a-z0-9]$|^[a-z0-9]$/;

/** Validate a VM name before interpolating it into a command string. */
export function assertVmName(name: string): void {
  if (!VM_NAME_RE.test(name)) {
    throw new Error(
      `Invalid VM name "${name}": must be lowercase alphanumeric with hyphens, ` +
        `no spaces, no leading dashes. Examples: "my-vm", "worker1".`,
    );
  }
}

/**
 * Validate an email address before interpolating it into a command string.
 * Rejects whitespace, flag-prefix patterns, and shell metacharacters that
 * could inject arguments or be interpreted as control characters.
 */
export function assertEmail(email: string): void {
  if (/\s/.test(email) || email.startsWith("-")) {
    throw new Error(
      `Invalid email "${email}": must not contain whitespace or start with "-".`,
    );
  }
  if (!email.includes("@")) {
    throw new Error(
      `Invalid email "${email}": must contain an "@" character.`,
    );
  }
  if (/[;|&`$"'\\(){}]/.test(email)) {
    throw new Error(
      `Invalid email "${email}": contains shell metacharacters that are ` +
        `not permitted. Use a plain email address.`,
    );
  }
}

/** Environment variable keys must follow POSIX conventions. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate an environment variable key before interpolating it into a command.
 * Rejects anything that isn't a standard env var identifier.
 */
export function assertEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `Invalid env key "${key}": must match [A-Za-z_][A-Za-z0-9_]* ` +
        `(POSIX environment variable naming).`,
    );
  }
}

/**
 * Validate a value that will be interpolated as an unquoted flag argument.
 * Rejects whitespace, quotes, and flag prefixes that could inject tokens.
 */
export function assertFlagValue(value: string, label: string): void {
  if (/\s/.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": must not contain whitespace.`,
    );
  }
  if (value.startsWith("-")) {
    throw new Error(
      `Invalid ${label} "${value}": must not start with "-".`,
    );
  }
  if (/["'\\]/.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": must not contain quotes or backslashes.`,
    );
  }
}

/**
 * Require a non-empty token from globalArgs. Throws an actionable error if
 * the token is missing (not yet bootstrapped).
 */
function requireToken(globalArgs: GlobalArgs): string {
  if (!globalArgs.token) {
    throw new Error(
      "No API token configured. Run the setup method first to generate " +
        "and vault a token, then set your model config to: " +
        'token: \'${{ vault.get("<vaultName>", "<secretKey>") }}\'',
    );
  }
  return globalArgs.token;
}

/**
 * Run an SSH command with a hard execution timeout. Spawns the process,
 * sends SIGTERM after timeoutSec, then SIGKILL 2 seconds later if still alive.
 * Returns the command output (stdout + stderr, capped at 10MB) and exit code.
 */
async function sshWithTimeout(
  args: string[],
  timeoutSec: number,
): Promise<
  { stdout: string; stderr: string; code: number; truncated: boolean }
> {
  const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap per stream
  const cmd = new Deno.Command("ssh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  let killed = false;
  const termTimer = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  }, timeoutSec * 1000);

  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, (timeoutSec + 2) * 1000);

  let result: Deno.CommandOutput;
  try {
    result = await child.output();
  } finally {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  }

  const rawStdout = result.stdout;
  const rawStderr = result.stderr;
  const truncated = rawStdout.byteLength > MAX_OUTPUT_BYTES ||
    rawStderr.byteLength > MAX_OUTPUT_BYTES;
  const stdout = new TextDecoder().decode(
    rawStdout.byteLength > MAX_OUTPUT_BYTES
      ? rawStdout.slice(0, MAX_OUTPUT_BYTES)
      : rawStdout,
  );
  const stderr = new TextDecoder().decode(
    rawStderr.byteLength > MAX_OUTPUT_BYTES
      ? rawStderr.slice(0, MAX_OUTPUT_BYTES)
      : rawStderr,
  );
  return {
    stdout,
    stderr,
    code: killed ? 124 : result.code,
    truncated,
  };
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
  if (args.name) {
    assertVmName(args.name);
    parts.push(`--name=${args.name}`);
  }
  if (args.image != null) {
    assertFlagValue(args.image, "image");
    parts.push(`--image=${args.image}`);
  }
  if (args.cpu != null) parts.push(`--cpu=${args.cpu}`);
  if (args.memory != null) {
    assertFlagValue(args.memory, "memory");
    parts.push(`--memory=${args.memory}`);
  }
  if (args.disk != null) {
    assertFlagValue(args.disk, "disk");
    parts.push(`--disk=${args.disk}`);
  }
  if (args.comment != null) {
    parts.push(`--comment="${escapeQuotes(args.comment)}"`);
  }
  if (args.tags?.length) {
    for (const tag of args.tags) {
      assertFlagValue(tag, "tag");
      if (tag.includes(",")) {
        throw new Error(
          `Invalid tag "${tag}": must not contain commas (tags are comma-separated in the protocol).`,
        );
      }
    }
    parts.push(`--tag=${args.tags.join(",")}`);
  }
  if (args.setupScript) {
    parts.push(`--setup-script="${escapeQuotes(args.setupScript)}"`);
  }
  if (args.env) {
    for (const [k, v] of Object.entries(args.env)) {
      assertEnvKey(k);
      parts.push(`--env ${k}="${escapeQuotes(v)}"`);
    }
  }
  if (args.integrations?.length) {
    for (const name of args.integrations) {
      assertFlagValue(name, "integration");
    }
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
  assertVmName(args.name);
  const parts: string[] = [`resize ${args.name} --json`];
  if (args.cpu != null) parts.push(`--cpu=${args.cpu}`);
  if (args.memory != null) {
    assertFlagValue(args.memory, "memory");
    parts.push(`--memory=${args.memory}`);
  }
  if (args.disk != null) {
    assertFlagValue(args.disk, "disk");
    parts.push(`--disk=${args.disk}`);
  }
  return parts.join(" ");
}

/** Build the `comment` command string. */
export function buildCommentCmd(name: string, text: string): string {
  assertVmName(name);
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
  assertVmName(name);
  for (const t of tags) {
    assertFlagValue(t, "tag");
  }
  const quotedTags = tags.map((t) => `"${escapeQuotes(t)}"`).join(" ");
  return remove
    ? `tag --json -d ${name} ${quotedTags}`
    : `tag --json ${name} ${quotedTags}`;
}

async function exeApi(token: string, command: string): Promise<ExeApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch("https://exe.dev/exec", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: command,
      signal: controller.signal,
    });
    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("exe.dev API request timed out after 30 seconds");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a successful JSON response. On 403, produces an actionable error that
 * names the denied command and tells the caller how to fix it (run setup or
 * regenerate the token with the correct --cmds).
 */
function parseJsonResponse<T>(resp: ExeApiResponse, command?: string): T {
  if (resp.status === 403) {
    const baseCmd = (command ?? "unknown").split(" ")[0];
    const quotedSubs = REQUIRED_SUBCOMMANDS.map((s) => `"${s}"`);
    const cmdsValue = [...REQUIRED_CMDS, ...quotedSubs].join(",");
    throw new Error(
      `exe.dev API returned 403 (command not allowed): "${baseCmd}" is not ` +
        `permitted by the current token. Fix: run the "setup" method to ` +
        `generate a token with full permissions, or manually regenerate with:\n` +
        `  ssh exe.dev ssh-key generate-api-key --exp=30d ` +
        `'--cmds=${cmdsValue}'`,
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
    memoryGb: raw.memory_capacity_bytes != null
      ? raw.memory_capacity_bytes / (1024 * 1024 * 1024)
      : undefined,
    diskGb: raw.disk_capacity_bytes != null
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
        executedAt: z.string().describe(
          "Timestamp the upgrade batch was executed",
        ),
        results: z.array(ShelleyUpgradeResultSchema).describe(
          "Per-VM upgrade results",
        ),
        upgradedCount: z.number().describe(
          "Number of VMs successfully upgraded",
        ),
        failedCount: z.number().describe(
          "Number of VMs where the upgrade failed",
        ),
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
        expiry: z.string().regex(/^\d+[dhms]$/, {
          message: "Must be a number followed by d, h, m, or s (e.g. 30d, 24h)",
        }).default("30d").describe(
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
        const { stdout: sshStdout, stderr: sshStderr, code: sshCode } =
          await sshWithTimeout(
            [
              "exe.dev",
              "ssh-key",
              "generate-api-key",
              `--exp=${args.expiry}`,
              `--cmds=${cmds}`,
              `--label=${label}`,
            ],
            30,
          );

        if (sshCode !== 0) {
          throw new Error(
            `Failed to generate exe.dev API token (exit ${sshCode}): ` +
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

        // Store in vault via swamp CLI (pass token on stdin to avoid process table exposure)
        const vaultCmd = new Deno.Command("swamp", {
          args: [
            "vault",
            "put",
            args.vaultName,
            args.secretKey,
            "--stdin",
            "--yes",
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const vaultChild = vaultCmd.spawn();
        const vaultTimer = setTimeout(() => {
          try {
            vaultChild.kill("SIGTERM");
          } catch { /* already exited */ }
        }, 15_000);
        const writer = vaultChild.stdin.getWriter();
        await writer.write(new TextEncoder().encode(token));
        await writer.close();
        let vaultResult: Deno.CommandOutput;
        try {
          vaultResult = await vaultChild.output();
        } finally {
          clearTimeout(vaultTimer);
        }

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
        const resp = await exeApi(requireToken(ctx.globalArgs), "ls -l --json");
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
        const resp = await exeApi(requireToken(ctx.globalArgs), cmd);
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
        args.names.forEach(assertVmName);
        const resp = await exeApi(
          requireToken(ctx.globalArgs),
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
        assertVmName(args.name);
        const resp = await exeApi(
          requireToken(ctx.globalArgs),
          `restart --json ${args.name}`,
        );
        parseJsonResponse<unknown>(resp, "restart");
        ctx.logger.info("exe.dev VM restarted: {name}", { name: args.name });

        // Re-fetch VM state after restart
        const lsResp = await exeApi(
          requireToken(ctx.globalArgs),
          "ls -l --json",
        );
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
        const resp = await exeApi(requireToken(ctx.globalArgs), cmd);
        parseJsonResponse<unknown>(resp, "resize");
        ctx.logger.info("exe.dev VM resized: {name}", { name: args.name });

        // Re-fetch state
        const lsResp = await exeApi(
          requireToken(ctx.globalArgs),
          "ls -l --json",
        );
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
        assertVmName(args.name);
        const resp = await exeApi(
          requireToken(ctx.globalArgs),
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
          const resp = await exeApi(requireToken(ctx.globalArgs), cmd);
          parseJsonResponse<unknown>(resp, "tag");
          ctx.logger.info("exe.dev tags added to {name}: {tags}", {
            name: args.name,
            tags: args.add.join(", "),
          });
        }

        if (args.remove?.length) {
          const cmd = buildTagCmd(args.name, args.remove, true);
          const resp = await exeApi(requireToken(ctx.globalArgs), cmd);
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
        command: z.string().min(1).max(65536).describe(
          "Shell command to run (max 64KB)",
        ),
        timeout: z.number().min(1).max(300).default(30).describe(
          "SSH command timeout in seconds (max 300)",
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
        assertVmName(args.name);
        const { stdout, stderr, code, truncated } = await sshWithTimeout(
          [
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            `ConnectTimeout=${Math.min(args.timeout, 10)}`,
            `${args.name}.exe.xyz`,
            args.command,
          ],
          args.timeout,
        );

        const output = stdout + (stderr ? `\n${stderr}` : "");

        ctx.logger.info("exe.dev exec on {name}: exit {code}", {
          name: args.name,
          code,
        });

        // Instance name is a hash of vm+command for deterministic dedup.
        // Re-running the same command on the same VM overwrites the previous result.
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
            exitCode: code,
            truncated,
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
        const resp = await exeApi(requireToken(ctx.globalArgs), cmd);
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
        assertVmName(args.name);
        if (args.email) {
          assertEmail(args.email);
        }
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
            const lsResp = await exeApi(
              requireToken(ctx.globalArgs),
              "ls -l --json",
            );
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

        const resp = await exeApi(requireToken(ctx.globalArgs), cmd);
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
          args.filter.forEach(assertVmName);
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

        // Re-validate vmNames from stored data before interpolating into SSH args
        vmNames.forEach(assertVmName);

        ctx.logger.info("Checking Shelley version on {count} VMs", {
          count: vmNames.length,
        });

        // Fan out with bounded concurrency (max 10 concurrent SSH connections)
        const CONCURRENCY = 10;
        const results: Array<{
          vmName: string;
          version: string | null;
          error?: string;
        }> = [];
        for (let i = 0; i < vmNames.length; i += CONCURRENCY) {
          const batch = vmNames.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.all(
            batch.map(async (vmName) => {
              try {
                const { stdout } = await sshWithTimeout(
                  [
                    "-o",
                    "StrictHostKeyChecking=accept-new",
                    "-o",
                    "ConnectTimeout=5",
                    `${vmName}.exe.xyz`,
                    "claude --version 2>/dev/null || echo NOT_INSTALLED",
                  ],
                  15,
                );
                const trimmed = stdout.trim();

                if (trimmed === "NOT_INSTALLED" || !trimmed) {
                  return { vmName, version: null, error: "not installed" };
                }
                // Parse "2.1.85 (Claude Code)" -> "2.1.85"
                const verMatch = trimmed.match(/^([\d.]+)/);
                return {
                  vmName,
                  version: verMatch ? verMatch[1] : trimmed,
                };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { vmName, version: null, error: msg };
              }
            }),
          );
          results.push(...batchResults);
        }

        // Determine latest observed version
        const versions = results
          .map((r) => r.version)
          .filter((v): v is string => v !== null);
        const sorted = [...versions].sort((a, b) => {
          const pa = a.split(".").map((s) => {
            const n = parseInt(s, 10);
            return isNaN(n) ? 0 : n;
          });
          const pb = b.split(".").map((s) => {
            const n = parseInt(s, 10);
            return isNaN(n) ? 0 : n;
          });
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
          args.names.forEach(assertVmName);
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

        // Re-validate vmNames from stored data before interpolating into commands
        vmNames.forEach(assertVmName);

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
            // Check current version first (with execution timeout)
            const { stdout: verOut } = await sshWithTimeout(
              [
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "ConnectTimeout=5",
                `${vmName}.exe.xyz`,
                "claude --version 2>/dev/null || echo NOT_INSTALLED",
              ],
              15,
            );
            const verMatch = verOut.trim().match(/^([\d.]+)/);
            const previousVersion = verMatch ? verMatch[1] : null;

            // Run shelley install via exe.dev API
            const resp = await exeApi(
              requireToken(ctx.globalArgs),
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

        // Instance name is a hash of the sorted target VM names for dedup
        const sortedNames = [...vmNames].sort().join(",");
        const upgradeHash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-1",
              new TextEncoder().encode(sortedNames),
            ),
          ),
        ).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);

        const handle = await ctx.writeResource("shelleyUpgrade", upgradeHash, {
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
