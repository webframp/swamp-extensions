/**
 * Nix shell execution driver for swamp.
 *
 * Runs model methods inside `nix shell` with declarative package
 * dependencies. Provides reproducible execution environments without
 * containers — packages are pulled from nixpkgs and cached in the
 * nix store.
 *
 * Supports two execution modes:
 * - **Command mode**: when methodArgs.run is a string, runs the command
 *   inside a nix shell. Stdout becomes resource data, stderr streams as logs.
 * - **Bundle mode**: when request.bundle exists, writes it to a temp file
 *   and runs it with deno inside the nix shell.
 */

const SIGKILL_GRACE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

interface NixDriverConfig {
  /** Nix packages to make available (e.g. ["dig", "whois", "openssl"]) */
  packages: string[];
  /** Flake reference for packages (default: "nixpkgs") */
  flakeRef?: string;
  /** Pin to a specific nixpkgs revision for reproducibility */
  nixpkgsRev?: string;
  /** Timeout in milliseconds (default: 300000) */
  timeout?: number;
  /** Pass --impure to nix shell (default: true) */
  impure?: boolean;
  /** Additional nix flags */
  extraArgs?: string[];
}

function parseConfig(raw?: Record<string, unknown>): NixDriverConfig {
  const config = (raw ?? {}) as unknown as Partial<NixDriverConfig>;
  if (!config.packages || !Array.isArray(config.packages)) {
    throw new Error(
      'Nix driver requires \'packages\' array in config (e.g. ["dig", "whois"])',
    );
  }
  if (config.packages.length === 0) {
    throw new Error("Nix driver requires at least one package");
  }
  return {
    packages: config.packages,
    flakeRef: config.flakeRef ?? "nixpkgs",
    nixpkgsRev: config.nixpkgsRev,
    timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    impure: config.impure ?? true,
    extraArgs: config.extraArgs ?? [],
  };
}

function buildFlakeRef(config: NixDriverConfig): string {
  if (config.nixpkgsRev) {
    return `github:NixOS/nixpkgs/${config.nixpkgsRev}`;
  }
  return config.flakeRef!;
}

function buildNixArgs(
  config: NixDriverConfig,
  command: string[],
): string[] {
  const ref = buildFlakeRef(config);
  const pkgRefs = config.packages.map((p) => `${ref}#${p}`);

  const args = ["shell", ...pkgRefs];
  if (config.impure) {
    args.push("--impure");
  }
  for (const extra of config.extraArgs!) {
    args.push(extra);
  }
  args.push("--command", ...command);
  return args;
}

async function streamOutput(
  reader: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = "";

  for await (const chunk of reader) {
    const text = decoder.decode(chunk, { stream: true });
    buffer += text;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      chunks.push(line);
      onLine?.(line);
    }
  }

  // Flush remaining buffer
  const tail = buffer + decoder.decode();
  if (tail) {
    chunks.push(tail);
    onLine?.(tail);
  }

  return chunks.join("\n");
}

interface ExecutionRequest {
  protocolVersion: number;
  modelType: string;
  modelId: string;
  methodName: string;
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  definitionMeta: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  bundle?: Uint8Array;
  traceHeaders?: Record<string, string>;
}

interface ExecutionCallbacks {
  onLog?: (line: string) => void;
}

