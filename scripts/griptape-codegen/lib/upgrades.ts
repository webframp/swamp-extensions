// Content-based version computation and upgrade-chain preservation for the
// Griptape codegen. Ported from the reference codegen pattern
// (scripts/cloudflare-codegen) and adapted for this repo.
//
// The generator OVERWRITES the whole model file on every run. To avoid two
// hazards — resetting the CalVer version to today's date on no-op re-runs, and
// erasing the hand-written `upgrades:` migration ledger — this module:
//   1. computes the version from a content diff (keep the existing version when
//      nothing changed; bump only on a real change), and
//   2. extracts the existing `upgrades:` entries verbatim and re-emits them,
//      appending a new identity entry only when the version actually advances.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract existing upgrade entry blocks from a generated model file. Returns
 * each `{ toVersion: ..., ... }` block as a raw string, preserving hand-written
 * descriptions and upgradeAttributes verbatim. Empty array if no upgrades block.
 */
export function extractExistingUpgrades(content: string): string[] {
  const marker = "upgrades: [";
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) return [];

  const arrayStart = startIdx + marker.length;
  let depth = 1;
  let i = arrayStart;
  while (i < content.length && depth > 0) {
    if (content[i] === "[") depth++;
    else if (content[i] === "]") depth--;
    i++;
  }
  const arrayEnd = i - 1;

  const arrayContent = content.slice(arrayStart, arrayEnd).trim();
  if (!arrayContent) return [];

  const entries: string[] = [];
  let entryDepth = 0;
  let entryStart = -1;
  for (let j = 0; j < arrayContent.length; j++) {
    const ch = arrayContent[j];
    if (ch === "{" && entryDepth === 0) {
      entryStart = j;
      entryDepth = 1;
    } else if (ch === "{") {
      entryDepth++;
    } else if (ch === "}") {
      entryDepth--;
      if (entryDepth === 0 && entryStart !== -1) {
        entries.push(arrayContent.slice(entryStart, j + 1).trim());
        entryStart = -1;
      }
    }
  }
  return entries;
}

/**
 * Remove the `upgrades: [ ... ]` block (and trailing comma/blank lines) from
 * file content so it does not influence version-change detection. deno fmt may
 * insert blank lines after multi-entry arrays; those are stripped too.
 */
export function stripUpgradesBlock(content: string): string {
  const marker = "upgrades: [";
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) return content;

  const arrayStart = startIdx + marker.length;
  let depth = 1;
  let i = arrayStart;
  while (i < content.length && depth > 0) {
    if (content[i] === "[") depth++;
    else if (content[i] === "]") depth--;
    i++;
  }

  let end = i;
  while (
    end < content.length && (content[end] === "," || content[end] === " ")
  ) {
    end++;
  }
  if (end < content.length && content[end] === "\n") end++;
  while (end < content.length && content[end] === "\n") end++;

  let lineStart = startIdx;
  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;

  return content.slice(0, lineStart) + content.slice(end);
}

