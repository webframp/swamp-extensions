/**
 * GitLab Datastore Extension
 *
 * Stores swamp runtime data in GitLab using the Terraform state HTTP API.
 * Provides distributed locking via GitLab's native state locking mechanism
 * and bidirectional sync between a local cache and GitLab-hosted state.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { Attr, recordRetry, withSpan } from "./_lib/tracing.ts";
import { SpanStatusCode } from "npm:@opentelemetry/api@1.9.0";

/**
 * Domain interfaces mirrored from swamp core.
 * Extensions must be self-contained — they cannot import from swamp internals.
 */

interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
}

interface LockOptions {
  lockKey?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

/** Domain-level sync context for scoped operations. */
interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

declare const PushManifestBrand: unique symbol;
/** Opaque branded type for push manifests — keeps phase internals hidden from callers. */
export type PushManifest = { readonly [PushManifestBrand]: true };

/** Internal manifest structure — cast to/from PushManifest via `as unknown`. */
interface InternalPushManifest {
  entries: Array<{ relPath: string; hash: string; content: Uint8Array }>;
  syncState: SyncState;
  processedDirtyPaths: Set<string>;
}

/** Capabilities a sync service advertises to swamp core. */
interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  twoPhaseSync?: boolean;
}

/** Options accepted by sync service methods. */
interface DatastoreSyncOptions {
  signal?: AbortSignal;
  relPath?: string;
  context?: SyncContext;
  metadataOnly?: boolean;
}

interface DatastoreSyncService {
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  capabilities?(): SyncCapabilities;
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;
}

/** Two-phase sync protocol: collect diff outside the lock, then commit under lock. */
export interface TwoPhaseSyncService extends DatastoreSyncService {
  preparePush(options?: DatastoreSyncOptions): Promise<PushManifest>;
  commitPush(
    manifest: PushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
}

/**
 * Terraform state envelope for wrapping arbitrary data.
 * GitLab's Terraform state API requires valid state JSON format.
 */
interface TerraformState {
  version: number;
  terraform_version: string;
  serial: number;
  lineage: string;
  outputs: Record<string, unknown>;
  resources: Array<{
    type: string;
    name: string;
    provider: string;
    instances: Array<{
      attributes: Record<string, unknown>;
    }>;
  }>;
}

/**
 * Wrap raw content in a Terraform state envelope.
 * Uses chunked base64 encoding to avoid stack overflow on large files.
 */
function wrapInTerraformState(
  content: Uint8Array,
  serial: number = 1,
  lineage?: string,
): string {
  // Chunked base64 encoding to avoid call stack overflow from spread operator
  const CHUNK_SIZE = 8192;
  let base64Content = "";
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    const chunk = content.subarray(i, i + CHUNK_SIZE);
    base64Content += String.fromCharCode(...chunk);
  }
  base64Content = btoa(base64Content);

  const state: TerraformState = {
    version: 4,
    terraform_version: "1.0.0",
    serial,
    lineage: lineage ?? crypto.randomUUID(),
    outputs: {},
    resources: [
      {
        type: "swamp_data",
        name: "content",
        provider: 'provider["swamp.club/swamp/data"]',
        instances: [
          {
            attributes: {
              data: base64Content,
            },
          },
        ],
      },
    ],
  };
  return JSON.stringify(state);
}

/**
 * Unwrap content from a Terraform state envelope.
 * Returns null if the state is not a swamp data state (e.g., lock states).
 */
