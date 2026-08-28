/**
 * In-memory fake of the ioredis `Redis` surface used by the valkey datastore.
 *
 * Implements only the commands `mod.ts` actually calls, with semantics faithful
 * to Valkey/Redis where the datastore depends on them (NX locking, sorted-set
 * score ranges, hash fields, the Lua release script, and pipelines). It lets the
 * lock, sync, and verifier tests run with no live server.
 *
 * Injected into the exported factories via `new FakeValkey() as unknown as Redis`.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { Buffer } from "node:buffer";

type PipelineResult = [Error | null, unknown];

interface StringEntry {
  value: string;
  expireAt?: number;
}

/**
 * Convert a Redis glob MATCH pattern to a RegExp.
 *
 * Honors the escaping produced by mod.ts `escapeMatchPattern` — a backslash
 * makes the next metacharacter literal. Unescaped `*` and `?` are wildcards;
 * `[...]` is a character class.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      // Escaped: next char is literal.
      const next = pattern[i + 1] ?? "\\";
      out += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    } else if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      // Pass a character class through, up to the closing ].
      let cls = "[";
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        cls += pattern[i];
        i++;
      }
      cls += "]";
      out += cls;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Parse a ZRANGEBYSCORE bound: `-inf`, `+inf`, `(N` (exclusive), or `N`
 * (inclusive). Returns the numeric value and whether the bound is exclusive.
 */
function parseScoreBound(
  bound: string | number,
): { value: number; exclusive: boolean } {
  const s = String(bound);
  if (s === "-inf") return { value: -Infinity, exclusive: false };
  if (s === "+inf") return { value: Infinity, exclusive: false };
  if (s.startsWith("(")) {
    return { value: parseFloat(s.slice(1)), exclusive: true };
  }
  return { value: parseFloat(s), exclusive: false };
}

/** A queued pipeline command: the fake method name plus its args. */
interface QueuedOp {
  method: string;
  args: unknown[];
}

class FakePipeline {
  private ops: QueuedOp[] = [];
  constructor(private readonly redis: FakeValkey) {}

  hget(key: string, field: string): this {
    this.ops.push({ method: "hget", args: [key, field] });
    return this;
  }
  hgetall(key: string): this {
    this.ops.push({ method: "hgetall", args: [key] });
    return this;
  }
  hset(key: string, ...args: unknown[]): this {
    this.ops.push({ method: "hset", args: [key, ...args] });
    return this;
  }
  set(key: string, ...args: unknown[]): this {
    this.ops.push({ method: "set", args: [key, ...args] });
    return this;
  }
  zadd(key: string, score: number, member: string): this {
    this.ops.push({ method: "zadd", args: [key, score, member] });
    return this;
  }
  del(key: string): this {
    this.ops.push({ method: "del", args: [key] });
    return this;
  }
  zrem(key: string, member: string): this {
    this.ops.push({ method: "zrem", args: [key, member] });
    return this;
  }

  // deno-lint-ignore require-await
  async exec(): Promise<PipelineResult[]> {
    const results: PipelineResult[] = [];
    for (const op of this.ops) {
      try {
        // Route each queued op through the fake's synchronous cores.
        const val = this.redis._applySync(op.method, op.args);
        results.push([null, val]);
      } catch (err) {
        results.push([err as Error, null]);
      }
    }
    return results;
  }
}

/**
 * In-memory ioredis fake. One instance models one Valkey keyspace.
 */
export class FakeValkey {
  private strings = new Map<string, StringEntry>();
  private buffers = new Map<string, Buffer>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();

  /** Server version reported by INFO; overridable for tests. */
  version = "7.4.0";

  // -- expiry helper --
  private isExpired(entry: StringEntry): boolean {
    return entry.expireAt !== undefined && Date.now() > entry.expireAt;
  }

  private getStringEntry(key: string): StringEntry | undefined {
    const e = this.strings.get(key);
    if (e && this.isExpired(e)) {
      this.strings.delete(key);
      return undefined;
    }
    return e;
  }

  // -- connection/info --
  // deno-lint-ignore require-await
  async ping(): Promise<string> {
    return "PONG";
  }

