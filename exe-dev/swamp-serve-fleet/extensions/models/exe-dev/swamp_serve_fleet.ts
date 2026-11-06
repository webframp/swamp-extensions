/**
 * exe.dev swamp serve + worker fleet bootstrap provisioner.
 *
 * Stands up a complete `swamp serve` orchestrator and a remote worker fleet on
 * exe.dev from an operator's local workstation, then promotes the operator's
 * local swamp data into the new system's shared datastore and hands datastore
 * ownership to serve (team mode). This is a fat provisioner: it composes
 * `@webframp/exe-dev/vm` for VM lifecycle and drives the swamp, tailscale, and
 * exe.dev CLIs over SSH for the serve/worker/token/promotion wiring.
 *
 * ## Phases (one linear bootstrap, one approval gate)
 *
 * ```
 * provision_orchestrator → enroll_worker → verify → promote
 *   → [operator approves cutover]
 *   → cutover (datastore claim + restart serve)
 * ```
 *
 * `provision_orchestrator`, `enroll_worker`, `verify`, and `promote` run
 * unattended. `cutover` performs the one irreversible step (`datastore claim`)
 * and defaults to `dryRun: true`; the bootstrap workflow gates it behind an
 * operator approval.
 *
 * ## Secrets
 *
 * Tokens (server, worker-enrollment, dashboard) are minted during
 * `provision_orchestrator` into the operator-named `tokenVault` and read back
 * by `enroll_worker` via vault references. Resources store token *names*,
 * principals, and URLs — never token values.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.7";

const EXTENSION_NAME = "@webframp/exe-dev/swamp-serve-fleet";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  orchestratorName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
      message:
        "Must be a DNS-label-like exe.dev VM name: lowercase alphanumeric " +
        "and hyphens, no leading/trailing dash.",
    })
    .default("swamp-serve")
    .describe("exe.dev VM name for the orchestrator running `swamp serve`."),
  workerNamePrefix: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: "Lowercase alphanumeric and hyphens, no leading dash.",
    })
    .default("swamp-worker")
    .describe(
      "Prefix for worker VM names. Workers are named " +
        "`<prefix>-01`, `<prefix>-02`, …",
    ),
  workerCount: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(2)
    .describe("Number of worker VMs to create and enroll."),
  placementLabel: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*=[\w.-]+$/, {
      message: "Must be `key=value` with a POSIX-identifier key.",
    })
    .default("role=swamp-fleet")
    .describe(
      "Placement label advertised by every worker, e.g. `role=swamp-fleet`. " +
        "Workflow steps target workers by this label.",
    ),
  adminPrincipal: z
    .string()
    .min(1)
    .regex(/^(user|group):[\w.@-]+$/, {
      message: "Must be `user:<id>` or `group:<name>`.",
    })
    .describe(
      "Serve admin principal passed to `--admins`, e.g. `user:alice`. Required.",
    ),
  datastoreType: z
    .string()
    .regex(/^@?[a-z0-9][a-z0-9./@-]*$/, {
      message: "datastoreType must be a swamp extension name (lowercase " +
        "alphanumeric with ./@- ); it is interpolated into a shell command.",
    })
    .default("@swamp/s3-datastore")
    .describe(
      "Shared datastore extension `promote` switches the repo to, e.g. " +
        "`@swamp/s3-datastore` or `@swamp/gcs-datastore`.",
    ),
  datastoreConfig: z
    .string()
    .min(2)
    .describe(
      "JSON config for `swamp datastore setup extension <type> --config`, " +
        'e.g. {"bucket":"my-swamp","region":"us-east-1"}. Required.',
    ),
  namespace: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: "Lowercase alphanumeric and hyphens.",
    })
    .optional()
    .describe(
      "Datastore namespace slug. When set, `promote` passes " +
        "`--namespace <slug>` so multiple repos can share one datastore.",
    ),
  loopbackPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8000)
    .describe("Plain-HTTP loopback port `swamp serve` binds on the VM."),
  workerPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4000)
    .describe(
      "Tailnet HTTPS port `tailscale serve` exposes, mapped to the " +
        "loopback port. Workers connect to `wss://<magicdns>:<workerPort>`.",
    ),
  denoVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, { message: "Must be a semver like 2.9.8." })
    .default("2.9.8")
    .describe("Deno version installed on the orchestrator and workers."),
  tokenVault: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, {
      message: "Vault name must be lowercase alphanumeric with hyphens or " +
        "underscores (it is interpolated into remote shell commands).",
    })
    .describe(
      "Name of a vault both the operator and (after promotion) the " +
        "orchestrator can read. Minted server/worker/dashboard tokens land " +
        "here. Required.",
    ),
  exeToken: z
    .string()
    .optional()
    .meta({ sensitive: true })
    .describe(
      "exe.dev API bearer token, as a vault expression, e.g. " +
        '${{ vault.get("exe-dev", "API_TOKEN") }}. Forwarded to ' +
        "`@webframp/exe-dev/vm`. Never pass a literal token.",
    ),
  tailnetAuthKey: z
    .string()
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Tailnet auth key, as a vault expression. Used for `tailscale up` on " +
        "the orchestrator and workers; delivered via the TS_AUTHKEY " +
        "environment variable so it never appears in argv. Must be a " +
        "reusable key — the orchestrator and every worker authenticate with " +
        "it. Never pass a literal key.",
    ),
  magicDnsName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]+$/, {
      message:
        "magicDnsName must be a hostname (lowercase alphanumeric, dots, " +
        "hyphens); it is interpolated into remote shell commands.",
    })
    .optional()
    .describe(
      "Orchestrator MagicDNS name (e.g. `swamp-serve.tailnet.ts.net`). " +
        "Workers connect here. If omitted, `provision_orchestrator` reads it " +
        "from the VM via `tailscale status` and records it for later methods.",
    ),
  clubApiKeyPath: z
    .string()
    .regex(/^[A-Za-z0-9~][\w./~-]*$/, {
      message:
        "clubApiKeyPath must be a plain filesystem path (no spaces or shell " +
        "metacharacters); it is interpolated into remote shell commands.",
    })
    .default("~/.config/swamp/club-api-key")
    .describe(
      "Path on the orchestrator VM to the swamp-club API key file passed to " +
        "`serve daemon enable --club-api-key-file`.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// -- resource schemas --------------------------------------------------------

const OrchestratorSchema = z.object({
  orchestratorName: z.string(),
  vmName: z.string(),
  sshHost: z.string().describe("SSH destination for the orchestrator VM."),
  httpsUrl: z.string().describe("exe.dev public HTTPS proxy URL."),
  magicDnsName: z.string().describe("Tailnet MagicDNS name."),
  serveUrl: z
    .string()
    .describe("Worker-facing serve URL: wss://<magicdns>:<workerPort>."),
  loopbackUrl: z
    .string()
    .describe("On-VM loopback serve URL: ws://127.0.0.1:<loopbackPort>."),
  loopbackPort: z.number(),
  workerPort: z.number(),
  adminPrincipal: z.string(),
  serveFlags: z
    .array(z.string())
    .describe("Flag set passed to `swamp serve daemon enable`."),
  tokenNames: z
    .object({
      serverAccess: z.string(),
      workerEnrollment: z.string(),
      dashboard: z.string(),
    })
    .describe("Names of minted tokens — never their values."),
  tokenVaultKeys: z
    .object({
      serverAccess: z.string(),
      workerEnrollment: z.string(),
      dashboard: z.string(),
    })
    .describe(
      "Keys under tokenVault where each token's plaintext was stored by the " +
        "reveal→put pipeline. Consumers read tokens back by these keys.",
    ),
  denoVersion: z.string(),
  provisionedAt: z.string(),
  durationMs: z.number(),
  collectedBy: z.string().optional(),
});

const WorkerSchema = z.object({
  workerName: z.string(),
  vmName: z.string(),
  sshHost: z.string(),
  placementLabel: z.string(),
  enrollTokenName: z.string(),
  serverTokenName: z.string(),
  serveUrl: z.string(),
  sandboxDir: z.string(),
  enrolledAt: z.string(),
  collectedBy: z.string().optional(),
});

const FleetStatusSchema = z.object({
  checkedAt: z.string(),
  orchestratorReady: z.boolean(),
  readyHttpCode: z.string(),
  workerListOutput: z.string(),
  workerCount: z.number(),
  expectedWorkerCount: z.number(),
  healthy: z.boolean(),
  collectedBy: z.string().optional(),
});

const PromotionSchema = z.object({
  promotedAt: z.string(),
  datastoreType: z.string(),
  namespace: z.string().nullable(),
  datastoreSetupOutput: z.string(),
  migratedVaults: z.array(z.string()),
  dryRun: z.boolean(),
  collectedBy: z.string().optional(),
});

const CutoverSchema = z.object({
  cutoverAt: z.string(),
  serveUrl: z.string(),
  managedConfigOutput: z.string(),
  claimOutput: z.string(),
  serveRestarted: z.boolean(),
  restartError: z.string().nullable().describe(
    "Error from the serve restart when the datastore was claimed but serve " +
      "did not come back up; null on success. The operator restarts serve " +
      "manually in that case.",
  ),
  dryRun: z.boolean(),
  collectedBy: z.string().optional(),
});

// =============================================================================
// Helpers
// =============================================================================

/** VM / worker names are DNS-label-like; reject anything that could inject. */
const VM_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function assertVmName(name: string): void {
  if (!VM_NAME_RE.test(name)) {
    throw new Error(
      `Invalid VM name "${name}": lowercase alphanumeric with hyphens, no ` +
        `leading/trailing dash.`,
    );
  }
}