function unwrapFromTerraformState(stateJson: string): Uint8Array | null {
  try {
    const state = JSON.parse(stateJson) as TerraformState;
    const resource = state.resources?.find((r) => r.type === "swamp_data");
    if (!resource?.instances?.[0]?.attributes?.data) {
      // Not a swamp data state (could be a lock state or other)
      return null;
    }
    const base64Content = resource.instances[0].attributes.data as string;
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch {
    // Invalid JSON or structure
    return null;
  }
}

/**
 * Extract serial number from state for incrementing
 */
function getStateSerial(stateJson: string): number {
  try {
    const state = JSON.parse(stateJson) as TerraformState;
    return state.serial ?? 0;
  } catch {
    return 0;
  }
}

/**
 * GitLab Terraform State API client
 */
class GitLabStateClient {
  private readonly baseUrl: string;
  private readonly token: string;
  /** Host only — the full URL embeds the encoded state name. */
  private readonly serverAddress: string;

  constructor(
    private readonly config: {
      baseUrl: string;
      projectId: string;
      token: string;
      username?: string;
    },
  ) {
    this.baseUrl = `${config.baseUrl}/api/v4/projects/${
      encodeURIComponent(config.projectId)
    }/terraform/state`;
    this.token = config.token;
    let host = config.baseUrl;
    try {
      host = new URL(config.baseUrl).host;
    } catch {
      // Non-absolute base URL (only reachable in tests) — record it verbatim.
    }
    this.serverAddress = host;
  }

  private headers(): Record<string, string> {
    return {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    };
  }

  /**
   * Single choke point for every GitLab API call, so each round trip emits
   * exactly one span.
   *
   * `op` is passed in rather than derived from the URL because several
   * operations hit the same endpoint with different methods, and because the
   * URL embeds the encoded state name. Request headers carry a PRIVATE-TOKEN
   * and request bodies carry file content — neither is ever recorded.
   *
   * `expected` lists non-2xx statuses that are normal control flow for the
   * caller — a 404 meaning "no such state", a 409 meaning "already locked".
   * Anything else marks the span as an error, because this client inspects
   * `response.status` by hand instead of throwing, so without this the span
   * would report success on a 500.
   */
  private request(
    op: string,
    url: string,
    init: RequestInit,
    opts?: { stateName?: string; expected?: number[] },
  ): Promise<Response> {
    return withSpan(`GitLab ${op}`, {
      [Attr.RPC_SYSTEM]: "http",
      [Attr.RPC_SERVICE]: "GitLab",
      [Attr.RPC_METHOD]: op,
      [Attr.HTTP_REQUEST_METHOD]: init.method ?? "GET",
      [Attr.GITLAB_PROJECT_ID]: this.config.projectId,
      [Attr.SERVER_ADDRESS]: this.serverAddress,
      ...(opts?.stateName ? { [Attr.GITLAB_STATE_NAME]: opts.stateName } : {}),
    }, async (span) => {
      const response = await fetch(url, init);
      span.setAttribute(Attr.HTTP_RESPONSE_STATUS_CODE, response.status);
      if (!response.ok && !(opts?.expected ?? []).includes(response.status)) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `${response.status} ${response.statusText}`,
        });
        span.setAttribute(Attr.ERROR_TYPE, String(response.status));
      }
      return response;
    });
  }

  /**
   * Get state content (unwrapped from Terraform state format)
   */
  async getState(
    stateName: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${encodeURIComponent(stateName)}`;
    const response = await this.request("getState", url, {
      method: "GET",
      headers: this.headers(),
      signal,
    }, { stateName, expected: [404] });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText}`,
      );
    }

    const stateJson = await response.text();
    return unwrapFromTerraformState(stateJson);
  }

  /**
   * Put state content (wrapped in Terraform state format)
   */
  async putState(
    stateName: string,
    content: Uint8Array,
    lockId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let url = `${this.baseUrl}/${encodeURIComponent(stateName)}`;
    if (lockId) {
      url += `?ID=${encodeURIComponent(lockId)}`;
    }

    // Get current serial if state exists, increment for new version
    let serial = 1;
    let lineage: string | undefined;
    try {
      const existingResponse = await this.request(
        "readStateSerial",
        `${this.baseUrl}/${encodeURIComponent(stateName)}`,
        { method: "GET", headers: this.headers(), signal },
        // A first push has nothing to read a serial from; 404 is expected.
        { stateName, expected: [404] },
      );
      if (existingResponse.ok) {
        const existingState = await existingResponse.text();
        serial = getStateSerial(existingState) + 1;
        // Preserve lineage if it exists
        try {
          const parsed = JSON.parse(existingState);
          lineage = parsed.lineage;
        } catch { /* ignore */ }
      }
    } catch { /* state doesn't exist, use defaults */ }

    const wrappedState = wrapInTerraformState(content, serial, lineage);

    const response = await this.request("putState", url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: wrappedState,
      signal,
    }, { stateName });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText}: ${body}`,
      );
    }
  }

  /**
   * Delete state
   */
  async deleteState(stateName: string): Promise<void> {
    const url = `${this.baseUrl}/${encodeURIComponent(stateName)}`;
    const response = await this.request("deleteState", url, {
      method: "DELETE",
      headers: this.headers(),
    }, { stateName, expected: [404] });

    if (!response.ok && response.status !== 404) {
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText}`,
      );
    }
  }

  /**
   * List all states using GraphQL API
   */
  async listStates(signal?: AbortSignal): Promise<string[]> {
    // First, get the project path if we only have a numeric ID
    let projectPath = this.config.projectId;
    if (/^\d+$/.test(projectPath)) {
      // Numeric ID - need to get project path from REST API
      const projectUrl =
        `${this.config.baseUrl}/api/v4/projects/${projectPath}`;
      const projectResponse = await this.request("getProject", projectUrl, {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      if (projectResponse.ok) {
        const project = (await projectResponse.json()) as {
          path_with_namespace: string;
        };
        projectPath = project.path_with_namespace;
      } else {
        return [];
      }
    }

    // Use GraphQL to list terraform states
    const graphqlUrl = `${this.config.baseUrl}/api/graphql`;
    const query = `{
      project(fullPath: "${projectPath}") {
        terraformStates {
          nodes {
            name
          }
        }
      }
    }`;

    const response = await this.request("listStates", graphqlUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal,
    });

    if (!response.ok) {
      return [];
    }

    const result = (await response.json()) as {
      data?: {
        project?: {
          terraformStates?: {
            nodes?: Array<{ name: string }>;
          };
        };
      };
    };

    const nodes = result.data?.project?.terraformStates?.nodes ?? [];
    return nodes.map((n) => n.name);
  }

  /**
   * Acquire lock on a state
   */
  async lock(stateName: string, lockInfo: GitLabLockInfo): Promise<boolean> {
    const url = `${this.baseUrl}/${encodeURIComponent(stateName)}/lock`;
    const response = await this.request("lock", url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(lockInfo),
      // 409/423 mean another holder has the lock — normal contention, not a
      // failure.
    }, { stateName, expected: [409, 423] });

    if (response.ok) {
      return true;
    }

    // 409 Conflict or 423 Locked means already locked
    if (response.status === 409 || response.status === 423) {
      return false;
    }

    throw new Error(
      `GitLab lock error: ${response.status} ${response.statusText}`,
    );
  }

  /**
   * Release lock on a state
   */
  async unlock(stateName: string, lockInfo: GitLabLockInfo): Promise<boolean> {
    const url = `${this.baseUrl}/${encodeURIComponent(stateName)}/lock`;
    const response = await this.request("unlock", url, {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify(lockInfo),
      // 409 means the lock ID didn't match, 404 means there was no lock —
      // both are answers, not failures.
    }, { stateName, expected: [404, 409] });

    if (response.ok) {
      return true;
    }

    // 409 means lock ID doesn't match
    if (response.status === 409) {
      return false;
    }

    // 404 or other success-ish status means no lock existed
    if (response.status === 404) {
      return true;
    }

    throw new Error(
      `GitLab unlock error: ${response.status} ${response.statusText}`,
    );
  }

  /**
   * Get current lock info
   */
  async getLockInfo(stateName: string): Promise<GitLabLockInfo | null> {
    const url = `${this.baseUrl}/${encodeURIComponent(stateName)}/lock`;
    const response = await this.request("getLockInfo", url, {
      method: "GET",
      headers: this.headers(),
      // 404/204 mean the state is not locked.
    }, { stateName, expected: [204, 404] });

    if (response.status === 404 || response.status === 204) {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    return await response.json() as GitLabLockInfo;
  }

  /**
   * Health check - verify API is accessible
   */
  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    // Try to access the project's terraform state endpoint
    const url = `${this.config.baseUrl}/api/v4/projects/${
      encodeURIComponent(this.config.projectId)
    }`;
    const response = await this.request("healthCheck", url, {
      method: "GET",
      headers: this.headers(),
    });

    if (response.ok) {
      return { ok: true, message: "OK" };
    }

    return {
      ok: false,
      message: `HTTP ${response.status}: ${response.statusText}`,
    };
  }
}

