// ABOUTME: Single-table key builders and item-type discriminators for the
// ABOUTME: DynamoDB datastore — locks, file metadata/chunks, and sync watermark.

export function lockKey(key: string): { pk: string; sk: string } {
  return { pk: `LOCK#${key}`, sk: "LOCK" };
}

export function fileMetaKey(relPath: string): { pk: string; sk: string } {
  return { pk: `FILE#${relPath}`, sk: "META" };
}

/** Zero-padded to 7 digits so lexicographic sort-key order matches numeric
 * chunk order up to 9,999,999 chunks — far beyond any realistic chunk count
 * (that's ~2.4TB of content at the default 256KB chunk size). fetchChunks()
 * additionally re-sorts numerically rather than trusting this alone. */
const CHUNK_INDEX_WIDTH = 7;

/** Build a versioned chunk sort key. Version 0 is the legacy unversioned
 * format (`CHUNK#0000000`). Version >= 1 uses the format
 * `CHUNK#v<version>#0000000` so that a reader fetching by version prefix
 * never sees chunks from a different write generation. */
export function fileChunkKey(
  relPath: string,
  index: number,
  version?: number,
): { pk: string; sk: string } {
  const indexStr = String(index).padStart(CHUNK_INDEX_WIDTH, "0");
  const sk = version && version > 0
    ? `CHUNK#v${version}#${indexStr}`
    : `CHUNK#${indexStr}`;
  return { pk: `FILE#${relPath}`, sk };
}

/** Returns the prefix to query chunks for a specific version. Version 0 or
 * undefined queries the legacy `CHUNK#` prefix (all chunks regardless of
 * version). Version >= 1 queries only `CHUNK#v<N>#` — isolating reads to
 * a single write generation. */
export function fileChunkPrefix(
  relPath: string,
  version?: number,
): { pk: string; skPrefix: string } {
  const skPrefix = version && version > 0 ? `CHUNK#v${version}#` : "CHUNK#";
  return { pk: `FILE#${relPath}`, skPrefix };
}

/** Parses the numeric chunk index from a sort key. Handles both legacy
 * format (`CHUNK#0000042`) and versioned format (`CHUNK#v3#0000042`). */
export function parseChunkIndex(sk: string): number {
  // Versioned: CHUNK#v<N>#0000042
  const versionedMatch = sk.match(/^CHUNK#v\d+#(\d+)$/);
  if (versionedMatch) return Number(versionedMatch[1]);
  // Legacy: CHUNK#0000042
  return Number(sk.slice("CHUNK#".length));
}

export const SYNC_STATE_KEY = { pk: "SYNCSTATE#global", sk: "STATE" } as const;

export const GSI_NAME = "gsi1";

/**
 * @deprecated Retained only for reference. The new per-model partition scheme
 * uses `gsiFilePartition(relPath)` to derive model-scoped partition keys.
 */
export const GSI_FILE_PARTITION = "FILE";

/** Separator between timestamp and relPath in gsi1sk. Using a character that
 * sorts after digits in ISO-8601 timestamps ensures key-condition range queries
 * (`gsi1sk > :since`) correctly include all items updated after that timestamp. */
const GSI_SK_SEP = "|";

/** Derives the GSI partition key for a given relPath.
 *
 * Model data (`data/<modelType>/<modelId>/...`) maps to `FILE#<modelType>/<modelId>`.
 * System data (other DATASTORE_SUBDIRS) maps to `FILE#_system/<subdir>`.
 *
 * This partitioning ensures pull/push operations for a single model only read
 * that model's GSI partition — O(items changed) instead of O(total items). */
export function gsiFilePartition(relPath: string): string {
  const parts = relPath.split("/");
  if (parts[0] === "data" && parts.length >= 3) {
    // data/<modelType>/<modelId>/... → FILE#<modelType>/<modelId>
    return `FILE#${parts[1]}/${parts[2]}`;
  }
  // System subdirs (definitions-evaluated, workflows-evaluated, etc.)
  return `FILE#_system/${parts[0]}`;
}

/** Builds the composite gsi1sk value: `<updatedAt>|<relPath>`.
 * ISO-8601 timestamp prefix enables time-range key conditions. */
export function gsiFileSortKey(updatedAt: string, relPath: string): string {
  return `${updatedAt}${GSI_SK_SEP}${relPath}`;
}

/** Parses a composite gsi1sk back into its updatedAt and relPath components. */
export function parseGsiFileSortKey(
  gsi1sk: string,
): { updatedAt: string; relPath: string } {
  const sepIdx = gsi1sk.indexOf(GSI_SK_SEP);
  if (sepIdx === -1) {
    // Fallback for any legacy items that use bare relPath as gsi1sk
    return { updatedAt: "", relPath: gsi1sk };
  }
  return {
    updatedAt: gsi1sk.slice(0, sepIdx),
    relPath: gsi1sk.slice(sepIdx + 1),
  };
}

/** Returns all distinct GSI partition keys needed to cover a set of model
 * prefixes (as produced by `modelPrefixes()`). Used for scoped pull. */
export function gsiPartitionsForModels(
  models: ReadonlyArray<{ modelType: string; modelId: string }>,
): string[] {
  return models.map((m) => `FILE#${m.modelType}/${m.modelId}`);
}

/** Returns all GSI partition keys for system (non-model) data subdirs. */
export function gsiSystemPartitions(subdirs: readonly string[]): string[] {
  return subdirs
    .filter((s) => s !== "data")
    .map((s) => `FILE#_system/${s}`);
}
