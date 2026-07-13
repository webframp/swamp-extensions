/**
 * Shared data-handle reader for the operator-briefing reports.
 *
 * Both the workflow-scope briefing and the method-scope fast-path read a data
 * handle's bytes and JSON-parse them the same way, so the logic lives here
 * once. Never throws (degrade contract) — a genuine absent/empty resource is
 * reported as `{ data: null, parseError: false }`, and only a real read failure
 * (both `getContent` attempts threw) or a `JSON.parse` failure is counted.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

/** Minimal shape of the report contexts' data repository. */
export interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/**
 * Outcome of reading one data handle. `data` is the parsed object, or `null`
 * when the resource is genuinely absent/empty (NOT an error). `parseError` is
 * true only for a real read failure (both `getContent` attempts threw) or a
 * `JSON.parse` failure — those are the only cases the caller counts.
 */
export interface ReadResult {
  data: Record<string, unknown> | null;
  parseError: boolean;
}

/**
 * Read a data handle's bytes and JSON-parse. Tries the given `modelType` first
 * (a string in the workflow steps, the native `ModelType` in a method context —
 * both work with the test mock and the live repository); ONLY if that first
 * `getContent` call itself throws does it retry with a type-like object built
 * from the string form. A `JSON.parse` failure never re-fetches. A genuine
 * `null`/empty body is reported as `{ data: null, parseError: false }` so the
 * caller does not miscount an absent resource as a parse failure. Never throws.
 */
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
    // The first getContent call itself threw — retry with a type-like object
    // built from the string form. A parse failure below must NOT reach here.
    try {
      // Prefer the native ModelType's `.raw` type string (method context) over a
      // blind String(), which on some objects yields a useless "[object Object]".
      const rawType = (modelType as { raw?: unknown } | null)?.raw;
      const s = typeof modelType === "string"
        ? modelType
        : typeof rawType === "string"
        ? rawType
        : String(modelType);
      const typeArg = {
        raw: s,
        toDirectoryPath: () => s,
        toString: () => s,
      };
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
