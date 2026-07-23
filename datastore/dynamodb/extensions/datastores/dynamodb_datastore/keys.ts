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
export const GSI_FILE_PARTITION = "FILE";
