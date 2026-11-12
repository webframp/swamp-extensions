// SPDX-License-Identifier: Apache-2.0
/**
 * Small helpers: a bounded-concurrency pool, slugs for extension directories,
 * the selection id, and the attestation ref timestamp.
 *
 * @module
 */

/**
 * Runs `jobs` with at most `limit` in flight; results keep input order. Stops
 * starting new jobs once the signal aborts, and rethrows the abort.
 */
export async function pool<T>(
  jobs: Array<() => Promise<T>>,
  limit: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, jobs.length)) },
    async () => {
      while (next < jobs.length) {
        signal?.throwIfAborted();
        const i = next++;
        results[i] = await jobs[i]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * A data-name-safe slug for an extension directory. Injective: "%" and "."
 * are escaped first, then "/" becomes ".", so two directories never share a
 * slug. The result has none of the characters swamp refuses in a name.
 */
export function slug(dir: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) {
    throw new Error(`unexpected characters in directory "${dir}"`);
  }
  return dir.replaceAll(".", "%2E").replaceAll("/", ".");
}

/**
 * A data-name-safe slug for a repo-wide check name such as
 * "scripts/ci-discover:fmt:check". Each ":"-separated part is slugged and the
 * parts are joined with "%3A", which slug never emits, so it stays injective.
 */
export function checkSlug(check: string): string {
  return check.split(":").map(slug).join("%3A");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Identifies one discovery: the base, the commit, the selected extensions and
 * the repo-wide checks. A result computed for another selection does not count.
 */
export async function selectionId(input: {
  base: string;
  commit: string;
  extensions: readonly string[];
  repoChecks: readonly string[];
}): Promise<string> {
  return await sha256Hex(JSON.stringify({
    base: input.base,
    commit: input.commit,
    extensions: [...input.extensions].sort(),
    repoChecks: [...input.repoChecks].sort(),
  }));
}

/** Compact UTC time for a ref name: YYYYMMDDTHHMMSSmmmZ, no ":" or ".". */
export function refTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}