interface DriverOutput {
  kind: "pending";
  specName: string;
  name: string;
  type: "resource" | "file";
  content: Uint8Array;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

interface ExecutionResult {
  status: "success" | "error";
  error?: string;
  outputs: DriverOutput[];
  logs: string[];
  durationMs: number;
}

async function executeCommand(
  config: NixDriverConfig,
  request: ExecutionRequest,
  callbacks?: ExecutionCallbacks,
): Promise<ExecutionResult> {
  const start = performance.now();
  const logs: string[] = [];
  const run = request.methodArgs.run as string;

  const nixArgs = buildNixArgs(config, ["sh", "-c", run]);

  callbacks?.onLog?.(`[nix] Running command in nix shell: ${run}`);
  callbacks?.onLog?.(
    `[nix] Packages: ${config.packages.join(", ")}`,
  );
  if (config.nixpkgsRev) {
    callbacks?.onLog?.(`[nix] Pinned to nixpkgs rev: ${config.nixpkgsRev}`);
  }

  let killTimeoutId: number | undefined;

  try {
    const command = new Deno.Command("nix", {
      args: nixArgs,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();
    let timedOut = false;
    let timeoutId: number | undefined;

    if (config.timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
        killTimeoutId = setTimeout(() => {
          try {
            process.kill("SIGKILL");
          } catch {
            // Process may have already exited
          }
        }, SIGKILL_GRACE_MS);
      }, config.timeout);
    }

    try {
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamOutput(process.stdout),
        streamOutput(process.stderr, (line) => {
          logs.push(line);
          callbacks?.onLog?.(line);
        }),
        process.status,
      ]);

      const durationMs = Math.round(performance.now() - start);

      if (timedOut) {
        return {
          status: "error",
          error: `Nix shell command timed out after ${config.timeout}ms`,
          outputs: [],
          logs,
          durationMs,
        };
      }

      if (status.code !== 0) {
        return {
          status: "error",
          error: stderrResult ||
            `Nix shell exited with code ${status.code}`,
          outputs: [],
          logs,
          durationMs,
        };
      }

      const specName = request.resourceSpecs
        ? Object.keys(request.resourceSpecs)[0] ?? request.methodName
        : request.methodName;

      const outputs: DriverOutput[] = [{
        kind: "pending",
        specName,
        name: specName,
        type: "resource",
        content: new TextEncoder().encode(stdoutResult),
        metadata: {
          exitCode: status.code,
          command: run,
          durationMs,
          packages: config.packages,
          nixpkgsRev: config.nixpkgsRev ?? null,
        },
      }];

      const fileSpecNames = request.fileSpecs
        ? Object.keys(request.fileSpecs)
        : [];
      if (fileSpecNames.length > 0) {
        const logParts: string[] = [];
        if (stdoutResult) logParts.push(`[stdout]\n${stdoutResult}`);
        if (stderrResult) logParts.push(`[stderr]\n${stderrResult}`);
        outputs.push({
          kind: "pending",
          specName: fileSpecNames[0],
          name: fileSpecNames[0],
          type: "file",
          content: new TextEncoder().encode(logParts.join("\n")),
        });
      }

      callbacks?.onLog?.(`[nix] Completed in ${durationMs}ms`);

      return { status: "success", outputs, logs, durationMs };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (killTimeoutId !== undefined) clearTimeout(killTimeoutId);
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      outputs: [],
      logs,
      durationMs,
    };
  }
}

