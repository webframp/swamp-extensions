// SPDX-License-Identifier: Apache-2.0

/**
 * Content-addressed download cache. A file is fetched once, checked against
 * its pinned SHA-256, and reused; a cached copy that no longer matches is
 * fetched again rather than trusted.
 *
 * @module
 */

import { ELISP_PINS, REVEAL_CDN, REVEAL_FILES } from "./pins.ts";

/** Per-request download timeout. */
const FETCH_TIMEOUT_MS = 60_000;

/** Largest download accepted, well above any pinned file. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

/** Default cache directory: `$XDG_CACHE_HOME` or `~/.cache`, then our name. */
export function defaultCacheDir(): string {
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const home = Deno.env.get("HOME");
  const base = xdg && xdg !== "" ? xdg : home ? `${home}/.cache` : null;
  if (!base) {
    throw new Error(
      "Cannot locate a cache directory: neither XDG_CACHE_HOME nor HOME is set. Set the cacheDir global argument.",
    );
  }
  return `${base}/webframp-presentation`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  );
}

/** Base64 SHA-256 of `bytes`, the form used by subresource integrity. */
export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  return toBase64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  );
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function download(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Download failed: ${url} returned HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    await res.body?.cancel();
    throw new Error(`Download refused: ${url} is ${declared} bytes`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Download refused: ${url} is ${bytes.length} bytes`);
  }
  return bytes;
}

/**
 * Return the bytes at `url`, verified against `verify`, using `path` as the
 * cache. The cache is written atomically, so an interrupted download never
 * leaves a partial file that later reads would trust.
 */
export async function fetchVerified(
  url: string,
  path: string,
  verify: (bytes: Uint8Array) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const cached = await readIfPresent(path);
  if (cached && await verify(cached)) return cached;

  const bytes = await download(url, signal);
  if (!await verify(bytes)) {
    throw new Error(
      `Integrity check failed for ${url}: the downloaded bytes do not match the pinned SHA-256. Refusing to use them.`,
    );
  }
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeFile(tmp, bytes);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  return bytes;
}

/** True when `path` is one of the pinned reveal.js runtime files. */
export function isPinnedRevealFile(path: string): boolean {
  return Object.hasOwn(REVEAL_FILES, path);
}

/**
 * Fetch one pinned reveal.js file (`dist/...`) from the CDN through the cache.
 * Throws for a path that is not pinned.
 */
export async function fetchRevealFile(
  cacheDir: string,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!isPinnedRevealFile(path)) {
    throw new Error(`Not a pinned reveal.js file: ${path}`);
  }
  const expected = REVEAL_FILES[path];
  const version = REVEAL_CDN.slice(REVEAL_CDN.lastIndexOf("@") + 1);
  return await fetchVerified(
    `${REVEAL_CDN}/${path}`,
    `${cacheDir}/reveal.js-${version}/${path}`,
    async (b) => await sha256Base64(b) === expected,
    signal,
  );
}

/**
 * Make every pinned Emacs Lisp file available in one directory and return
 * that directory, ready for `load-path`.
 */
export async function ensureElisp(
  cacheDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = `${cacheDir}/elisp`;
  for (const pin of ELISP_PINS) {
    await fetchVerified(
      pin.url,
      `${dir}/${pin.file}`,
      async (b) => await sha256Hex(b) === pin.sha256,
      signal,
    );
  }
  return dir;
}