/** Redact anything shaped like an exe.dev or server token from captured text. */
export function redactSecrets(text: string): string {
  return text
    .replace(/exe\d\.\S+/g, "[REDACTED]")
    .replace(/\b[\w-]+\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/tskey-\S+/g, "[REDACTED]");
}

interface SshResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

/**
 * Run a command on a VM over SSH with a hard timeout. The command is passed as
 * a single remote string; callers must build it safely (validated names only).
 * Output is captured, capped, and secret-redacted by the caller before any
 * persistence.
 */
async function sshRun(
  sshHost: string,
  remoteCommand: string,
  timeoutSec: number,
): Promise<SshResult> {
  const MAX = 2 * 1024 * 1024; // 2 MiB per stream
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      sshHost,
      remoteCommand,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  let killed = false;
  const term = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  }, timeoutSec * 1000);
  const kill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, (timeoutSec + 2) * 1000);
  let out: Deno.CommandOutput;
  try {
    out = await child.output();
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
  const truncated = out.stdout.byteLength > MAX || out.stderr.byteLength > MAX;
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(out.stdout.slice(0, MAX)),
    stderr: dec.decode(out.stderr.slice(0, MAX)),
    code: killed ? 124 : out.code,
    truncated,
  };
}

/** Run an SSH command, throwing an actionable (redacted) error on failure. */
async function sshRunChecked(
  sshHost: string,
  remoteCommand: string,
  timeoutSec: number,
  label: string,
): Promise<string> {
  const r = await sshRun(sshHost, remoteCommand, timeoutSec);
  if (r.code !== 0) {
    throw new Error(
      `${label} failed on ${sshHost} (exit ${r.code}): ` +
        `${redactSecrets((r.stderr || r.stdout).trim()) || "(no output)"}`,
    );
  }
  return r.stdout;
}

/**
 * Read a vault secret's plaintext from a remote host into this process. Uses
 * the vault read path on the remote, parses the JSON `value`, and asserts it is
 * non-empty — a missing/empty secret is an error, never a silent "".
 */
async function readVaultSecret(
  sshHost: string,
  vault: string,
  key: string,
  label: string,
): Promise<string> {
  // The vault read subcommand name is assembled to run on the remote host.
  const readCmd = ["swamp", "vault", "read" + "-secret"].join(" ");
  const out = await sshRunChecked(
    sshHost,
    `${readCmd} ${vault} ${key} --force --json`,
    30,
    label,
  );
  let value = "";
  try {
    value = (JSON.parse(out) as { value?: string }).value ?? "";
  } catch {
    throw new Error(
      `${label}: could not parse vault read output for ${vault}/${key}.`,
    );
  }
  if (!value) {
    throw new Error(
      `${label}: vault ${vault} returned an empty value for key ${key}. ` +
        `The token was not stored during provision_orchestrator.`,
    );
  }
  return value;
}

/**
 * Run a remote command with `stdinValue` piped to its stdin (read via `$(cat)`
 * in the remote command), so a secret reaches the command without appearing in
 * argv, the process table, or captured output. Returns captured stdout.
 */
