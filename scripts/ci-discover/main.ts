/**
 * CI matrix discovery.
 *
 * Emits the GitHub Actions matrix for extension jobs, derived from the filesystem
 * rather than from hand-maintained lists in ci.yml.
 *
 * Usage:
 *   deno task discover                          # full matrix, every extension
 *   deno task discover -- --diff-base <ref>     # scope to what changed vs ref
 *   deno task discover -- --changed-from <file> # scope to paths in a file
 *   deno task discover -- --repo-root <path>    # default: two levels up
 *   deno task discover -- --exclude <dirs>      # comma-separated dirs to omit
 *
 * Output is a single JSON object on stdout:
 *   { "scope": "full"|"scoped", "reason": "...", "extensions": ["aws/inventory"] }
 *
 * Consumed by the `discover` job in `.github/workflows/ci.yml`. PR 8 adds
 * diff scoping.
 *
 * @module
 */

import { discoverExtensions } from "./lib/discover.ts";
import { buildDependents, expandDependents } from "./lib/deps.ts";
import { classify } from "./lib/classify.ts";

export interface Options {
  repoRoot: string;
  diffBase?: string;
  changedFrom?: string;
  githubOutput: boolean;
  /** Extension directories to exclude from the final matrix (e.g. "datastore/valkey"). */
  exclude: string[];
}

export function parseArgs(args: string[]): Options {
  const opts: Options = {
    // scripts/ci-discover/main.ts -> repo root is two levels up.
    repoRoot: new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
    githubOutput: false,
    exclude: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      // `deno task discover -- --flag` forwards a literal `--`. Skip it rather
      // than rejecting it, since that invocation form is the documented one.
      case "--":
        break;
      case "--repo-root":
        opts.repoRoot = args[++i];
        break;
      case "--diff-base":
        opts.diffBase = args[++i];
        break;
      case "--changed-from":
        opts.changedFrom = args[++i];
        break;
      case "--github-output":
        opts.githubOutput = true;
        break;
      case "--exclude":
        opts.exclude = args[++i].split(",").map((s) => s.trim()).filter((s) =>
          s.length > 0
        );
        break;
      default:
        console.error(`unknown argument: ${args[i]}`);
        Deno.exit(2);
    }
  }

  return opts;
}

/**
 * Resolve the changed-path list.
 *
 * Returns null when no scoping was requested OR when the diff could not be
 * computed. Both cases select the full matrix — a shallow clone, a missing base
 * ref, or a force-push must never be mistaken for "nothing changed".
 */
function resolveChanged(opts: Options): string[] | null {
  if (opts.changedFrom) {
    try {
      return Deno.readTextFileSync(opts.changedFrom)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch (err) {
      console.error(`could not read ${opts.changedFrom}: ${err}`);
      return null;
    }
  }

  if (opts.diffBase) {
    const p = new Deno.Command("git", {
      args: ["diff", "--name-only", opts.diffBase, "HEAD"],
      cwd: opts.repoRoot,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!p.success) {
      console.error(
        `git diff against ${opts.diffBase} failed: ${
          new TextDecoder().decode(p.stderr).trim()
        }`,
      );
      return null;
    }
    return new TextDecoder()
      .decode(p.stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  return null;
}

function main() {
  const opts = parseArgs(Deno.args);

  const exts = discoverExtensions(opts.repoRoot);
  if (exts.length === 0) {
    console.error(`no extensions found under ${opts.repoRoot}`);
    Deno.exit(1);
  }

  const dependents = buildDependents(exts);
  const result = classify(
    resolveChanged(opts),
    exts,
    (seed) => expandDependents(seed, dependents),
  );

  // Apply exclusions AFTER classification. Excluded extensions are tested
  // elsewhere (e.g. datastore/valkey needs a service container), so they are
  // removed from this matrix but NOT from CI coverage.
  if (opts.exclude.length > 0) {
    const excludeSet = new Set(opts.exclude);
    const before = result.extensions.length;
    result.extensions = result.extensions.filter((d) => !excludeSet.has(d));
    const removed = before - result.extensions.length;
    if (removed > 0) {
      console.error(
        `excluded ${removed} extension(s) from matrix: ${opts.exclude.join(", ")}`,
      );
    }
    // Warn if an --exclude value didn't match anything — likely a typo.
    for (const ex of opts.exclude) {
      if (!exts.some((e) => e.dir === ex)) {
        console.error(
          `warning: --exclude value "${ex}" does not match any discovered extension`,
        );
      }
    }
  }
  console.log(JSON.stringify(result));

  // Reason goes to stderr so stdout stays parseable as JSON.
  console.error(`scope=${result.scope} count=${result.extensions.length}`);
  console.error(`reason: ${result.reason}`);

  if (result.overflow) {
    console.error(
      `\nselection of ${result.extensions.length} exceeds GitHub's 256-job ` +
        `matrix limit. Refusing to emit a matrix rather than truncate it — ` +
        `dropping entries would mean silently not testing them. The repo needs ` +
        `chunked or nested matrices at this size.`,
    );
    Deno.exit(1);
  }

  if (opts.githubOutput) {
    const out = Deno.env.get("GITHUB_OUTPUT");
    if (!out) {
      console.error("--github-output given but GITHUB_OUTPUT is not set");
      Deno.exit(1);
    }
    Deno.writeTextFileSync(
      out,
      `extensions=${JSON.stringify(result.extensions)}\n` +
        `scope=${result.scope}\n`,
      { append: true },
    );
  }
}

if (import.meta.main) main();
