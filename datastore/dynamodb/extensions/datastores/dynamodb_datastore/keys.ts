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

export function fileChunkKey(
  relPath: string,
  index: number,
): { pk: string; sk: string } {
  return {
    pk: `FILE#${relPath}`,
    sk: `CHUNK#${String(index).padStart(CHUNK_INDEX_WIDTH, "0")}`,
  };
}

export function fileChunkPrefix(
  relPath: string,
): { pk: string; skPrefix: string } {
  return { pk: `FILE#${relPath}`, skPrefix: "CHUNK#" };
}

/** Parses the numeric chunk index back out of a `CHUNK#0000042` sort key. */
export function parseChunkIndex(sk: string): number {
  return Number(sk.slice("CHUNK#".length));
}

export const SYNC_STATE_KEY = { pk: "SYNCSTATE#global", sk: "STATE" } as const;

export const GSI_NAME = "gsi1";
export const GSI_FILE_PARTITION = "FILE";