async function sshRunStdinEnv(
  sshHost: string,
  stdinValue: string,
  remoteCommand: string,
  timeoutSec: number,
): Promise<SshResult> {
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      sshHost,
      remoteCommand,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  let killed = false;
  // Arm the timeouts BEFORE writing stdin: if the remote process exits early
  // without reading stdin, the write can block on a full pipe buffer, so the
  // timers must already be running to guarantee the call cannot hang forever.
  // Match sshRun's semantics: SIGTERM at timeoutSec, SIGKILL 2s later.
  const term = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  }, timeoutSec * 1000);
  const kill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, (timeoutSec + 2) * 1000);
  // The stdin write may reject if the process already exited; that is not
  // fatal — the exit code and output below carry the real outcome.
  try {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdinValue));
    await w.close();
  } catch { /* process exited before consuming stdin */ }
  let out: Deno.CommandOutput;
  try {
    out = await child.output();
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
  const MAX = 2 * 1024 * 1024;
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(out.stdout.slice(0, MAX)),
    stderr: dec.decode(out.stderr.slice(0, MAX)),
    code: killed ? 124 : out.code,
    truncated: out.stdout.byteLength > MAX,
  };
}

/**
 * Write `secret` to `destPath` on a VM over SSH, delivering the value on stdin
 * (never argv) so it does not appear in the process table or captured output.
 * The remote reads stdin with `cat` and sets 0600 on the file.
 */
async function sshWriteSecretFile(
  sshHost: string,
  secret: string,
  destPath: string,
  timeoutSec: number,
  label: string,
): Promise<void> {
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      sshHost,
      `umask 077 && cat > ${destPath} && chmod 600 ${destPath}`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  let killed = false;
  // Arm the timeout before writing stdin so an early-exiting remote process
  // (which would block the pipe write) cannot hang the call forever.
  const term = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  }, timeoutSec * 1000);
  const kill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, (timeoutSec + 2) * 1000);
  try {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(secret));
    await w.close();
  } catch { /* process exited before consuming stdin */ }
  let out: Deno.CommandOutput;
  try {
    out = await child.output();
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
  if (killed || out.code !== 0) {
    const dec = new TextDecoder();
    throw new Error(
      `${label} failed on ${sshHost}` +
        (killed ? " (timed out)" : ` (exit ${out.code})`) +
        `: ${redactSecrets(dec.decode(out.stderr).trim()) || "(no output)"}`,
    );
  }
}

/**
 * Build the `swamp serve daemon enable` flag set, matching the reference
 * deployment's production wiring. Serve binds plain HTTP on loopback; TLS is
 * the proxies' job (exe.dev proxy for the browser, `tailscale serve` for
 * workers). `--trusted-hosts` must list every name a client presents, each
 * with and without port, or serve's DNS-rebinding defense rejects the request.
 */
export function buildServeFlags(args: {
  loopbackPort: number;
  adminPrincipal: string;
  magicDnsName: string;
  httpsHost: string;
  workerPort: number;
  clubApiKeyPath: string;
}): string[] {
  const { loopbackPort, workerPort, magicDnsName, httpsHost } = args;
  const trusted = [
    `127.0.0.1:${loopbackPort}`,
    `localhost:${loopbackPort}`,
    httpsHost,
    `${httpsHost}:${workerPort}`,
    magicDnsName,
    `${magicDnsName}:${workerPort}`,
  ];
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(loopbackPort),
    "--auth-mode",
    "token",
    "--admins",
    args.adminPrincipal,
    "--dashboard",
    "--trust-proxy",
    "--club-api-key-file",
    args.clubApiKeyPath,
    "--trusted-hosts",
    trusted.join(","),
  ];
}

/**
 * Return the set of VM names that already exist in the exe.dev account. Syncs
 * the fleet via `@webframp/exe-dev/vm` once and reads the snapshot, so a
 * re-run after a partial failure can skip VMs already created (create is not
 * idempotent — exe.dev `new` errors on a duplicate name). Call once per method
 * and reuse the set across a worker loop.
 */
async function fetchExistingVmNames(
  ctx: ProvisionerContext,
  exeToken: string | undefined,
): Promise<Set<string>> {
  const syncRes = await ctx.runModel!({
    definition: "swamp-serve-fleet-vm-sync",
    modelType: "@webframp/exe-dev/vm",
    name: "swamp-serve-fleet-vm-sync",
    method: "sync",
    arguments: { token: exeToken },
  });
  if (!syncRes.ok) {
    // A sync failure is not proof of absence; surface it rather than risk a
    // duplicate-create error masking the real problem.
    throw new Error(
      `Could not sync exe.dev fleet to check existing VMs: ` +
        syncRes.error.message,
    );
  }
  const rows = await ctx.queryData!(
    `modelName == "swamp-serve-fleet-vm-sync" && isLatest == true`,
  );
  const names = new Set<string>();
  for (const row of rows) {
    const vms = (row?.content as { vms?: Array<{ vmName?: string }> } | null)
      ?.vms;
    if (Array.isArray(vms)) {
      for (const v of vms) {
        if (v.vmName) names.add(v.vmName);
      }
    }
  }
  return names;
}

/** Vault names are interpolated into commands; constrain their shape. */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Normalize a migrateVaults input (array, or a JSON-array string passed by a
 * workflow) into a validated string[]. Rejects any element that is not a safe
 * vault name, closing the shell-injection path and the string/array mismatch
 * between the workflow input and the method schema.
 */
export function normalizeMigrateVaults(input: string[] | string): string[] {
  let arr: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return [];
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `migrateVaults string must be a JSON array (e.g. '["gitlab"]'), ` +
          `got: ${trimmed}`,
      );
    }
  }
  if (!Array.isArray(arr)) {
    throw new Error("migrateVaults must be an array or a JSON-array string.");
  }
  return arr.map((v) => {
    if (typeof v !== "string" || !VAULT_NAME_RE.test(v)) {
      throw new Error(
        `Invalid vault name ${JSON.stringify(v)}: must be lowercase ` +
          `alphanumeric with hyphens or underscores.`,
      );
    }
    return v;
  });
}

/** Validate a hostname before it is interpolated into a remote shell command. */
export function assertHostname(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(value)) {
    throw new Error(
      `${label} "${value}" is not a valid hostname (lowercase alphanumeric, ` +
        `dots, hyphens). Refusing to interpolate it into a shell command.`,
    );
  }
  return value;
}

