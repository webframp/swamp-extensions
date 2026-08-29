/**
 * Spec-pin maintenance for the Griptape codegen.
 *
 * Usage:
 *   deno task bump -- --update-spec   # Re-fetch the spec, print the hash diff,
 *                                     # and rewrite SPEC_SHA256 in config.ts.
 *   deno task bump -- --check         # Verify the pinned hash still matches
 *                                     # upstream (non-zero exit on drift).
 *
 * Unlike the Cloudflare generator's git-SHA pin, Griptape publishes a mutable
 * S3 object, so the pin is a SHA-256 of the fetched body. This tool is the only
 * sanctioned way to advance it.
 *
 * @module
 */

import { SPEC_SHA256 } from "./config.ts";
import { fetchSpecText } from "./lib/schema_fetcher.ts";

const CONFIG_PATH = new URL("./config.ts", import.meta.url).pathname;

async function updateSpec(): Promise<void> {
  console.log(`📥 Fetching Griptape Cloud OpenAPI spec (unpinned)...`);
  // expectedHash=null: we are establishing a new pin, so do not verify.
  const { hash } = await fetchSpecText(null);

  if (hash === SPEC_SHA256) {
    console.log(`✓ Spec unchanged. Pin already at ${hash}.`);
    return;
  }

  console.log(`   old pin: ${SPEC_SHA256}`);
  console.log(`   new pin: ${hash}`);

  const config = await Deno.readTextFile(CONFIG_PATH);
  const updated = config.replace(
    /export const SPEC_SHA256 =\s*\n?\s*"[0-9a-f]{64}";/,
    `export const SPEC_SHA256 =\n  "${hash}";`,
  );
  if (updated === config) {
    console.error(
      `❌ Could not find the SPEC_SHA256 literal to rewrite in config.ts. ` +
        `Update it manually to: ${hash}`,
    );
    Deno.exit(1);
  }
  await Deno.writeTextFile(CONFIG_PATH, updated);
  console.log(`✅ Re-pinned SPEC_SHA256 in config.ts.`);
  console.log(
    `   Review the upstream spec diff, then run: deno task generate:dry-run`,
  );
}

async function checkSpec(): Promise<void> {
  console.log(`🔎 Checking pinned spec against upstream...`);
  const { hash } = await fetchSpecText(null);
  if (hash === SPEC_SHA256) {
    console.log(`✓ Pin matches upstream (${hash}).`);
    return;
  }
  console.error(
    `❌ Spec drift detected.\n   pinned:   ${SPEC_SHA256}\n   upstream: ${hash}\n` +
      `   Re-pin with: deno task bump -- --update-spec`,
  );
  Deno.exit(1);
}

async function main() {
  const args = Deno.args;
  if (args.includes("--update-spec")) {
    await updateSpec();
  } else if (args.includes("--check")) {
    await checkSpec();
  } else {
    console.log(
      `Usage:\n` +
        `  deno task bump -- --update-spec   Re-pin SPEC_SHA256 to current upstream\n` +
        `  deno task bump -- --check         Verify the pin still matches upstream`,
    );
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error:`, err.message);
  Deno.exit(1);
});
