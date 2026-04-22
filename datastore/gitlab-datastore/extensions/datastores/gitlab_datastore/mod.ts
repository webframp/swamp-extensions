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

import { z } from "npm:zod@4";

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

interface DatastoreSyncService {
  pullChanged(): Promise<number | void>;
  pushChanged(): Promise<number | void>;
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
 * Wrap raw content in a Terraform state envelope
 */
function wrapInTerraformState(
  content: Uint8Array,
  serial: number = 1,
  lineage?: string,
): string {
  const base64Content = btoa(String.fromCharCode(...content));
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
  }

  private headers(): Record<string, string> {
    return {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    };
  }

  /**
   * Get state content (unwrapped from Terraform state format)
   */
  async getState(stateName: string): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/${encodeURIComponent(stateName)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });

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
  ): Promise<void> {
    let url = `${this.baseUrl}/${encodeURIComponent(stateName)}`;
    if (lockId) {
      url += `?ID=${encodeURIComponent(lockId)}`;
    }

    // Get current serial if state exists, increment for new version
    let serial = 1;
    let lineage: string | undefined;
    try {
      const existingResponse = await fetch(
        `${this.baseUrl}/${encodeURIComponent(stateName)}`,
        { method: "GET", headers: this.headers() },
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: wrappedState,
    });

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
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(
        `GitLab API error: ${response.status} ${response.statusText}`,
      );
    }
  }

  /**
   * List all states using GraphQL API
   */
  async listStates(): Promise<string[]> {
    // First, get the project path if we only have a numeric ID
    let projectPath = this.config.projectId;
    if (/^\d+$/.test(projectPath)) {
      // Numeric ID - need to get project path from REST API
      const projectUrl =
        `${this.config.baseUrl}/api/v4/projects/${projectPath}`;
      const projectResponse = await fetch(projectUrl, {
        method: "GET",
        headers: this.headers(),
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

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
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
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(lockInfo),
    });

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
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify(lockInfo),
    });

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
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });

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
    const response = await fetch(url, {
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
  private heartbeatId: number | undefined;

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
    const start = Date.now();

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
        return;
      }

      // Check if existing lock is stale
      const existing = await this.client.getLockInfo(this.stateName);
      if (existing) {
        const createdAt = new Date(existing.Created).getTime();
        const age = Date.now() - createdAt;
        // Consider lock stale if older than 2x TTL (GitLab doesn't have TTL, so we use our default)
        if (age > this.ttlMs * 2) {
          // Force release stale lock
          await this.client.unlock(this.stateName, existing);
          continue;
        }
      }

      await new Promise((r) => setTimeout(r, this.retryIntervalMs));
    }

    throw new Error(`Lock timeout after ${this.maxWaitMs}ms`);
  }

  async release(): Promise<void> {
    this.stopHeartbeat();

    if (this.lockInfo) {
      const gitlabLockInfo = toGitLabLockInfo(this.lockInfo, this.stateName);
      await this.client.unlock(this.stateName, gitlabLockInfo);
      this.lockInfo = null;
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  async inspect(): Promise<LockInfo | null> {
    const gitlabInfo = await this.client.getLockInfo(this.stateName);
    if (!gitlabInfo) {
      return null;
    }
    return fromGitLabLockInfo(gitlabInfo);
  }

  async forceRelease(expectedNonce: string): Promise<boolean> {
    const gitlabInfo = await this.client.getLockInfo(this.stateName);
    if (!gitlabInfo) {
      return false;
    }

    if (gitlabInfo.ID !== expectedNonce) {
      return false;
    }

    return await this.client.unlock(this.stateName, gitlabInfo);
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
 * Sync service for GitLab datastore
 */
class GitLabSyncService implements DatastoreSyncService {
  constructor(
    private readonly client: GitLabStateClient,
    private readonly prefix: string,
    private readonly cachePath: string,
  ) {}

  async pullChanged(): Promise<number> {
    const states = await this.client.listStates();
    let count = 0;

    for (const stateName of states) {
      const relativePath = decodeStateName(this.prefix, stateName);
      if (!relativePath) continue;

      const content = await this.client.getState(stateName);
      if (content) {
        const localPath = `${this.cachePath}/${relativePath}`;
        await Deno.mkdir(
          localPath.substring(0, localPath.lastIndexOf("/")),
          { recursive: true },
        );
        await Deno.writeFile(localPath, content);
        count++;
      }
    }

    return count;
  }

  async pushChanged(): Promise<number> {
    let count = 0;

    const walkDir = async (dir: string, base: string): Promise<void> => {
      try {
        for await (const entry of Deno.readDir(dir)) {
          const fullPath = `${dir}/${entry.name}`;
          const relativePath = base ? `${base}/${entry.name}` : entry.name;

          if (entry.isDirectory) {
            await walkDir(fullPath, relativePath);
          } else if (entry.isFile) {
            const content = await Deno.readFile(fullPath);
            const stateName = encodeStateName(this.prefix, relativePath);
            await this.client.putState(stateName, content);
            count++;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    };

    await walkDir(this.cachePath, "");
    return count;
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
      ): DatastoreSyncService => {
        return new GitLabSyncService(client, parsed.statePrefix, cachePath);
      },

      resolveDatastorePath: (repoDir: string): string => {
        // For remote datastores, return the cache path
        return `${repoDir}/.swamp/gitlab-cache`;
      },

      resolveCachePath: (repoDir: string): string => {
        return `${repoDir}/.swamp/gitlab-cache`;
      },
    };
  },
};