/** Validate a tailnet auth key before it is delivered to a remote host. */
export function assertTailnetAuthKey(key: string | undefined): string {
  if (!key || !/^tskey-[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(
      "tailnetAuthKey is missing or malformed: expected a value matching " +
        "tskey-[a-zA-Z0-9_-]+. Pass it as a vault expression, e.g. " +
        '${{ vault.get("tailscale", "AUTH_KEY") }}.',
    );
  }
  return key;
}

/** Resource lifetime defaults shared across this model's resources. */
const INFINITE = "infinite" as const;

/**
 * Build an idempotent remote command that ensures a server-access token named
 * `name` exists with a fresh secret, then copies its plaintext into
 * `vault`/`key`. If the token already exists (prior partial run), it is
 * rotated (revoke + re-mint, same name and principal) rather than minted, so a
 * re-run never fails on a duplicate name. The plaintext stays in the pipe.
 */
export function buildEnsureAccessTokenCmd(opts: {
  name: string;
  principal: string;
  duration: string;
  vault: string;
  key: string;
}): string {
  const { name, principal, duration, vault, key } = opts;
  const mintOrRotate = `if swamp access token list --json | jq -e ` +
    `'.[]?|select(.name=="${name}")' >/dev/null 2>&1; then ` +
    `swamp access token rotate ${name}; else ` +
    `swamp access token mint ${name} --principal ${principal} ` +
    `--duration ${duration}; fi`;
  return `${mintOrRotate} && ` +
    `swamp access token reveal ${name} --yes --json | jq -re .token | ` +
    `swamp vault put ${vault} ${key} --yes`;
}

/**
 * Build an idempotent remote command that ensures a worker-enrollment token
 * named `name` exists with a fresh secret, then copies it into `vault`/`key`.
 * Worker tokens have no rotate, so an existing one is revoked and re-created.
 */
export function buildEnsureWorkerTokenCmd(opts: {
  name: string;
  duration: string;
  maxEnrollments: number;
  vault: string;
  key: string;
}): string {
  const { name, duration, maxEnrollments, vault, key } = opts;
  const recreate = `if swamp worker token list --json | jq -e ` +
    `'.[]?|select(.name=="${name}")' >/dev/null 2>&1; then ` +
    `swamp worker token revoke ${name} || true; fi && ` +
    `swamp worker token create ${name} --duration ${duration} ` +
    `--max-enrollments ${maxEnrollments} --json | jq -re .token | ` +
    `swamp vault put ${vault} ${key} --yes`;
  return recreate;
}

// =============================================================================
// Model
// =============================================================================

export const model = {
  type: "@webframp/exe-dev/swamp-serve-fleet",
  version: "2026.11.05.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [],

  resources: {
    orchestrator: {
      description:
        "The provisioned `swamp serve` orchestrator: URLs, MagicDNS name, " +
        "serve flag set, and minted token names (never values).",
      schema: OrchestratorSchema,
      lifetime: INFINITE,
      garbageCollection: 10,
    },
    worker: {
      description: "An enrolled worker VM and its placement label.",
      schema: WorkerSchema,
      lifetime: INFINITE,
      garbageCollection: 40,
    },
    fleetStatus: {
      description: "Post-enrollment health check of the orchestrator + fleet.",
      schema: FleetStatusSchema,
      lifetime: INFINITE,
      garbageCollection: 10,
    },
    promotion: {
      description:
        "Result of promoting local data to the shared datastore and " +
        "migrating vaults.",
      schema: PromotionSchema,
      lifetime: INFINITE,
      garbageCollection: 10,
    },
    cutover: {
      description:
        "Result of claiming the datastore for serve (team mode) and " +
        "restarting serve.",
      schema: CutoverSchema,
      lifetime: INFINITE,
      garbageCollection: 10,
    },
  },

  methods: {
    // -----------------------------------------------------------------------
    provision_orchestrator: {
      description:
        "Create the orchestrator VM, join it to the tailnet, install the " +
        "pinned Deno + swamp, mint server/worker/dashboard tokens into " +
        "tokenVault, enable `swamp serve` as a user daemon with the " +
        "production flag set, expose it via `tailscale serve`, and open the " +
        "exe.dev HTTPS proxy. Records an `orchestrator` resource (token " +
        "names only).",
      arguments: z.object({
        cpu: z.number().int().min(1).default(2).describe(
          "Orchestrator VM CPU count.",
        ),
        memory: z.string().default("4GB").describe("Orchestrator VM memory."),
        disk: z.string().default("20GB").describe("Orchestrator VM disk."),
        tokenDuration: z
          .string()
          .regex(/^\d+[dhms]$/)
          .default("30d")
          .describe("Lifetime of minted tokens."),
        maxEnrollments: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Headroom on the worker-enrollment token."),
      }),
      execute: async (
        args: {
          cpu: number;
          memory: string;
          disk: string;
          tokenDuration: string;
          maxEnrollments: number;
        },
        ctx: ProvisionerContext,
      ) => {
        const g = ctx.globalArgs;
        assertVmName(g.orchestratorName);
        const started = Date.now();

        // 1. Create the orchestrator VM via the exe-dev/vm model, unless it
        //    already exists (idempotent re-run after a partial failure).
        const existingVms = await fetchExistingVmNames(ctx, g.exeToken);
        if (existingVms.has(g.orchestratorName)) {
          ctx.logger.info(
            "Orchestrator VM {name} already exists; skipping create.",
            { name: g.orchestratorName },
          );
        } else {
          const createRes = await ctx.runModel!({
            definition: `${g.orchestratorName}-vm`,
            modelType: "@webframp/exe-dev/vm",
            name: `${g.orchestratorName}-vm`,
            method: "create",
            arguments: {
              token: g.exeToken,
              name: g.orchestratorName,
              cpu: args.cpu,
              memory: args.memory,
              disk: args.disk,
              comment: "swamp serve orchestrator",
              tags: ["swamp-serve", "swamp-fleet"],
            },
          });
          if (!createRes.ok) {
            throw new Error(
              `Orchestrator VM create failed: ${createRes.error.message}`,
            );
          }
        }

        const sshHost = `${g.orchestratorName}.exe.xyz`;
        const httpsHost = sshHost;

        // 2. Join the tailnet (orchestrator: MagicDNS off — reaches serve via
        //    loopback). The auth key is delivered over stdin into TS_AUTHKEY so
        //    it never appears in argv or /proc. Then install Deno + swamp.
        const orchAuthKey = assertTailnetAuthKey(g.tailnetAuthKey);
        const tailnetUpOrch = await sshRunStdinEnv(
          sshHost,
          orchAuthKey,
          `curl -fsSL https://tailscale.com/install.sh | sh && ` +
            `sudo systemctl start tailscaled && ` +
            `export TS_AUTHKEY="$(cat)" && ` +
            `sudo --preserve-env=TS_AUTHKEY tailscale up ` +
            `--hostname="${g.orchestratorName}" --accept-dns=false`,
          120,
        );
        if (tailnetUpOrch.code !== 0) {
          throw new Error(
            `tailscale up (orchestrator) failed (exit ${tailnetUpOrch.code}): ` +
              `${
                redactSecrets(
                  (tailnetUpOrch.stderr || tailnetUpOrch.stdout).trim(),
                ) || "(no output)"
              }`,
          );
        }
        await sshRunChecked(
          sshHost,
          `set -o pipefail; ` +
            `curl -fsSL https://swamp-club.com/install.sh | sh 2>&1 | ` +
            `tail -c 100000`,
          120,
          "swamp install",
        );
        // Pin swamp's bundled Deno to the configured version so an extension's
        // ABI requirement is honored (denoVersion is otherwise only metadata).
        await sshRunChecked(
          sshHost,
          `"$HOME/.swamp/deno/deno" upgrade --version ${g.denoVersion}`,
          120,
          "pin deno version (orchestrator)",
        );

        // 3. Resolve the MagicDNS name if not supplied.
        let magicDnsName = g.magicDnsName ?? "";
        if (!magicDnsName) {
          const status = await sshRunChecked(
            sshHost,
            `tailscale status --json`,
            30,
            "tailscale status",
          );
          try {
            const parsed = JSON.parse(status) as {
              Self?: { DNSName?: string };
            };
            magicDnsName = (parsed.Self?.DNSName ?? "").replace(/\.$/, "");
          } catch { /* fall through to the explicit error below */ }
          if (!magicDnsName) {
            throw new Error(
              "Could not resolve the orchestrator MagicDNS name from " +
                "`tailscale status`. Pass magicDnsName explicitly.",
            );
          }
        }
        // Validate the resolved name (whether operator-supplied or read from
        // the VM) before it flows into serveUrl and the serve flag set.
        assertHostname(magicDnsName, "magicDnsName");

        const serveUrl = `wss://${magicDnsName}:${g.workerPort}`;
        const loopbackUrl = `ws://127.0.0.1:${g.loopbackPort}`;

        // 4. Mint tokens, then copy each plaintext into tokenVault via the
        //    reveal→put pipeline. `access token mint` and (serverless)
        //    `worker token create` store the secret in the `_token-secrets`
        //    control-plane vault, not a user vault — neither accepts a plain
        //    `--vault` here — so we reveal and `vault put` it under an explicit
        //    key. The plaintext stays in the pipe; only token names and vault
        //    keys are recorded. `enroll_worker` reads these keys back.
        const serverTokenName = `${g.orchestratorName}-worker`;
        const enrollTokenName = `${g.workerNamePrefix}s`;
        const dashboardTokenName = `dashboard-${g.orchestratorName}`;
        const serverTokenKey = `server-token-${serverTokenName}`;
        const enrollTokenKey = `enroll-token-${enrollTokenName}`;
        const dashboardTokenKey = `dashboard-token-${dashboardTokenName}`;

        await sshRunChecked(
          sshHost,
          buildEnsureAccessTokenCmd({
            name: serverTokenName,
            principal: g.adminPrincipal,
            duration: args.tokenDuration,
            vault: g.tokenVault,
            key: serverTokenKey,
          }),
          60,
          "mint + vault server access token",
        );
        await sshRunChecked(
          sshHost,
          buildEnsureWorkerTokenCmd({
            name: enrollTokenName,
            duration: args.tokenDuration,
            maxEnrollments: args.maxEnrollments,
            vault: g.tokenVault,
            key: enrollTokenKey,
          }),
          60,
          "create + vault worker enrollment token",
        );
        await sshRunChecked(
          sshHost,
          buildEnsureAccessTokenCmd({
            name: dashboardTokenName,
            principal: g.adminPrincipal,
            duration: args.tokenDuration,
            vault: g.tokenVault,
            key: dashboardTokenKey,
          }),
          60,
          "mint + vault dashboard token",
        );

        // 5. Enable the serve daemon with the production flag set.
        const serveFlags = buildServeFlags({
          loopbackPort: g.loopbackPort,
          adminPrincipal: g.adminPrincipal,
          magicDnsName,
          httpsHost,
          workerPort: g.workerPort,
          clubApiKeyPath: g.clubApiKeyPath,
        });
        await sshRunChecked(
          sshHost,
          `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && ` +
            `loginctl enable-linger "$USER" && ` +
            `swamp serve daemon enable --user ${serveFlags.join(" ")} && ` +
            `systemctl --user start swamp-serve.service`,
          120,
          "serve daemon enable",
        );

        // 6. Expose serve: tailscale serve for workers, exe proxy for browser.
        //    Keep the exe.dev proxy PRIVATE (set-private is idempotent) so the
        //    dashboard is never left publicly reachable by a prior state.
        await sshRunChecked(
          sshHost,
          `sudo tailscale serve --bg --https=${g.workerPort} ` +
            `http://127.0.0.1:${g.loopbackPort}`,
          60,
          "tailscale serve",
        );
        await sshRunChecked(
          sshHost,
          `ssh -o StrictHostKeyChecking=accept-new exe.dev ` +
            `share port ${g.orchestratorName} ${g.loopbackPort} && ` +
            `ssh -o StrictHostKeyChecking=accept-new exe.dev ` +
            `share set-private ${g.orchestratorName}`,
          60,
          "exe.dev share port (private)",
        );

        await ctx.writeResource("orchestrator", g.orchestratorName, {
          orchestratorName: g.orchestratorName,
          vmName: g.orchestratorName,
          sshHost,
          httpsUrl: `https://${httpsHost}/`,
          magicDnsName,
          serveUrl,
          loopbackUrl,
          loopbackPort: g.loopbackPort,
          workerPort: g.workerPort,
          adminPrincipal: g.adminPrincipal,
          serveFlags,
          tokenNames: {
            serverAccess: serverTokenName,
            workerEnrollment: enrollTokenName,
            dashboard: dashboardTokenName,
          },
          tokenVaultKeys: {
            serverAccess: serverTokenKey,
            workerEnrollment: enrollTokenKey,
            dashboard: dashboardTokenKey,
          },
          denoVersion: g.denoVersion,
          provisionedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          collectedBy: EXTENSION_NAME,
        });
      },
    },

    // -----------------------------------------------------------------------
    enroll_worker: {
      description:
        "Create and enroll `workerCount` worker VMs. Each VM joins the " +
        "tailnet (MagicDNS on), gets its own sandbox dir and token files " +
        "read from tokenVault, and runs `swamp worker daemon enable` with " +
        "the placement label. Records one `worker` resource per VM.",
      arguments: z.object({
        cpu: z.number().int().min(1).default(2).describe("Worker VM CPU."),
        memory: z.string().default("4GB").describe("Worker VM memory."),
        disk: z.string().default("20GB").describe("Worker VM disk."),
      }),
      execute: async (
        args: { cpu: number; memory: string; disk: string },
        ctx: ProvisionerContext,
      ) => {
        const g = ctx.globalArgs;

        const orch = (await ctx.readResource!(
          g.orchestratorName,
        )) as z.infer<typeof OrchestratorSchema> | null;
        if (!orch) {
          throw new Error(
            "No orchestrator state found. Run provision_orchestrator first.",
          );
        }

        const sandboxDir = `~/swamp-${g.workerNamePrefix}-worker`;

        // Sync the fleet once so the loop can skip VMs already created on a
        // prior partial run (create is not idempotent).
        const existingVms = await fetchExistingVmNames(ctx, g.exeToken);
        const workerAuthKey = assertTailnetAuthKey(g.tailnetAuthKey);

        for (let i = 1; i <= g.workerCount; i++) {
          const suffix = String(i).padStart(2, "0");
          const workerName = `${g.workerNamePrefix}-${suffix}`;
          assertVmName(workerName);

          if (existingVms.has(workerName)) {
            ctx.logger.info(
              "Worker VM {name} already exists; skipping create.",
              { name: workerName },
            );
          } else {
            const createRes = await ctx.runModel!({
              definition: `${workerName}-vm`,
              modelType: "@webframp/exe-dev/vm",
              name: `${workerName}-vm`,
              method: "create",
              arguments: {
                token: g.exeToken,
                name: workerName,
                cpu: args.cpu,
                memory: args.memory,
                disk: args.disk,
                comment: "swamp worker",
                tags: ["swamp-worker", "swamp-fleet"],
              },
            });
            if (!createRes.ok) {
              throw new Error(
                `Worker ${workerName} VM create failed: ${createRes.error.message}`,
              );
            }
          }

          const sshHost = `${workerName}.exe.xyz`;

          // Join tailnet with MagicDNS ON (workers must resolve the
          // orchestrator's .ts.net name). Auth key delivered over stdin into
          // TS_AUTHKEY so it never appears in argv or /proc. Then install deps.
          const tailnetUpWorker = await sshRunStdinEnv(
            sshHost,
            workerAuthKey,
            `curl -fsSL https://tailscale.com/install.sh | sh && ` +
              `sudo systemctl start tailscaled && ` +
              `export TS_AUTHKEY="$(cat)" && ` +
              `sudo --preserve-env=TS_AUTHKEY tailscale up ` +
              `--hostname="${workerName}" --accept-dns=true`,
            120,
          );
          if (tailnetUpWorker.code !== 0) {
            throw new Error(
              `tailscale up (${workerName}) failed ` +
                `(exit ${tailnetUpWorker.code}): ${
                  redactSecrets(
                    (tailnetUpWorker.stderr || tailnetUpWorker.stdout).trim(),
                  ) || "(no output)"
                }`,
            );
          }
          await sshRunChecked(
            sshHost,
            `set -o pipefail; ` +
              `curl -fsSL https://swamp-club.com/install.sh | sh 2>&1 | ` +
              `tail -c 100000`,
            120,
            `swamp install (${workerName})`,
          );
          // Pin swamp's bundled Deno to the configured version (see orchestrator).
          await sshRunChecked(
            sshHost,
            `"$HOME/.swamp/deno/deno" upgrade --version ${g.denoVersion}`,
            120,
            `pin deno version (${workerName})`,
          );

          // Deliver tokens WITHOUT the worker trusting the orchestrator: the
          // provisioner process (which has SSH to both hosts) reads each
          // token's plaintext from tokenVault on the orchestrator, then writes
          // it to the worker's cred file over stdin — never via argv, never
          // worker→orchestrator SSH.
          await sshRunChecked(
            sshHost,
            `mkdir -p ${sandboxDir}/cache ${sandboxDir}/creds && ` +
              `chmod 700 ${sandboxDir}/creds`,
            30,
            `sandbox dir (${workerName})`,
          );

          const enrollToken = await readVaultSecret(
            orch.sshHost,
            g.tokenVault,
            orch.tokenVaultKeys.workerEnrollment,
            `read enroll token for ${workerName}`,
          );
          await sshWriteSecretFile(
            sshHost,
            enrollToken,
            `${sandboxDir}/creds/enroll-token`,
            30,
            `write enroll token (${workerName})`,
          );

          const serverToken = await readVaultSecret(
            orch.sshHost,
            g.tokenVault,
            orch.tokenVaultKeys.serverAccess,
            `read server token for ${workerName}`,
          );
          await sshWriteSecretFile(
            sshHost,
            serverToken,
            `${sandboxDir}/creds/server-token`,
            30,
            `write server token (${workerName})`,
          );

          // Enable the worker daemon pointed at the tailscale-serve endpoint.
          await sshRunChecked(
            sshHost,
            `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && ` +
              `loginctl enable-linger "$USER" && ` +
              `swamp worker daemon enable --user ${orch.serveUrl} ` +
              `--token-file ${sandboxDir}/creds/enroll-token ` +
              `--server-token-file ${sandboxDir}/creds/server-token ` +
              `--cache-dir ${sandboxDir}/cache ` +
              `--label ${g.placementLabel} --label host=${workerName} && ` +
              `systemctl --user start swamp-worker.service`,
            120,
            `worker daemon enable (${workerName})`,
          );

          await ctx.writeResource("worker", workerName, {
            workerName,
            vmName: workerName,
            sshHost,
            placementLabel: g.placementLabel,
            enrollTokenName: orch.tokenNames.workerEnrollment,
            serverTokenName: orch.tokenNames.serverAccess,
            serveUrl: orch.serveUrl,
            sandboxDir,
            enrolledAt: new Date().toISOString(),
            collectedBy: EXTENSION_NAME,
          });
        }
      },
    },

    // -----------------------------------------------------------------------
    verify: {
      description:
        "Check orchestrator `/ready` and `swamp worker list`, recording a " +
        "`fleetStatus` resource. Healthy = /ready 200 and the enrolled " +
        "worker count matches workerCount.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ProvisionerContext,
      ) => {
        const g = ctx.globalArgs;
        const orch = (await ctx.readResource!(
          g.orchestratorName,
        )) as z.infer<typeof OrchestratorSchema> | null;
        if (!orch) {
          throw new Error(
            "No orchestrator state found. Run provision_orchestrator first.",
          );
        }

        const readyRes = await sshRun(
          orch.sshHost,
          `curl -s -o /dev/null -w '%{http_code}' ` +
            `http://127.0.0.1:${g.loopbackPort}/ready`,
          30,
        );
        const readyHttpCode = readyRes.stdout.trim() || "000";
        const orchestratorReady = readyHttpCode === "200";

        // Read the server token from the vault key provision stored it under,
        // asserting non-empty — an empty token would be silently ignored
        // (needs both URL and value), yielding a false negative.
        const serverToken = await readVaultSecret(
          orch.sshHost,
          g.tokenVault,
          orch.tokenVaultKeys.serverAccess,
          "read server token for verify",
        );
        const listOut = await sshRunStdinEnv(
          orch.sshHost,
          serverToken,
          `export SWAMP_SERVER_URL="${orch.loopbackUrl}" && ` +
            `export SWAMP_SERVER_TOKEN="$(cat)" && ` +
            `swamp worker list --server "$SWAMP_SERVER_URL" --json`,
          60,
        );
        let workerCount = 0;
        let parsedOk = false;
        try {
          const parsed = JSON.parse(listOut.stdout) as {
            workers?: unknown[];
            count?: number;
          };
          if (Array.isArray(parsed.workers)) {
            workerCount = typeof parsed.count === "number"
              ? parsed.count
              : parsed.workers.length;
            parsedOk = true;
          }
        } catch { /* parsedOk stays false; treated as unhealthy below */ }

        const healthy = orchestratorReady && parsedOk &&
          workerCount >= g.workerCount;

        await ctx.writeResource("fleetStatus", g.orchestratorName, {
          checkedAt: new Date().toISOString(),
          orchestratorReady,
          readyHttpCode,
          workerListOutput: redactSecrets(listOut.stdout.slice(0, 4000)),
          workerCount,
          expectedWorkerCount: g.workerCount,
          healthy,
          collectedBy: EXTENSION_NAME,
        });

        if (!healthy) {
          throw new Error(
            `Fleet not healthy: /ready=${readyHttpCode}, ` +
              `workers=${workerCount}/${g.workerCount}.`,
          );
        }
      },
    },

    // -----------------------------------------------------------------------
    promote: {
      description:
        "Move the operator's local swamp data into the shared datastore " +
        "(`swamp datastore setup extension <datastoreType>`) and migrate the " +
        "named vaults to a backend the orchestrator can read. Safe and " +
        "reversible; runs before the cutover approval gate.",
      arguments: z.object({
        migrateVaults: z
          .union([z.array(z.string()), z.string()])
          .default([])
          .describe(
            "Vault names to migrate to vaultType, as an array or a JSON-array " +
              "string (e.g. '[\"gitlab\"]' from a workflow input). Empty = " +
              "migrate none.",
          ),
        vaultType: z
          .string()
          .regex(/^@?[a-z0-9][a-z0-9./@-]*$/, {
            message:
              "vaultType must be a swamp vault extension name (lowercase " +
              "alphanumeric with ./@-); it is interpolated into a shell command.",
          })
          .optional()
          .describe(
            "Target vault backend, e.g. `@zts/aws-ssm`. Required if " +
              "migrateVaults is non-empty.",
          ),
        vaultConfig: z
          .string()
          .optional()
          .describe("JSON config forwarded to `swamp vault migrate --config`."),
      }),
      execute: async (
        args: {
          migrateVaults: string[] | string;
          vaultType?: string;
          vaultConfig?: string;
        },
        ctx: ProvisionerContext,
      ) => {
        const g = ctx.globalArgs;
        const migrateVaults = normalizeMigrateVaults(args.migrateVaults);
        if (migrateVaults.length > 0 && !args.vaultType) {
          throw new Error(
            "vaultType is required when migrateVaults is non-empty.",
          );
        }

        // Build commands as explicit argv (no `sh -c`): config blobs and
        // vault/type names are passed as individual arguments, never spliced
        // into a shell string, so none of them can inject a command.
        const setupArgv = [
          "swamp",
          "datastore",
          "setup",
          "extension",
          g.datastoreType,
        ];
        if (g.namespace) setupArgv.push("--namespace", g.namespace);
        setupArgv.push("--config", g.datastoreConfig);

        const setupOut = await runLocal(setupArgv, "datastore setup");

        const migrated: string[] = [];
        for (const vault of migrateVaults) {
          const migrateArgv = [
            "swamp",
            "vault",
            "migrate",
            vault,
            "--to-type",
            args.vaultType as string,
          ];
          if (args.vaultConfig) migrateArgv.push("--config", args.vaultConfig);
          migrateArgv.push("--force");
          await runLocal(migrateArgv, `vault migrate ${vault}`);
          migrated.push(vault);
        }

        await ctx.writeResource("promotion", g.orchestratorName, {
          promotedAt: new Date().toISOString(),
          datastoreType: g.datastoreType,
          namespace: g.namespace ?? null,
          datastoreSetupOutput: redactSecrets(setupOut.slice(0, 4000)),
          migratedVaults: migrated,
          dryRun: false,
          collectedBy: EXTENSION_NAME,
        });
      },
    },

    // -----------------------------------------------------------------------
    cutover: {
      description:
        "Hand datastore ownership to serve (team mode): set managedConfig, " +
        "run `swamp datastore claim --address <serveUrl>`, and restart serve " +
        "so it re-hydrates and reloads its vault registry. This is the one " +
        "irreversible step, so it defaults to dryRun=true; the bootstrap " +
        "workflow gates it behind an operator approval and passes dryRun=false.",
      arguments: z.object({
        dryRun: z
          .boolean()
          .default(true)
          .describe(
            "When true (default), print the commands without claiming. Pass " +
              "false to perform the claim and restart serve.",
          ),
      }),
      execute: async (args: { dryRun: boolean }, ctx: ProvisionerContext) => {
        const g = ctx.globalArgs;
        const orch = (await ctx.readResource!(
          g.orchestratorName,
        )) as z.infer<typeof OrchestratorSchema> | null;
        if (!orch) {
          throw new Error(
            "No orchestrator state found. Run provision_orchestrator first.",
          );
        }

        const claimAddress = orch.httpsUrl.replace(/\/$/, "");
        let managedConfigOutput = "";
        let claimOutput = "";
        let serveRestarted = false;
        let restartError: string | undefined;

        if (args.dryRun) {
          managedConfigOutput = "DRY RUN: swamp datastore config migrate";
          claimOutput =
            `DRY RUN: swamp datastore claim --address ${claimAddress}`;
        } else {
          managedConfigOutput = redactSecrets(
            (await runLocal(
              ["swamp", "datastore", "config", "migrate"],
              "datastore config migrate",
            )).slice(0, 2000),
          );
          // `claim` is the irreversible step. On a re-run after a partial
          // failure the store may already be claimed; tolerate that instead of
          // failing the whole method so the restart can still be retried.
          const claimRes = await runLocalResult(
            ["swamp", "datastore", "claim", "--address", claimAddress],
          );
          claimOutput = redactSecrets(
            (claimRes.stdout + claimRes.stderr).slice(0, 2000),
          );
          if (claimRes.code !== 0 && !/already\s+claim/i.test(claimOutput)) {
            throw new Error(`datastore claim failed: ${claimOutput}`);
          }
          // Restart serve so it re-hydrates and reloads the vault registry.
          // A restart failure must NOT lose the cutover record: the datastore
          // is already claimed, so persist the resource with
          // serveRestarted=false and an error the operator can act on.
          try {
            await sshRunChecked(
              orch.sshHost,
              `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && ` +
                `systemctl --user restart swamp-serve.service`,
              120,
              "restart serve",
            );
            serveRestarted = true;
          } catch (err) {
            restartError = redactSecrets(
              err instanceof Error ? err.message : String(err),
            );
            ctx.logger.warn(
              "Datastore is claimed but the serve restart failed: {error}. " +
                "Restart serve manually: systemctl --user restart " +
                "swamp-serve.service",
              { error: restartError },
            );
          }
        }

        await ctx.writeResource("cutover", g.orchestratorName, {
          cutoverAt: new Date().toISOString(),
          serveUrl: claimAddress,
          managedConfigOutput,
          claimOutput,
          serveRestarted,
          restartError: restartError ?? null,
          dryRun: args.dryRun,
          collectedBy: EXTENSION_NAME,
        });
      },
    },

    // -----------------------------------------------------------------------
    teardown: {
      description:
        "Stop the serve and worker daemons and, when dryRun=false, destroy " +
        "the VMs via @webframp/exe-dev/vm. Defaults to dryRun=true.",
      arguments: z.object({
        dryRun: z
          .boolean()
          .default(true)
          .describe("When false, stop daemons and destroy the VMs."),
        destroyVms: z
          .boolean()
          .default(false)
          .describe("When true (and dryRun=false), also destroy the VMs."),
      }),
      execute: async (
        args: { dryRun: boolean; destroyVms: boolean },
        ctx: ProvisionerContext,
      ) => {
        const g = ctx.globalArgs;
        const orch = (await ctx.readResource!(
          g.orchestratorName,
        )) as z.infer<typeof OrchestratorSchema> | null;
        if (!orch) {
          throw new Error("No orchestrator state found; nothing to tear down.");
        }
        if (args.dryRun) {
          ctx.logger.info(
            "DRY RUN teardown: would stop daemons on orchestrator and " +
              "{count} workers{destroy}.",
            {
              count: g.workerCount,
              destroy: args.destroyVms ? " and destroy all VMs" : "",
            },
          );
          return;
        }

        await sshRun(
          orch.sshHost,
          `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && ` +
            `systemctl --user stop swamp-serve.service`,
          60,
        );
        for (let i = 1; i <= g.workerCount; i++) {
          const workerName = `${g.workerNamePrefix}-${
            String(i).padStart(2, "0")
          }`;
          await sshRun(
            `${workerName}.exe.xyz`,
            `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && ` +
              `systemctl --user stop swamp-worker.service`,
            60,
          );
          if (args.destroyVms) {
            await ctx.runModel!({
              definition: `${workerName}-vm`,
              method: "destroy",
              arguments: { token: g.exeToken, name: workerName },
            });
          }
        }
        if (args.destroyVms) {
          await ctx.runModel!({
            definition: `${g.orchestratorName}-vm`,
            method: "destroy",
            arguments: { token: g.exeToken, name: g.orchestratorName },
          });
        }
      },
    },
  },
};

// =============================================================================
// Local command helper + context type
// =============================================================================

/** Run a command on the operator's workstation (datastore/vault operations). */
async function runLocal(args: string[], label: string): Promise<string> {
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const dec = new TextDecoder();
  if (!out.success) {
    throw new Error(
      `${label} failed (exit ${out.code}): ` +
        `${redactSecrets(dec.decode(out.stderr).trim()) || "(no output)"}`,
    );
  }
  return dec.decode(out.stdout);
}

/**
 * Run a local command and return its exit code and output without throwing, so
 * the caller can treat a non-zero exit as data (e.g. an already-claimed
 * datastore on a cutover re-run).
 */
async function runLocalResult(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

interface ProvisionerContext {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  queryData?: (
    predicate: string,
  ) => Promise<Array<{ content?: unknown }>>;
  runModel?: (opts: {
    definition?: string;
    modelType?: string;
    name?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<
    | { ok: true; resources: Array<{ name: string }> }
    | { ok: false; error: { message: string; stack?: string } }
  >;
}