/** Extract the last entry's toVersion from a list of raw upgrade entry blocks. */
export function lastToVersion(entries: string[]): string | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  const m = last.match(/toVersion:\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/**
 * Compare two CalVer strings (`YYYY.MM.DD.N`) segment by segment.
 * Returns a negative number if `a < b`, zero if equal, positive if `a > b`.
 * Non-numeric or short strings sort by their numeric prefix, then lexically —
 * enough to order well-formed CalVer, which is all the codegen emits.
 */
export function compareCalVer(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10));
  const pb = b.split(".").map((s) => parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      // Fall back to lexical comparison of the raw strings.
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Generate a single no-op (identity) upgrade entry. The codegen only produces
 * additive, optional schema fields, so old data is always valid under the new
 * schema — the migration is identity.
 */
export function generateUpgradeEntry(toVersion: string): string {
  return [
    `    {`,
    `      toVersion: "${toVersion}",`,
    `      description: "Regenerated from updated API spec; no migration required",`,
    `      upgradeAttributes: (old: Record<string, unknown>) => old,`,
    `    }`,
  ].join("\n");
}

/**
 * Build the `upgrades: [...]` block from existing entries plus an optional new
 * entry. Indentation is normalized by deno fmt after writing.
 */
export function buildUpgradesBlock(
  existingEntries: string[],
  newEntry: string | null,
): string {
  const all = [...existingEntries];
  if (newEntry) all.push(newEntry);
  const lines: string[] = [`  upgrades: [`];
  for (const entry of all) lines.push(entry + ",");
  lines.push(`  ],`);
  return lines.join("\n");
}

/**
 * Append a new identity upgrade entry for `version`, but only after confirming
 * it is strictly greater than the chain's current last `toVersion`. A forced
 * `--version` (or, in principle, any recomputed version) that is not ahead of
 * the existing tail would produce a backwards, invalid upgrade chain. With
 * per-model versioning, models advance independently, so a single forced
 * `--version` is routinely behind some models — throwing here surfaces the
 * mistake instead of silently corrupting the ledger. main.ts's top-level catch
 * turns the throw into a non-zero exit with the message.
 */
function appendGuarded(existing: string[], version: string): string {
  const last = lastToVersion(existing);
  if (last !== null && compareCalVer(version, last) <= 0) {
    throw new Error(
      `refusing to append upgrade entry ${version}: not strictly greater ` +
        `than the chain's last toVersion ${last}. Appending it would produce ` +
        `a backwards upgrade chain. Pass a --version greater than ${last}, ` +
        `or omit --version to use the content-based per-model version.`,
    );
  }
  return buildUpgradesBlock(existing, generateUpgradeEntry(version));
}

/**
 * Compute the `upgrades: [...]` block body for a model, given the version
 * status and the existing file content.
 *
 * - new: empty chain (first release, `upgrades: []`)
 * - unchanged: re-emit existing entries verbatim; if the last entry's toVersion
 *   lags the model version (e.g. a manual/forced bump), append an identity
 *   entry so the chain's final toVersion matches — guarded so the appended
 *   version must be strictly greater than the current tail.
 * - changed: re-emit existing entries and append one new identity entry for the
 *   new version, guarded the same way.
 */
export function computeUpgradesBlock(
  status: "new" | "changed" | "unchanged",
  version: string,
  existingContent: string | undefined,
): string {
  if (status === "new" || !existingContent) {
    return `  upgrades: [],`;
  }

  const existing = extractExistingUpgrades(existingContent);

  if (status === "unchanged") {
    if (existing.length === 0) return `  upgrades: [],`;
    if (lastToVersion(existing) !== version) {
      return appendGuarded(existing, version);
    }
    return buildUpgradesBlock(existing, null);
  }

  // changed
  return appendGuarded(existing, version);
}

// =============================================================================
// Content-based version computation
// =============================================================================

/** Format TypeScript via `deno fmt` in a temp file, so a candidate and the
 * on-disk file are compared in the same normalized state. Returns the original
 * content if formatting fails. */
export async function formatCode(code: string): Promise<string> {
  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmpFile, code);
    const result = await new Deno.Command("deno", {
      args: ["fmt", "--no-config", tmpFile],
    }).output();
    if (!result.success) return code;
    return await Deno.readTextFile(tmpFile);
  } finally {
    try {
      await Deno.remove(tmpFile);
    } catch { /* ignore */ }
  }
}

export interface ModelVersionResult {
  version: string;
  status: "new" | "changed" | "unchanged";
  /** Raw content of the existing file, if it exists. */
  existingContent?: string;
}

/**
 * Compute the CalVer version for a model file by content comparison.
 *
 * Formats the candidate, replaces both sides' version literal with a
 * placeholder, strips the upgrades block (which is derived, not authored), and
 * compares. Identical → keep the existing version (status "unchanged").
 * Different → bump the micro segment (same date) or start at .1 (new date).
 * Missing file → status "new" at `${datePrefix}.1`.
 */
export async function computeModelVersion(
  modelPath: string,
  datePrefix: string,
  candidateCode: string,
  placeholderVersion = "0.0.0.0",
): Promise<ModelVersionResult> {
  let existingContent: string;
  try {
    existingContent = await Deno.readTextFile(modelPath);
  } catch {
    return { version: `${datePrefix}.1`, status: "new" };
  }

  const versionMatch = existingContent.match(
    /version:\s*"(\d{4}\.\d{2}\.\d{2})\.(\d+)"/,
  );
  if (!versionMatch) {
    return { version: `${datePrefix}.1`, status: "changed", existingContent };
  }

  const existingDate = versionMatch[1];
  const existingMicro = parseInt(versionMatch[2], 10);
  const existingVersion = `${existingDate}.${existingMicro}`;

  const formattedCandidate = await formatCode(candidateCode);

  const normalizedExisting = stripUpgradesBlock(
    existingContent.replaceAll(
      `"${existingVersion}"`,
      `"${placeholderVersion}"`,
    ),
  );
  // The candidate already carries the placeholder version, so no replacement is
  // needed on this side — just strip the upgrades block to match.
  const normalizedCandidate = stripUpgradesBlock(formattedCandidate);

  if (normalizedExisting === normalizedCandidate) {
    return { version: existingVersion, status: "unchanged", existingContent };
  }

  const version = existingDate === datePrefix
    ? `${existingDate}.${existingMicro + 1}`
    : `${datePrefix}.1`;
  return { version, status: "changed", existingContent };
}