/**
 * GitLab lock info structure (Terraform-compatible)
 */
interface GitLabLockInfo {
  ID: string;
  Operation: string;
  Info: string;
  Who: string;
  Version: string;
  Created: string;
  Path: string;
}

/**
 * Convert swamp LockInfo to GitLab format
 */
function toGitLabLockInfo(info: LockInfo, path: string): GitLabLockInfo {
  return {
    ID: info.nonce ?? crypto.randomUUID(),
    Operation: "swamp",
    Info: `holder=${info.holder}, pid=${info.pid}`,
    Who: info.holder,
    Version: "1",
    Created: info.acquiredAt,
    Path: path,
  };
}

/**
 * Convert GitLab lock info to swamp format
 */
function fromGitLabLockInfo(gitlabInfo: GitLabLockInfo): LockInfo {
  // Parse holder from Who field
  const holder = gitlabInfo.Who || "unknown";
  const hostname = holder.split("@")[1] || "unknown";

  return {
    holder,
    hostname,
    pid: 0, // Not available from GitLab
    acquiredAt: gitlabInfo.Created,
    ttlMs: 30_000, // Default TTL
    nonce: gitlabInfo.ID,
  };
}

/**
 * GitLab distributed lock implementation
 */
class GitLabLock implements DistributedLock {
  private readonly client: GitLabStateClient;
  private readonly stateName: string;
  private readonly ttlMs: number;
  private readonly retryIntervalMs: number;
  private readonly maxWaitMs: number;
  private lockInfo: LockInfo | null = null;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;

  constructor(
    client: GitLabStateClient,
    stateName: string,
    options?: LockOptions,
  ) {
    this.client = client;
    this.stateName = stateName;
    this.ttlMs = options?.ttlMs ?? 30_000;
    this.retryIntervalMs = options?.retryIntervalMs ?? 1_000;
    this.maxWaitMs = options?.maxWaitMs ?? 60_000;
  }

