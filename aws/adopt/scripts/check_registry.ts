// SPDX-License-Identifier: Apache-2.0

/**
 * Dev-only release check for `ADOPTION_TYPES`.
 *
 * Pulls every `swampPackage` in the registry into a throwaway swamp repo and
 * checks, for each registry row, that the official type exists, wraps the
 * same CloudFormation type, and uses the same primary identifier properties
 * in the same order. Types whose official model has no Cloud Control `list`
 * method are reported for information only: that is a property of the
 * official model, not proof that Cloud Control cannot list the type.
 *
 *   deno task check:registry
 *
 * Needs the `swamp` CLI on PATH and network access to the registry.
 *
 * @module
 */

import { ADOPTION_TYPES } from "../extensions/models/aws/_lib/adoption.ts";

/** What the official model source says about one type. */
interface OfficialType {
  cfnType: string | undefined;
  identifierProperties: string[];
  hasList: boolean;
  stateKeys: Set<string>;
}

async function swamp(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("swamp", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr);
    throw new Error(`swamp ${args.join(" ")} failed: ${err || text}`);
  }
  return text;
}

/** Read one official model file the way the generator writes it. */
function parseOfficial(source: string): OfficialType {
  const cfnType = source.match(/"(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)"/)?.[1];
  let identifierProperties: string[] = [];
  const composite = source.match(/const idParts = \[([\s\S]*?)\];/);
  if (composite) {
    identifierProperties = [...composite[1].matchAll(/existing\.(\w+)/g)].map(
      (m) => m[1],
    );
  } else {
    const single = source.match(/const identifier = existing\.(\w+)\?/);
    if (single) identifierProperties = [single[1]];
  }
  const state = source.match(
    /const StateSchema = z\.object\(\{([\s\S]*?)\n\}\)/,
  );
  const stateKeys = new Set(
    state ? [...state[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]) : [],
  );
  return {
    cfnType,
    identifierProperties,
    hasList: /listResources\(/.test(source),
    stateKeys,
  };
}

async function main(): Promise<number> {
  const repo = await Deno.makeTempDir({ prefix: "adopt-registry-" });
  try {
    await swamp(["repo", "init"], repo);
    const packages = [...new Set(ADOPTION_TYPES.map((t) => t.swampPackage))]
      .sort();
    for (const pkg of packages) {
      console.log(`pull ${pkg}`);
      await swamp(["extension", "pull", pkg], repo);
    }

    const official = new Map<string, OfficialType>();
    const versions = new Map<string, string>();
    for (const pkg of packages) {
      const dir = `${repo}/.swamp/pulled-extensions/${pkg}`;
      const manifest = await Deno.readTextFile(`${dir}/manifest.yaml`);
      versions.set(pkg, manifest.match(/^version:\s*'?([^'\s]+)/m)?.[1] ?? "?");
      for await (const file of Deno.readDir(`${dir}/models`)) {
        if (!file.isFile || !file.name.endsWith(".ts")) continue;
        const source = await Deno.readTextFile(`${dir}/models/${file.name}`);
        const type = source.match(/type: "(@swamp\/aws\/[^"]+)"/)?.[1];
        if (type) official.set(type, parseOfficial(source));
      }
    }

    const problems: string[] = [];
    const noList: string[] = [];
    for (const row of ADOPTION_TYPES) {
      const found = official.get(row.swampType);
      if (!found) {
        problems.push(`${row.swampType}: not found in ${row.swampPackage}`);
        continue;
      }
      if (found.cfnType !== row.cfnType) {
        problems.push(
          `${row.swampType}: wraps ${found.cfnType}, registry says ${row.cfnType}`,
        );
      }
      const want = row.identifierProperties.join("|");
      const got = found.identifierProperties.join("|");
      if (want !== got) {
        problems.push(
          `${row.swampType}: identifier ${got}, registry says ${want}`,
        );
      }
      if (!found.hasList) noList.push(row.cfnType);
      const topLevel = (path: string) => path.split(".")[0].replace("[]", "");
      const needed = [
        ...(row.arnProperty ? [row.arnProperty] : []),
        ...row.judgeAttributes.map(topLevel),
        ...Object.keys(row.references).map(topLevel),
        ...(row.tagsProperty === null ? [] : [row.tagsProperty ?? "Tags"]),
      ];
      for (const prop of new Set(needed)) {
        if (!found.stateKeys.has(prop)) {
          problems.push(
            `${row.swampType}: ${prop} is not in the official StateSchema`,
          );
        }
      }
    }

    console.log("\npackage versions:");
    for (const [pkg, version] of versions) console.log(`  ${pkg}@${version}`);
    if (noList.length > 0) {
      console.log(
        "\nofficial model has no Cloud Control list method (informational):",
      );
      for (const t of noList) console.log(`  ${t}`);
    }
    if (problems.length > 0) {
      console.error("\nregistry problems:");
      for (const p of problems) console.error(`  ${p}`);
      return 1;
    }
    console.log(`\nregistry OK: ${ADOPTION_TYPES.length} types checked`);
    return 0;
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
}

Deno.exit(await main());
