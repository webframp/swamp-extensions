// ABOUTME: Optional sync-phase tracing for diagnosing slow PostgreSQL syncs.
// ABOUTME: Enabled via SWAMP_PG_SYNC_TRACE=1 env var.

export interface TraceEvent {
  operation: string;
  phase: string;
  durationMs: number;
  details?: Record<string, number | string>;
}

export interface Tracer {
  phase(operation: string, phase: string, durationMs: number): void;
  summary(
    operation: string,
    durationMs: number,
    details?: Record<string, number | string>,
  ): void;
  startTimer(operation: string, phase: string): () => void;
  formatEvent(event: TraceEvent): string;
}

interface TracerOptions {
  enabled: boolean;
  sink?: (event: TraceEvent) => void;
}

function defaultSink(event: TraceEvent): void {
  const line = formatEventInternal(event);
  console.error(line);
}

function formatEventInternal(event: TraceEvent): string {
  let line = `[pg-sync] ${event.operation}.${event.phase} ${event.durationMs}ms`;
  if (event.details) {
    const parts = Object.entries(event.details).map(
      ([k, v]) => `${k}=${v}`,
    );
    line += ` (${parts.join(", ")})`;
  }
  return line;
}

export function createTracer(options: TracerOptions): Tracer {
  const sink = options.sink ?? defaultSink;
  const enabled = options.enabled;

  return {
    phase(operation: string, phase: string, durationMs: number): void {
      if (!enabled) return;
      sink({ operation, phase, durationMs });
    },

    summary(
      operation: string,
      durationMs: number,
      details?: Record<string, number | string>,
    ): void {
      if (!enabled) return;
      sink({ operation, phase: "complete", durationMs, details });
    },

    startTimer(operation: string, phase: string): () => void {
      if (!enabled) return () => {};
      const start = performance.now();
      return () => {
        const elapsed = Math.round(performance.now() - start);
        sink({ operation, phase, durationMs: elapsed });
      };
    },

    formatEvent: formatEventInternal,
  };
}

export function tracerFromEnv(): Tracer {
  let enabled = false;
  try {
    enabled = Deno.env.get("SWAMP_PG_SYNC_TRACE") === "1";
  } catch {
    // Permission denied — tracing disabled
  }
  return createTracer({ enabled });
}