  async acquire(): Promise<void> {
    return await withSpan("gitlab-datastore lock acquire", {
      [Attr.LOCK_KEY]: this.stateName,
      [Attr.LOCK_TIMEOUT_MS]: this.maxWaitMs,
      [Attr.LOCK_TTL_MS]: this.ttlMs,
    }, async (span) => {
      const start = Date.now();
      let contended = false;
      let attempt = 0;

      while (Date.now() - start < this.maxWaitMs) {
        const info: LockInfo = {
          holder: `${Deno.env.get("USER") ?? "unknown"}@${Deno.hostname()}`,
          hostname: Deno.hostname(),
          pid: Deno.pid,
          acquiredAt: new Date().toISOString(),
          ttlMs: this.ttlMs,
          nonce: crypto.randomUUID(),
        };

        const gitlabLockInfo = toGitLabLockInfo(info, this.stateName);
        const acquired = await this.client.lock(this.stateName, gitlabLockInfo);

        if (acquired) {
          this.lockInfo = info;
          this.startHeartbeat();
          span.setAttributes({
            [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
            [Attr.LOCK_CONTENDED]: contended,
          });
          return;
        }

        contended = true;

        // Check if existing lock is stale
        const existing = await this.client.getLockInfo(this.stateName);
        if (existing) {
          span.setAttribute(Attr.LOCK_HOLDER, existing.Who);
          const createdAt = new Date(existing.Created).getTime();
          const age = Date.now() - createdAt;
          // Consider lock stale if older than 2x TTL (GitLab doesn't have TTL, so we use our default)
          if (age > this.ttlMs * 2) {
            // Force release stale lock
            await this.client.unlock(this.stateName, existing);
            attempt++;
            recordRetry(attempt, 0, { "retry.reason": "stale_lock_stolen" });
            continue;
          }
        }

        attempt++;
        recordRetry(attempt, this.retryIntervalMs, {
          "retry.reason": "lock_contended",
        });
        await new Promise((r) => setTimeout(r, this.retryIntervalMs));
      }

      span.setAttributes({
        [Attr.LOCK_WAIT_DURATION_MS]: Date.now() - start,
        [Attr.LOCK_CONTENDED]: contended,
      });
      throw new Error(`Lock timeout after ${this.maxWaitMs}ms`);
    });
  }

  async release(): Promise<void> {
    return await withSpan("gitlab-datastore lock release", {
      [Attr.LOCK_KEY]: this.stateName,
    }, async () => {
      this.stopHeartbeat();

      if (this.lockInfo) {
        const gitlabLockInfo = toGitLabLockInfo(this.lockInfo, this.stateName);
        await this.client.unlock(this.stateName, gitlabLockInfo);
        this.lockInfo = null;
      }
    });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return await withSpan("gitlab-datastore lock withLock", {
      [Attr.LOCK_KEY]: this.stateName,
    }, async () => {
      await this.acquire();
      try {
        return await fn();
      } finally {
        await this.release();
      }
    });
  }

  async inspect(): Promise<LockInfo | null> {
    return await withSpan("gitlab-datastore lock inspect", {
      [Attr.LOCK_KEY]: this.stateName,
    }, async (span) => {
      const gitlabInfo = await this.client.getLockInfo(this.stateName);
      if (!gitlabInfo) {
        return null;
      }
      span.setAttribute(Attr.LOCK_HOLDER, gitlabInfo.Who);
      return fromGitLabLockInfo(gitlabInfo);
    });
  }

  async forceRelease(expectedNonce: string): Promise<boolean> {
    return await withSpan("gitlab-datastore lock forceRelease", {
      [Attr.LOCK_KEY]: this.stateName,
    }, async () => {
      const gitlabInfo = await this.client.getLockInfo(this.stateName);
      if (!gitlabInfo) {
        return false;
      }

      if (gitlabInfo.ID !== expectedNonce) {
        return false;
      }

      return await this.client.unlock(this.stateName, gitlabInfo);
    });
  }

  private startHeartbeat(): void {
    // GitLab locks don't have built-in TTL/heartbeat, but we refresh the lock
    // periodically to update the Created timestamp for stale detection
    this.heartbeatId = setInterval(() => {
      if (this.lockInfo) {
        this.lockInfo.acquiredAt = new Date().toISOString();
        // Note: GitLab doesn't support lock refresh, so we just track locally
      }
    }, this.ttlMs / 3);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatId !== undefined) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = undefined;
    }
  }
}

/**
 * Encode a file path to a GitLab state name
 * e.g., "data/models/foo.json" -> "swamp--data--models--foo.json"
 */
