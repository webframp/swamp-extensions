// ABOUTME: Splits file blobs into DynamoDB-item-sized chunks and reassembles
// ABOUTME: them on read, working around the 400KB per-item size ceiling.

export function splitIntoChunks(
  bytes: Uint8Array,
  maxChunkBytes: number,
): Uint8Array[] {
  if (bytes.byteLength === 0) return [new Uint8Array(0)];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxChunkBytes) {
    chunks.push(bytes.subarray(offset, offset + maxChunkBytes));
  }
  return chunks;
}

export function reassembleChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
