// ABOUTME: Single-table key builders and item-type discriminators for the
// ABOUTME: DynamoDB datastore — locks, file metadata/chunks, and sync watermark.

export function lockKey(key: string): { pk: string; sk: string } {
  return { pk: `LOCK#${key}`, sk: "LOCK" };
}

export function fileMetaKey(relPath: string): { pk: string; sk: string } {
  return { pk: `FILE#${relPath}`, sk: "META" };
}

export function fileChunkKey(
  relPath: string,
  index: number,
): { pk: string; sk: string } {
  return {
    pk: `FILE#${relPath}`,
    sk: `CHUNK#${String(index).padStart(4, "0")}`,
  };
}

export function fileChunkPrefix(
  relPath: string,
): { pk: string; skPrefix: string } {
  return { pk: `FILE#${relPath}`, skPrefix: "CHUNK#" };
}

export const SYNC_STATE_KEY = { pk: "SYNCSTATE#global", sk: "STATE" } as const;

export const GSI_NAME = "gsi1";
export const GSI_FILE_PARTITION = "FILE";