  // deno-lint-ignore require-await
  async info(_section?: string): Promise<string> {
    return `# Server\r\nredis_version:${this.version}\r\n`;
  }

  // -- strings --
  // deno-lint-ignore require-await
  async get(key: string): Promise<string | null> {
    const e = this.getStringEntry(key);
    return e ? e.value : null;
  }

  // deno-lint-ignore require-await
  async getBuffer(key: string): Promise<Buffer | null> {
    return this.buffers.get(key) ?? null;
  }

  // deno-lint-ignore require-await
  async set(key: string, ...args: unknown[]): Promise<string | null> {
    return this._setSync(key, args) as string | null;
  }

  // deno-lint-ignore require-await
  async del(key: string): Promise<number> {
    return this._delSync(key);
  }

  // deno-lint-ignore require-await
  async pexpire(key: string, ttlMs: number): Promise<number> {
    const e = this.getStringEntry(key);
    if (!e) return 0;
    e.expireAt = Date.now() + ttlMs;
    return 1;
  }

  // deno-lint-ignore require-await
  async incr(key: string): Promise<number> {
    const e = this.getStringEntry(key);
    const next = (e ? parseInt(e.value, 10) : 0) + 1;
    this.strings.set(key, { value: String(next), expireAt: e?.expireAt });
    return next;
  }

