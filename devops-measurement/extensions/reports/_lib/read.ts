/**
 * Shared data-handle reader for the devops-measurement report.
 *
 * Reads a workflow step's data handle bytes and JSON-parses them, tolerating
 * both the string `modelType` (workflow context) and a native ModelType. Never
 * throws — a genuinely absent resource is `{ data: null, parseError: false }`;
 * only a real read failure or a JSON.parse failure sets `parseError`.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

/** Minimal shape of the report context's data repository. */
export interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

export interface ReadResult {
  data: Record<string, unknown> | null;
  parseError: boolean;
}

/** Read a data handle's bytes and JSON-parse. Never throws. */
export async function readJson(
  repo: DataRepository,
  modelType: unknown,
  modelId: string,
  dataName: string,
  version?: number,
): Promise<ReadResult> {
  let raw: Uint8Array | null;
  try {
    raw = await repo.getContent(modelType, modelId, dataName, version);
  } catch {
    try {
      const rawType = (modelType as { raw?: unknown } | null)?.raw;
      const s = typeof modelType === "string"
        ? modelType
        : typeof rawType === "string"
        ? rawType
        : String(modelType);
      const typeArg = { raw: s, toDirectoryPath: () => s, toString: () => s };
      raw = await repo.getContent(typeArg, modelId, dataName, version);
    } catch {
      return { data: null, parseError: true };
    }
  }
  if (!raw) return { data: null, parseError: false };
  try {
    return {
      data: JSON.parse(new TextDecoder().decode(raw)),
      parseError: false,
    };
  } catch {
    return { data: null, parseError: true };
  }
}