async function executeBundle(
  config: NixDriverConfig,
  request: ExecutionRequest,
  callbacks?: ExecutionCallbacks,
): Promise<ExecutionResult> {
  const start = performance.now();
  const logs: string[] = [];
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-nix-" });
  let killTimeoutId: number | undefined;

  try {
    const bundlePath = `${tmpDir}/bundle.js`;
    const requestPath = `${tmpDir}/request.json`;

    await Deno.writeFile(bundlePath, request.bundle!);

    const requestData = {
      protocolVersion: request.protocolVersion,
      modelType: request.modelType,
      modelId: request.modelId,
      methodName: request.methodName,
      globalArgs: request.globalArgs,
      methodArgs: request.methodArgs,
      definitionMeta: request.definitionMeta,
      resourceSpecs: request.resourceSpecs ?? {},
      fileSpecs: request.fileSpecs ?? {},
      traceHeaders: request.traceHeaders ?? {},
    };
    await Deno.writeTextFile(requestPath, JSON.stringify(requestData));

    callbacks?.onLog?.(
      `[nix] Running bundle for ${request.modelType}::${request.methodName}`,
    );
    callbacks?.onLog?.(
      `[nix] Packages: ${config.packages.join(", ")}`,
    );

    // Run deno with the bundle inside nix shell
    const nixArgs = buildNixArgs(config, [
      "deno",
      "run",
      "--allow-all",
      bundlePath,
    ]);

    const command = new Deno.Command("nix", {
      args: nixArgs,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Object.fromEntries(
          Object.entries(Deno.env.toObject()).filter(([k]) =>
            k.startsWith("AWS_") || k.startsWith("SWAMP_") ||
            k === "HOME" || k === "PATH" || k === "USER" ||
            k === "DENO_DIR"
          ),
        ),
        SWAMP_DRIVER_REQUEST: requestPath,
      },
    });

    const process = command.spawn();
    let timedOut = false;
    let timeoutId: number | undefined;

    if (config.timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          process.kill("SIGTERM");
        } catch { /* already exited */ }
        killTimeoutId = setTimeout(() => {
          try {
            process.kill("SIGKILL");
          } catch { /* already exited */ }
        }, SIGKILL_GRACE_MS);
      }, config.timeout);
    }

    try {
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamOutput(process.stdout),
        streamOutput(process.stderr, (line) => {
          logs.push(line);
          callbacks?.onLog?.(line);
        }),
        process.status,
      ]);

      const durationMs = Math.round(performance.now() - start);

      if (timedOut) {
        return {
          status: "error",
          error: `Nix bundle execution timed out after ${config.timeout}ms`,
          outputs: [],
          logs,
          durationMs,
        };
      }

      if (status.code !== 0) {
        return {
          status: "error",
          error: stderrResult ||
            `Nix bundle exited with code ${status.code}`,
          outputs: [],
          logs,
          durationMs,
        };
      }

      // Parse structured output from bundle runner
      const outputs: DriverOutput[] = [];
      try {
        const parsed = JSON.parse(stdoutResult);
        if (Array.isArray(parsed.outputs)) {
          for (const out of parsed.outputs) {
            outputs.push({
              kind: "pending",
              specName: out.specName ?? request.methodName,
              name: out.name ?? out.specName ?? request.methodName,
              type: out.type ?? "resource",
              content: new TextEncoder().encode(
                typeof out.content === "string"
                  ? out.content
                  : JSON.stringify(out.content),
              ),
              tags: out.tags,
              metadata: out.metadata,
            });
          }
        }
      } catch {
        // Non-JSON stdout: treat entire output as resource
        outputs.push({
          kind: "pending",
          specName: request.methodName,
          name: request.methodName,
          type: "resource",
          content: new TextEncoder().encode(stdoutResult),
          metadata: {
            packages: config.packages,
            nixpkgsRev: config.nixpkgsRev ?? null,
          },
        });
      }

      callbacks?.onLog?.(`[nix] Bundle completed in ${durationMs}ms`);

      return { status: "success", outputs, logs, durationMs };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (killTimeoutId !== undefined) clearTimeout(killTimeoutId);
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      outputs: [],
      logs,
      durationMs,
    };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

export const driver = {
  type: "@webframp/nix",
  name: "Nix Shell",
  description:
    "Runs model methods inside a nix shell with declarative package dependencies. Supports pinning to a specific nixpkgs revision for full reproducibility.",

  createDriver: (config?: Record<string, unknown>) => {
    const parsed = parseConfig(config);
    return {
      type: "@webframp/nix",

      execute(
        request: ExecutionRequest,
        callbacks?: ExecutionCallbacks,
      ): Promise<ExecutionResult> {
        const hasBundle = request.bundle !== undefined &&
          request.bundle.length > 0;
        const hasRunCommand = typeof request.methodArgs.run === "string" &&
          (request.methodArgs.run as string).trim() !== "";

        if (hasBundle) {
          return executeBundle(parsed, request, callbacks);
        } else if (hasRunCommand) {
          return executeCommand(parsed, request, callbacks);
        } else {
          return Promise.resolve({
            status: "error" as const,
            error:
              "Nix driver requires either a bundle or a 'run' string in methodArgs",
            outputs: [],
            logs: [],
            durationMs: 0,
          });
        }
      },
    };
  },
};