  // -- hashes --
  // deno-lint-ignore require-await
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  // deno-lint-ignore require-await
  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h);
  }

  // deno-lint-ignore require-await
  async hset(key: string, ...args: unknown[]): Promise<number> {
    return this._hsetSync(key, args);
  }

  // -- sorted sets --
  // deno-lint-ignore require-await
  async zadd(key: string, score: number, member: string): Promise<number> {
    return this._zaddSync(key, score, member);
  }

  // deno-lint-ignore require-await
  async zscore(key: string, member: string): Promise<string | null> {
    const z = this.zsets.get(key);
    const s = z?.get(member);
    return s === undefined ? null : String(s);
  }

  // deno-lint-ignore require-await
  async zrem(key: string, member: string): Promise<number> {
    return this._zremSync(key, member);
  }

  // deno-lint-ignore require-await
  async zscan(
    key: string,
    _cursor: string,
    ..._opts: unknown[]
  ): Promise<[string, string[]]> {
    // Parse MATCH/COUNT options; COUNT is advisory and ignored (single-shot).
    let match = "*";
    for (let i = 0; i < _opts.length; i++) {
      if (String(_opts[i]).toUpperCase() === "MATCH") {
        match = String(_opts[i + 1]);
      }
    }
    const re = globToRegExp(match);
    const z = this.zsets.get(key);
    const flat: string[] = [];
    if (z) {
      for (const [member, score] of z) {
        if (re.test(member)) {
          flat.push(member, String(score));
        }
      }
    }
    // In-memory scan returns everything in one shot: cursor "0" means done.
    return ["0", flat];
  }

  // deno-lint-ignore require-await
  async zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...opts: unknown[]
  ): Promise<string[]> {
    const lo = parseScoreBound(min);
    const hi = parseScoreBound(max);

    let offset = 0;
    let count = Infinity;
    for (let i = 0; i < opts.length; i++) {
      if (String(opts[i]).toUpperCase() === "LIMIT") {
        offset = Number(opts[i + 1]);
        count = Number(opts[i + 2]);
      }
    }

    const z = this.zsets.get(key);
    if (!z) return [];

    const inRange = [...z.entries()].filter(([, score]) => {
      const aboveLo = lo.exclusive ? score > lo.value : score >= lo.value;
      const belowHi = hi.exclusive ? score < hi.value : score <= hi.value;
      return aboveLo && belowHi;
    });
    // Redis orders by score ascending, then lexicographically by member.
    inRange.sort((a, b) =>
      a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );

    const sliced = inRange.slice(
      offset,
      count === Infinity ? undefined : offset + count,
    );
    return sliced.map(([member]) => member);
  }

  // -- scripting --
  // deno-lint-ignore require-await
  async call(command: string, ...args: unknown[]): Promise<unknown> {
    if (String(command).toUpperCase() !== "EVAL") {
      throw new Error(`FakeValkey: unsupported call command "${command}"`);
    }
    // args: [script, numKeys, key, ...argv]. The datastore ships exactly one
    // script, RELEASE_LOCK_LUA: DEL key iff the stored JSON's nonce matches
    // ARGV[1]. Emulate that semantics.
    const numKeys = Number(args[1]);
    const key = String(args[2]);
    const argv1 = String(args[2 + numKeys]);
    const e = this.getStringEntry(key);
    if (!e) return 0;
    try {
      const info = JSON.parse(e.value);
      if (info.nonce === argv1) {
        this._delSync(key);
        return 1;
      }
    } catch {
      // Not JSON / no nonce — treat as non-match.
    }
    return 0;
  }

  // -- pipeline --
  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  // ---- synchronous cores (shared by direct methods and pipeline.exec) ----

  /** Dispatch a queued pipeline op to its synchronous core. */
  _applySync(method: string, args: unknown[]): unknown {
    switch (method) {
      case "hget":
        return this.hashes.get(String(args[0]))?.get(String(args[1])) ?? null;
      case "hgetall": {
        const h = this.hashes.get(String(args[0]));
        return h ? Object.fromEntries(h) : {};
      }
      case "hset":
        return this._hsetSync(String(args[0]), args.slice(1));
      case "set":
        return this._setSync(String(args[0]), args.slice(1));
      case "zadd":
        return this._zaddSync(
          String(args[0]),
          Number(args[1]),
          String(args[2]),
        );
      case "del":
        return this._delSync(String(args[0]));
      case "zrem":
        return this._zremSync(String(args[0]), String(args[1]));
      default:
        throw new Error(`FakeValkey: unsupported pipeline op "${method}"`);
    }
  }

  private _setSync(key: string, args: unknown[]): string | null {
    const value = args[0];
    // Detect NX (set-if-absent) among the option args.
    const hasNX = args.some((a) => String(a).toUpperCase() === "NX");
    // Detect PX <ms> for expiry.
    let expireAt: number | undefined;
    for (let i = 1; i < args.length; i++) {
      const tok = String(args[i]).toUpperCase();
      if (tok === "PX") {
        expireAt = Date.now() + Number(args[i + 1]);
        i++; // skip the millisecond argument
      } else if (tok === "NX") {
        // handled above
      } else {
        // Fail loudly on any SET option the fake does not model, rather than
        // silently ignoring it — a future mod.ts change adding an unmodeled
        // flag must not pass against the fake by accident.
        throw new Error(`FakeValkey: unsupported SET option "${args[i]}"`);
      }
    }

    if (hasNX && this.getStringEntry(key) !== undefined) {
      return null;
    }

    if (Buffer.isBuffer(value)) {
      // Blob content path: stored for getBuffer. Clear any string shadow.
      this.buffers.set(key, value as Buffer);
      this.strings.delete(key);
    } else {
      this.strings.set(key, { value: String(value), expireAt });
      this.buffers.delete(key);
    }
    return "OK";
  }

  private _delSync(key: string): number {
    let removed = 0;
    if (this.strings.delete(key)) removed = 1;
    if (this.buffers.delete(key)) removed = 1;
    if (this.hashes.delete(key)) removed = 1;
    if (this.zsets.delete(key)) removed = 1;
    return removed;
  }

  private _hsetSync(key: string, args: unknown[]): number {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    let added = 0;
    // Two call shapes: hset(key, {f: v, ...}) or hset(key, f1, v1, f2, v2, ...).
    if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
      for (const [f, v] of Object.entries(args[0] as Record<string, unknown>)) {
        if (!h.has(f)) added++;
        h.set(f, String(v));
      }
    } else {
      for (let i = 0; i < args.length; i += 2) {
        const f = String(args[i]);
        if (!h.has(f)) added++;
        h.set(f, String(args[i + 1]));
      }
    }
    return added;
  }

  private _zaddSync(key: string, score: number, member: string): number {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    const isNew = !z.has(member);
    z.set(member, score);
    return isNew ? 1 : 0;
  }

  private _zremSync(key: string, member: string): number {
    const z = this.zsets.get(key);
    if (!z) return 0;
    return z.delete(member) ? 1 : 0;
  }
}