function encodeStateName(prefix: string, relativePath: string): string {
  // Replace path separators with double-dash
  const encoded = relativePath.replace(/\//g, "--");
  return `${prefix}--${encoded}`;
}

/**
 * Decode a GitLab state name to a file path
 * e.g., "swamp--data--models--foo.json" -> "data/models/foo.json"
 */
function decodeStateName(prefix: string, stateName: string): string | null {
  const expectedPrefix = `${prefix}--`;
  if (!stateName.startsWith(expectedPrefix)) {
    return null;
  }
  const encoded = stateName.slice(expectedPrefix.length);
  return encoded.replace(/--/g, "/");
}

/**
 * Build a path filter from SyncContext.models.
 * Returns null when no scoping is requested (full sync).
 * Matching paths start with "data/{modelType}/{modelId}/".
 */
function buildScopeFilter(
  context?: SyncContext,
): ((relPath: string) => boolean) | null {
  if (!context?.models?.length) return null;
  const prefixes = context.models.map((m) =>
    `data/${m.modelType}/${m.modelId}/`
  );
  return (relPath: string) => prefixes.some((p) => relPath.startsWith(p));
}

/**
 * Check if a directory path could contain files matching the scope.
 * Used to prune directory walks early.
 */
function couldMatchScope(
  dirPath: string,
  context?: SyncContext,
): boolean {
  if (!context?.models?.length) return true;
  const dirWithSlash = dirPath + "/";
  for (const m of context.models) {
    const prefix = `data/${m.modelType}/${m.modelId}/`;
    // dirPath is a prefix of the target, or target is a prefix of dirPath
    if (prefix.startsWith(dirWithSlash) || dirWithSlash.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** Path to the sync state sidecar file within the cache directory. */
const SYNC_STATE_FILE = ".datastore-sync-state.json";

/** Maximum dirty paths before falling back to full walk. */
const MAX_DIRTY_PATHS = 200;

/** Persisted sync state for lazy hydration and dirty tracking. */
interface SyncState {
  lazyPullActive: boolean;
  dirtyPaths: string[];
  dirtyOverflow: boolean;
  hashes: Record<string, string>;
}

/** Read sync state from the sidecar file. */
async function readSyncState(cachePath: string): Promise<SyncState> {
  try {
    const raw = await Deno.readTextFile(`${cachePath}/${SYNC_STATE_FILE}`);
    const parsed = JSON.parse(raw);
    return {
      lazyPullActive: parsed.lazyPullActive ?? false,
      dirtyPaths: (parsed.dirtyPaths ?? []).filter(
        (p: unknown) =>
          typeof p === "string" && !p.split("/").some((s) => s === ".."),
      ),
      dirtyOverflow: parsed.dirtyOverflow ?? false,
      hashes: parsed.hashes ?? {},
    };
  } catch {
    return {
      lazyPullActive: false,
      dirtyPaths: [],
      dirtyOverflow: false,
      hashes: {},
    };
  }
}

/** Write sync state to the sidecar file atomically. */
async function writeSyncState(
  cachePath: string,
  state: SyncState,
): Promise<void> {
  const filePath = `${cachePath}/${SYNC_STATE_FILE}`;
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(state));
  await Deno.rename(tmpPath, filePath);
}

/** Compute SHA-256 hex digest of content. */
async function sha256Hex(content: Uint8Array): Promise<string> {
  const buf = new Uint8Array(content).buffer as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns true if a cache-relative path is a raw content file under data/.
 * Pattern: data/.../.../raw
 */
function isDataRawFile(relPath: string): boolean {
  return relPath.startsWith("data/") && relPath.endsWith("/raw");
}

const EXCLUDED_DIRS = new Set([
  "bundles",
  "vault-bundles",
  "driver-bundles",
  "datastore-bundles",
  "report-bundles",
  "cache",
  "telemetry",
  "logs",
]);

function isExcludedFile(name: string): boolean {
  return name === "_extension_catalog.db" ||
    name.endsWith(".db-shm") ||
    name.endsWith(".db-wal");
}

/**
 * Sync service for GitLab datastore
 */
class GitLabSyncService implements TwoPhaseSyncService {
  constructor(
    private readonly client: GitLabStateClient,
    private readonly prefix: string,
    private readonly cachePath: string,
  ) {}

  capabilities(): SyncCapabilities {
    return { scopedSync: true, lazyHydration: true, twoPhaseSync: true };
  }

  async markDirty(options?: DatastoreSyncOptions): Promise<void> {
    if (
      !options?.relPath || options.relPath.split("/").some((s) => s === "..")
    ) {
      return;
    }
    const state = await readSyncState(this.cachePath);
    if (state.dirtyOverflow) return; // already in full-walk mode
    if (state.dirtyPaths.includes(options.relPath)) return;
    state.dirtyPaths.push(options.relPath);
    if (state.dirtyPaths.length > MAX_DIRTY_PATHS) {
      state.dirtyPaths = [];
      state.dirtyOverflow = true;
    }
    await writeSyncState(this.cachePath, state);
  }

  async pullChanged(options?: DatastoreSyncOptions): Promise<number> {
    const scopeFilter = buildScopeFilter(options?.context);
    return await withSpan("gitlab-datastore pullChanged", {
      [Attr.DATASTORE_SCOPED]: scopeFilter !== null,
      [Attr.DATASTORE_METADATA_ONLY]: options?.metadataOnly === true,
    }, async (span) => {
      const signal = options?.signal;
      const metadataOnly = options?.metadataOnly === true;
      const states = await this.client.listStates(signal);
      span.setAttribute(Attr.DATASTORE_STATES, states.length);
      let count = 0;

      for (const stateName of states) {
        signal?.throwIfAborted();
        const relativePath = decodeStateName(this.prefix, stateName);
        if (!relativePath || relativePath.split("/").some((s) => s === "..")) {
          continue;
        }
        if (scopeFilter && !scopeFilter(relativePath)) continue;

        if (metadataOnly && isDataRawFile(relativePath)) {
          // Skip raw content but create parent directory for catalog walker
          const localPath = `${this.cachePath}/${relativePath}`;
          await Deno.mkdir(
            localPath.substring(0, localPath.lastIndexOf("/")),
            { recursive: true },
          );
          continue;
        }

        const content = await this.client.getState(stateName, signal);
        if (content) {
          const localPath = `${this.cachePath}/${relativePath}`;
          await Deno.mkdir(
            localPath.substring(0, localPath.lastIndexOf("/")),
            { recursive: true },
          );
          const tmpPath = `${localPath}.${crypto.randomUUID()}.tmp`;
          await Deno.writeFile(tmpPath, content);
          await Deno.rename(tmpPath, localPath);
          count++;
        }
      }

      // Track lazy hydration state
      if (metadataOnly) {
        const state = await readSyncState(this.cachePath);
        state.lazyPullActive = true;
        await writeSyncState(this.cachePath, state);
      } else if (!options?.context) {
        // Full unscoped pull clears lazy state
        const state = await readSyncState(this.cachePath);
        state.lazyPullActive = false;
        await writeSyncState(this.cachePath, state);
      }

      span.setAttribute(Attr.DATASTORE_FILES_PULLED, count);
      return count;
    });
  }

  async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
    const scopeFilter = buildScopeFilter(options?.context);
    return await withSpan("gitlab-datastore pushChanged", {
      [Attr.DATASTORE_SCOPED]: scopeFilter !== null,
    }, async (span) => {
      const signal = options?.signal;
      const syncState = await readSyncState(this.cachePath);
      let count = 0;

      const pushFile = async (relativePath: string): Promise<void> => {
        const fullPath = `${this.cachePath}/${relativePath}`;
        let content: Uint8Array;
        try {
          const stat = await Deno.stat(fullPath);
          if (stat.isDirectory) return; // markDirty may record directories; skip them
          content = await Deno.readFile(fullPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          throw error;
        }

        // Skip files exceeding GitLab's practical state size limit (4MB).
        // These are typically binary artifacts that don't need remote sync.
        const MAX_FILE_SIZE = 4 * 1024 * 1024;
        if (content.length > MAX_FILE_SIZE) return;

        // Hash-based skip: same hash means no change since last push.
        const hash = await sha256Hex(content);
        if (syncState.hashes[relativePath] === hash) return;

        const stateName = encodeStateName(this.prefix, relativePath);
        await this.client.putState(stateName, content, undefined, signal);
        syncState.hashes[relativePath] = hash;
        count++;
      };

      // Use dirty paths when available and not overflowed
      const useDirtyPaths = syncState.dirtyPaths.length > 0 &&
        !syncState.dirtyOverflow;

      if (useDirtyPaths) {
        const processed: Set<string> = new Set();
        for (const relPath of syncState.dirtyPaths) {
          signal?.throwIfAborted();
          if (scopeFilter && !scopeFilter(relPath)) continue;
          processed.add(relPath);
          await pushFile(relPath);
        }
        // Only remove paths that were actually processed; keep out-of-scope paths
        syncState.dirtyPaths = syncState.dirtyPaths.filter((p) =>
          !processed.has(p)
        );
      } else {
        const queue: Array<{ dir: string; base: string }> = [
          { dir: this.cachePath, base: "" },
        ];

        while (queue.length > 0) {
          signal?.throwIfAborted();
          const { dir, base } = queue.shift()!;

          try {
            for await (const entry of Deno.readDir(dir)) {
              const fullPath = `${dir}/${entry.name}`;
              const relativePath = base ? `${base}/${entry.name}` : entry.name;

              if (entry.isDirectory) {
                if (EXCLUDED_DIRS.has(entry.name)) continue;
                if (
                  scopeFilter &&
                  !couldMatchScope(relativePath, options?.context)
                ) {
                  continue;
                }
                queue.push({ dir: fullPath, base: relativePath });
              } else if (entry.isFile) {
                if (relativePath === SYNC_STATE_FILE) continue;
                if (isExcludedFile(entry.name)) continue;
                if (scopeFilter && !scopeFilter(relativePath)) continue;
                await pushFile(relativePath);
              }
            }
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
              throw error;
            }
          }
        }
      }

      // Clear dirty state after successful push.
      // For full walk: clear everything. For dirty-path mode: already filtered above.
      if (!useDirtyPaths) {
        syncState.dirtyPaths = [];
      }
      syncState.dirtyOverflow = false;
      await writeSyncState(this.cachePath, syncState);

      // GitLab states have no delete-on-push path, so files_deleted is always
      // zero here — recorded anyway so the attribute set matches the other
      // datastore extensions.
      span.setAttributes({
        [Attr.DATASTORE_FILES_PUSHED]: count,
        [Attr.DATASTORE_FILES_DELETED]: 0,
        [Attr.DATASTORE_FAST_PATH_HIT]: useDirtyPaths,
      });
      return count;
    });
  }

  async hydrateFile(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean> {
    return await withSpan("gitlab-datastore hydrateFile", {
      [Attr.DATASTORE_FILE]: relPath,
    }, async (span) => {
      if (relPath.split("/").some((s) => s === "..")) {
        span.setAttribute(Attr.DATASTORE_HYDRATED, false);
        return false;
      }
      const signal = options?.signal;
      const stateName = encodeStateName(this.prefix, relPath);
      const content = await this.client.getState(stateName, signal);
      if (!content) {
        span.setAttribute(Attr.DATASTORE_HYDRATED, false);
        return false;
      }

      const localPath = `${this.cachePath}/${relPath}`;
      await Deno.mkdir(
        localPath.substring(0, localPath.lastIndexOf("/")),
        { recursive: true },
      );

      // Atomic write: tmp file + rename
      const tmpPath = `${localPath}.${crypto.randomUUID()}.tmp`;
      await Deno.writeFile(tmpPath, content);
      await Deno.rename(tmpPath, localPath);

      // Update hash so next pushChanged doesn't re-upload unchanged content
      const state = await readSyncState(this.cachePath);
      state.hashes[relPath] = await sha256Hex(content);
      await writeSyncState(this.cachePath, state);

      span.setAttribute(Attr.DATASTORE_HYDRATED, true);
      return true;
    });
  }

  async preparePush(options?: DatastoreSyncOptions): Promise<PushManifest> {
    const scopeFilter = buildScopeFilter(options?.context);
    return await withSpan("gitlab-datastore preparePush", {
      [Attr.DATASTORE_SCOPED]: scopeFilter !== null,
    }, async (span) => {
      const signal = options?.signal;
      const syncState = await readSyncState(this.cachePath);
      const entries: Array<
        { relPath: string; hash: string; content: Uint8Array }
      > = [];

      const collectFile = async (relativePath: string): Promise<void> => {
        const fullPath = `${this.cachePath}/${relativePath}`;
        let content: Uint8Array;
        try {
          const stat = await Deno.stat(fullPath);
          if (stat.isDirectory) return;
          content = await Deno.readFile(fullPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          throw error;
        }

        const MAX_FILE_SIZE = 4 * 1024 * 1024;
        if (content.length > MAX_FILE_SIZE) return;

        const hash = await sha256Hex(content);
        if (syncState.hashes[relativePath] === hash) return;

        entries.push({ relPath: relativePath, hash, content });
      };

      const useDirtyPaths = syncState.dirtyPaths.length > 0 &&
        !syncState.dirtyOverflow;
      const processedDirtyPaths: Set<string> = new Set();

      if (useDirtyPaths) {
        for (const relPath of syncState.dirtyPaths) {
          signal?.throwIfAborted();
          if (scopeFilter && !scopeFilter(relPath)) continue;
          processedDirtyPaths.add(relPath);
          await collectFile(relPath);
        }
      } else {
        const queue: Array<{ dir: string; base: string }> = [
          { dir: this.cachePath, base: "" },
        ];

        while (queue.length > 0) {
          signal?.throwIfAborted();
          const { dir, base } = queue.shift()!;

          try {
            for await (const entry of Deno.readDir(dir)) {
              const fullPath = `${dir}/${entry.name}`;
              const relativePath = base ? `${base}/${entry.name}` : entry.name;

              if (entry.isDirectory) {
                if (EXCLUDED_DIRS.has(entry.name)) continue;
                if (
                  scopeFilter &&
                  !couldMatchScope(relativePath, options?.context)
                ) {
                  continue;
                }
                queue.push({ dir: fullPath, base: relativePath });
              } else if (entry.isFile) {
                if (relativePath === SYNC_STATE_FILE) continue;
                if (isExcludedFile(entry.name)) continue;
                if (scopeFilter && !scopeFilter(relativePath)) continue;
                await collectFile(relativePath);
              }
            }
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
              throw error;
            }
          }
        }
      }

      span.setAttributes({
        [Attr.DATASTORE_FILES_PLANNED_PUSH]: entries.length,
        [Attr.DATASTORE_FILES_PLANNED_DELETE]: 0,
      });

      return {
        entries,
        syncState,
        processedDirtyPaths,
      } as unknown as PushManifest;
    });
  }

  async commitPush(
    manifest: PushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number> {
    const internal = manifest as unknown as InternalPushManifest;
    return await withSpan("gitlab-datastore commitPush", {
      [Attr.DATASTORE_FILES_PLANNED_PUSH]: internal.entries.length,
      [Attr.DATASTORE_FILES_PLANNED_DELETE]: 0,
    }, async (span) => {
      const signal = options?.signal;

      for (const entry of internal.entries) {
        signal?.throwIfAborted();
        const stateName = encodeStateName(this.prefix, entry.relPath);
        await this.client.putState(stateName, entry.content, undefined, signal);
      }

      // Re-read fresh state to avoid overwriting concurrent updates
      const freshState = await readSyncState(this.cachePath);

      // Merge manifest hashes into fresh state
      for (const entry of internal.entries) {
        freshState.hashes[entry.relPath] = entry.hash;
      }

      // Clear dirty state after successful commit.
      if (internal.processedDirtyPaths.size > 0) {
        // Dirty-path mode: remove only the paths we processed
        freshState.dirtyPaths = freshState.dirtyPaths.filter((p) =>
          !internal.processedDirtyPaths.has(p)
        );
      } else if (internal.syncState.dirtyOverflow) {
        // Full-walk mode: clear everything
        freshState.dirtyPaths = [];
        freshState.dirtyOverflow = false;
      }
      await writeSyncState(this.cachePath, freshState);

      span.setAttributes({
        [Attr.DATASTORE_FILES_PUSHED]: internal.entries.length,
        [Attr.DATASTORE_FILES_DELETED]: 0,
        [Attr.DATASTORE_FAST_PATH_HIT]: internal.entries.length === 0,
      });
      return internal.entries.length;
    });
  }
}

/** Zod schema that validates and supplies defaults for GitLab datastore configuration. */
const ConfigSchema = z.object({
  projectId: z.string().describe(
    "GitLab project ID (numeric) or URL-encoded path (e.g., 'mygroup/myproject')",
  ),
  baseUrl: z.string().url().default("https://gitlab.com").describe(
    "GitLab instance URL",
  ),
  token: z.string().describe(
    "GitLab personal access token or CI job token with api scope",
  ),
  username: z.string().optional().describe(
    "GitLab username (optional, defaults to 'gitlab-ci-token')",
  ),
  statePrefix: z.string().default("swamp").describe(
    "Prefix for state names to namespace swamp data",
  ),
});

/**
 * Exported datastore provider for the GitLab Terraform state backend.
 *
 * Consumers call `datastore.createProvider(config)` to obtain lock,
 * verifier, sync, and path-resolution capabilities backed by GitLab.
 */
export const datastore = {
  type: "@webframp/gitlab-datastore",
  name: "GitLab Datastore",
  description:
    "Stores swamp runtime data in GitLab using the Terraform state HTTP API with native locking support",
  configSchema: ConfigSchema,

  createProvider: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    const client = new GitLabStateClient({
      baseUrl: parsed.baseUrl,
      projectId: parsed.projectId,
      token: parsed.token,
      username: parsed.username,
    });

    return {
      createLock: (
        _datastorePath: string,
        options?: LockOptions,
      ): DistributedLock => {
        // Use a dedicated lock state for the entire datastore
        const lockStateName = `${parsed.statePrefix}--lock`;
        return new GitLabLock(client, lockStateName, options);
      },

      createVerifier: (): DatastoreVerifier => ({
        verify: async (): Promise<DatastoreHealthResult> => {
          const start = performance.now();
          try {
            const result = await client.healthCheck();
            return {
              healthy: result.ok,
              message: result.message,
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/gitlab-datastore",
              details: {
                baseUrl: parsed.baseUrl,
                projectId: parsed.projectId,
              },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@webframp/gitlab-datastore",
            };
          }
        },
      }),

      createSyncService: (
        _repoDir: string,
        cachePath: string,
      ): TwoPhaseSyncService => {
        return new GitLabSyncService(client, parsed.statePrefix, cachePath);
      },

      resolveDatastorePath: (_repoDir: string): string =>
        `gitlab://${parsed.projectId}/${parsed.statePrefix}`,

      resolveCachePath: (_repoDir: string): string | undefined => {
        return undefined;
      },
    };
  },
};
