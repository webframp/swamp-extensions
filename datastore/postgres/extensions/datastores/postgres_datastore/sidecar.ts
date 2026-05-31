// ABOUTME: Local-only sync-state sidecar for per-path dirty tracking.
// ABOUTME: Tracks pending local changes until pushed; DB holds team-global watermark.

const SIDECAR_FILENAME = ".datastore-sync-state.json";
const SCHEMA_VERSION = 1;
const DIRTY_PATHS_CAP = 200;

export interface SidecarState {
  version: number;
  dirtyPaths: string[];
  bulkInvalidated: boolean;
  lastPulledAt: string | null;
  lazyPullActive: boolean;
}

function emptyState(): SidecarState {
  return {
    version: SCHEMA_VERSION,
    dirtyPaths: [],
    bulkInvalidated: false,
    lastPulledAt: null,
    lazyPullActive: false,
  };
}

function sidecarPath(cachePath: string): string {
  return `${cachePath}/${SIDECAR_FILENAME}`;
}

function isTraversal(p: string): boolean {
  return p.split("/").some((s) => s === "..");
}

async function readState(cachePath: string): Promise<SidecarState> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(sidecarPath(cachePath));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { ...emptyState(), bulkInvalidated: true };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...emptyState(), bulkInvalidated: true };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...emptyState(), bulkInvalidated: true };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== SCHEMA_VERSION) {
    return { ...emptyState(), bulkInvalidated: true };
  }
  return {
    version: SCHEMA_VERSION,
    dirtyPaths: Array.isArray(obj.dirtyPaths)
      ? (obj.dirtyPaths as unknown[]).filter(
        (x) => typeof x === "string" && !isTraversal(x as string),
      ) as string[]
      : [],
    bulkInvalidated: obj.bulkInvalidated === true,
    lastPulledAt: typeof obj.lastPulledAt === "string"
      ? obj.lastPulledAt
      : null,
    lazyPullActive: obj.lazyPullActive === true,
  };
}

async function writeState(
  cachePath: string,
  state: SidecarState,
): Promise<void> {
  await Deno.mkdir(cachePath, { recursive: true });
  const path = sidecarPath(cachePath);
  const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, JSON.stringify(state));
  await Deno.rename(tmp, path);
}

/**
 * Serialized sidecar for sync state mutations.
 * Concurrent calls within one process are serialized via a Promise chain.
 * Cross-process serialization is the distributed lock's job.
 */
export class Sidecar {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cachePath: string) {}

  read(): Promise<SidecarState> {
    return readState(this.cachePath);
  }

  update(
    mutator: (state: SidecarState) => SidecarState | void,
  ): Promise<SidecarState> {
    const next = this.chain.then(async () => {
      const current = await readState(this.cachePath);
      const result = mutator(current) ?? current;
      await writeState(this.cachePath, result);
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  recordDirty(relPath: string | undefined): Promise<SidecarState> {
    return this.update((state) => {
      if (relPath === undefined) {
        state.bulkInvalidated = true;
      } else if (!isTraversal(relPath) && !state.dirtyPaths.includes(relPath)) {
        if (state.dirtyPaths.length >= DIRTY_PATHS_CAP) {
          state.bulkInvalidated = true;
        } else {
          state.dirtyPaths.push(relPath);
        }
      }
    });
  }

  clearDirty(): Promise<SidecarState> {
    return this.update((state) => {
      state.dirtyPaths = [];
      state.bulkInvalidated = false;
    });
  }

  setLastPulledAt(iso: string): Promise<SidecarState> {
    return this.update((state) => {
      state.lastPulledAt = iso;
    });
  }

  setLazyPullActive(active: boolean): Promise<SidecarState> {
    return this.update((state) => {
      state.lazyPullActive = active;
    });
  }
}
