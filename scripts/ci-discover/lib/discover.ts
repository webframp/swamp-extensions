/**
 * Extension discovery.
 *
 * Coverage is derived from the filesystem rather than from hand-maintained
 * matrix lists in ci.yml, which is how 55 of 137 extensions ended up with no CI
 * job at all.
 *
 * @module
 */

/** An extension found on disk. */
export interface Extension {
  /** Directory relative to the repo root, e.g. "aws/inventory". */
  dir: string;
  /** Published name from manifest.yaml, e.g. "@webframp/aws/inventory". */
  name: string;
  /** Raw dependency specifiers, e.g. "@webframp/aws/logs@2026.07.21.1". */
  dependencies: string[];
}

/**
 * Maximum directory depth searched for manifest.yaml.
 *
 * This repo nests two deep (`aws/adopt`, `cloudflare/kv`, `datastore/postgres`).
 * A single-level scan finds 36 of 137 and silently drops the rest.
 */
export const MAX_DEPTH = 2;

/** Read `name` from a manifest. Minimal parse — no YAML dependency. */
export function parseManifestName(text: string): string | null {
  const m = text.match(/^name:\s*"?([^"\n]+?)"?\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Read the `dependencies:` block from a manifest.
 *
 * Entries look like `- "@webframp/aws/logs@2026.07.21.1"`. Parsing stops at the
 * next top-level key so a later list (labels, platforms) is not absorbed.
 */
export function parseManifestDependencies(text: string): string[] {
  const lines = text.split("\n");
  const deps: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (/^dependencies:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;

    // A non-indented, non-empty line ends the block.
    if (/^\S/.test(line)) break;

    const item = line.match(/^\s+-\s*"?([^"\n]+?)"?\s*$/);
    if (item) deps.push(item[1].trim());
  }

  return deps;
}

/**
 * Strip the version suffix from a dependency specifier.
 *
 * Specifiers are `@collective/path@version`. The leading `@` means the version
 * separator is the LAST `@`, not the first.
 */
export function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Directory reader, injectable so tests can run against a fixture tree. */
export interface FsLike {
  readDir(path: string): Iterable<{ name: string; isDirectory: boolean }>;
  readTextFile(path: string): string;
  exists(path: string): boolean;
}

/** Default FsLike backed by Deno, used outside tests. */
export const denoFs: FsLike = {
  readDir(path) {
    const out: { name: string; isDirectory: boolean }[] = [];
    for (const e of Deno.readDirSync(path)) {
      out.push({ name: e.name, isDirectory: e.isDirectory });
    }
    return out;
  },
  readTextFile: (p) => Deno.readTextFileSync(p),
  exists(p) {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Find every extension under `root`, to MAX_DEPTH.
 *
 * Skips dotted directories and node_modules so a nested `.swamp/` cache or a
 * worktree cannot register as an extension. Results are sorted by dir so matrix
 * output is deterministic.
 */
export function discoverExtensions(
  root: string,
  fs: FsLike = denoFs,
): Extension[] {
  const found: Extension[] = [];

  const visit = (rel: string, depth: number) => {
    const abs = rel ? `${root}/${rel}` : root;

    const manifest = `${abs}/manifest.yaml`;
    if (rel && fs.exists(manifest)) {
      const text = fs.readTextFile(manifest);
      const name = parseManifestName(text);
      if (name) {
        found.push({
          dir: rel,
          name,
          dependencies: parseManifestDependencies(text),
        });
      }
      // Deliberately does NOT return. `cloudflare` is itself an extension AND
      // the parent of 26 sibling extensions (`cloudflare/kv`, ...), so treating
      // an extension directory as a leaf would drop all of them.
      //
      // What keeps an extension's own internal manifests out is depth: every
      // real extension manifest in this repo sits at depth 1 or 2, while an
      // internal one (e.g. aws/inventory/extensions/models/manifest.yaml) sits
      // at 4 or deeper.
    }

    if (depth >= MAX_DEPTH) return;

    for (const entry of fs.readDir(abs)) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      visit(rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };

  visit("", 0);
  found.sort((a, b) => a.dir.localeCompare(b.dir));
  return found;
}

/**
 * Map published name to directory.
 *
 * Required rather than convenient: the directory does NOT mirror the name for
 * several families — `driver/nix` publishes as `@webframp/nix`, `vault/pass` as
 * `@webframp/pass`, `datastore/postgres` as `@webframp/postgres-datastore`.
 * Deriving a path from a dependency specifier would miss all of them.
 */
export function nameToDir(exts: Extension[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of exts) map.set(e.name, e.dir);
  return map;
}
