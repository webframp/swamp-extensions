/**
 * Dry-run execution driver for swamp.
 *
 * Captures the full execution request without running the method,
 * returning it as a pending resource for inspection. Useful for
 * debugging workflows, auditing method arguments, and validating
 * pipeline configuration before hitting real APIs.
 *
 * @module
 */

/** Request envelope passed to the driver's execute method. */
export interface DryRunRequest {
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

/** Optional callbacks provided during driver execution. */
export interface DryRunCallbacks {
  onLog?: (line: string) => void;
}

/** A single pending output produced by the dry-run capture. */
export interface DryRunOutput {
  kind: "pending";
  specName: string;
  name: string;
  type: "resource";
  content: Uint8Array;
  tags: Record<string, string>;
}

/** Result returned after a dry-run execution completes. */
export interface DryRunResult {
  status: "success";
  outputs: DryRunOutput[];
  logs: string[];
  durationMs: number;
}

/**
 * The dry-run execution driver definition.
 *
 * Exposes {@linkcode driver.createDriver} to instantiate a driver that
 * captures method execution requests as pending resources without
 * performing any real work.
 */
export const driver = {
  type: "@webframp/dry-run",
  name: "Dry Run",
  description:
    "Captures method execution requests without running them. Returns the request envelope as a resource for debugging and auditing.",

  createDriver: (_config?: Record<string, unknown>): {
    type: string;
    execute: (
      request: DryRunRequest,
      callbacks?: DryRunCallbacks,
    ) => Promise<DryRunResult>;
  } => ({
    type: "@webframp/dry-run",

    execute(
      request: DryRunRequest,
      callbacks?: DryRunCallbacks,
    ): Promise<DryRunResult> {
      const start = performance.now();
      const log = callbacks?.onLog ?? (() => {});

      log(
        `[dry-run] Captured request for ${request.modelType}::${request.methodName}`,
      );
      log(
        `[dry-run] Model: ${request.definitionMeta.name} (v${request.definitionMeta.version})`,
      );
      log(
        `[dry-run] Global args: ${JSON.stringify(request.globalArgs)}`,
      );
      log(
        `[dry-run] Method args: ${JSON.stringify(request.methodArgs)}`,
      );

      if (request.resourceSpecs) {
        const specNames = Object.keys(request.resourceSpecs);
        log(`[dry-run] Resource specs: ${specNames.join(", ")}`);
      }

      if (request.fileSpecs) {
        const fileNames = Object.keys(request.fileSpecs);
        log(`[dry-run] File specs: ${fileNames.join(", ")}`);
      }

      if (request.bundle) {
        log(`[dry-run] Bundle size: ${request.bundle.byteLength} bytes`);
      }

      if (request.traceHeaders) {
        log(
          `[dry-run] Trace headers: ${JSON.stringify(request.traceHeaders)}`,
        );
      }

      const capture = {
        capturedAt: new Date().toISOString(),
        driver: "@webframp/dry-run",
        protocolVersion: request.protocolVersion,
        modelType: request.modelType,
        modelId: request.modelId,
        methodName: request.methodName,
        definitionMeta: request.definitionMeta,
        globalArgs: request.globalArgs,
        methodArgs: request.methodArgs,
        hasBundle: request.bundle !== undefined,
        bundleSize: request.bundle?.byteLength ?? 0,
        resourceSpecs: request.resourceSpecs ?? {},
        fileSpecs: request.fileSpecs ?? {},
        traceHeaders: request.traceHeaders ?? {},
      };

      const content = new TextEncoder().encode(
        JSON.stringify(capture, null, 2),
      );

      const durationMs = Math.round(performance.now() - start);
      log(`[dry-run] Completed in ${durationMs}ms (no execution performed)`);

      return Promise.resolve({
        status: "success" as const,
        outputs: [
          {
            kind: "pending" as const,
            specName: "dry_run_capture",
            name: `dry-run-${request.methodName}`,
            type: "resource" as const,
            content,
            tags: {
              modelType: request.modelType,
              methodName: request.methodName,
            },
          },
        ],
        logs: [] as string[],
        durationMs,
      });
    },
  }),
};
