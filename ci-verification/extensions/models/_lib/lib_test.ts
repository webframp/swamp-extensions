// SPDX-License-Identifier: Apache-2.0
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  BARE_SPECIFIER_COMMAND,
  BARE_SPECIFIER_PATTERN,
  GREP_FLAGS,
  judgeBareSpecifiers,
  judgeZodPins,
  ZOD_PIN_COMMAND,
  ZOD_PIN_PATTERN,
} from "./ci_patterns.ts";
import { allowedKeys, capLog, childEnv, run } from "./exec.ts";
import {
  gitText,
  removeStaleWorktrees,
  resolveCommit,
  withWorktree,
  WORKTREE_PREFIX,
} from "./git.ts";
import { judgeQuality } from "./quality.ts";
import {
  listAttestationRefs,
  postAttestation,
  REF_PREFIX,
} from "./refstore.ts";
import { checkSlug, pool, refTimestamp, selectionId, slug } from "./util.ts";

// CI's zod-pin grep scans test files too, so pin-shaped text is assembled.
const FROM = "fr" + "om";
const pin = (v: string) => `${FROM} "npm:` + `zod@${v}"`;

const GIT_ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

async function sh(cwd: string, script: string): Promise<string> {
  const r = await run({
    cmd: "bash",
    args: ["-c", script],
    cwd,
    env: { ...childEnv("git"), ...GIT_ID },
  });
  if (!r.ok) throw new Error(`${script}: ${r.log}`);
  return r.stdout;
}

async function tempRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "civ-lib-test-" });
  await sh(
    dir,
    "git init -q -b main . && echo one > a.txt && git add a.txt && git commit -q -m one",
  );
  return dir;
}

async function rmrf(path: string) {
  await Deno.remove(path, { recursive: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

Deno.test("capLog keeps short logs whole", () => {
  assertEquals(capLog("abc", 10), { log: "abc", truncated: false });
});

Deno.test("capLog keeps the tail of long logs and flags truncation", () => {
  const r = capLog("0123456789", 4);
  assertEquals(r, { log: "6789", truncated: true });
});

Deno.test("childEnv gives each kind exactly its allowlisted keys", () => {
  const source: Record<string, string> = {
    PATH: "/bin",
    HOME: "/home/real",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    SSH_AUTH_SOCK: "/run/ssh",
    SWAMP_API_KEY: "k",
    SWAMP_SIGNIN_TOKEN: "t",
    AWS_PROFILE: "secret-profile",
    AWS_SECRET_ACCESS_KEY: "nope",
    GITHUB_TOKEN: "nope",
  };
  const task = childEnv("task", { taskHome: "/tmp/h", source });
  assertEquals(Object.keys(task).sort(), ["HOME", "PATH", "SSL_CERT_FILE"]);
  assertEquals(task.HOME, "/tmp/h");

  const swamp = childEnv("swamp", { source, denoDir: "/cache" });
  assertEquals(Object.keys(swamp).sort(), [
    "DENO_DIR",
    "HOME",
    "PATH",
    "SSL_CERT_FILE",
    "SWAMP_API_KEY",
    "SWAMP_SIGNIN_TOKEN",
  ]);
  assertEquals(swamp.HOME, "/home/real");

  const git = childEnv("git", { source });
  assertEquals(Object.keys(git).sort(), [
    "HOME",
    "PATH",
    "SSH_AUTH_SOCK",
    "SSL_CERT_FILE",
  ]);

  for (const kind of ["task", "swamp", "git"] as const) {
    for (const key of allowedKeys(kind)) {
      assert(!key.startsWith("AWS_"), `${kind} allows ${key}`);
      assert(!key.startsWith("GITHUB_"), `${kind} allows ${key}`);
    }
  }
});

Deno.test("childEnv refuses a task command without a throwaway HOME", () => {
  assertThrows(() => childEnv("task", { source: {} }), Error, "HOME");
});

Deno.test("run reports failure without throwing", async () => {
  const fail = await run({
    cmd: "bash",
    args: ["-c", "echo out; echo err >&2; exit 3"],
    cwd: Deno.cwd(),
    env: childEnv("git"),
  });
  assertEquals(fail.ok, false);
  assertEquals(fail.code, 3);
  assertEquals(fail.stdout, "out\n");
  assertEquals(fail.log, "out\nerr\n");

  const missing = await run({
    cmd: "civ-no-such-command",
    args: [],
    cwd: Deno.cwd(),
    env: childEnv("git"),
  });
  assertEquals(missing.ok, false);
  assertEquals(missing.code, null);
});

Deno.test("run clears the environment and writes stdin", async () => {
  Deno.env.set("CIV_LEAK_PROBE", "leaked");
  try {
    const r = await run({
      cmd: "bash",
      args: ["-c", 'cat; printf "[%s]" "${CIV_LEAK_PROBE:-}"'],
      cwd: Deno.cwd(),
      env: childEnv("git"),
      stdin: "in",
    });
    assertEquals(r.stdout, "in[]");
  } finally {
    Deno.env.delete("CIV_LEAK_PROBE");
  }
});

Deno.test("run throws once the signal is aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assertRejects(() =>
    run({
      cmd: "true",
      args: [],
      cwd: Deno.cwd(),
      env: childEnv("git"),
      signal: ac.signal,
    })
  );
});

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

Deno.test("slug is injective across '/', '.' and '%'", () => {
  assertEquals(slug("aws/iam"), "aws.iam");
  assertNotEquals(slug("aws/iam"), slug("aws.iam"));
  assertNotEquals(slug("a.b/c"), slug("a/b.c"));
  assertEquals(slug("a.b"), "a%2Eb");
  assertThrows(() => slug("a b"));
  assertThrows(() => slug("a%b"));
});

Deno.test("checkSlug handles multi-colon task names and stays injective", () => {
  assertEquals(
    checkSlug("scripts/ci-discover:fmt:check"),
    "scripts.ci-discover%3Afmt%3Acheck",
  );
  assertEquals(checkSlug("zod-pin"), "zod-pin");
  assertNotEquals(checkSlug("a:b.c"), checkSlug("a.b:c"));
  assertNotEquals(checkSlug("a:b"), checkSlug("a.b"));
  assertNotEquals(checkSlug("a:b"), checkSlug("a/b"));
});

Deno.test("selectionId ignores order and changes with any input", async () => {
  const a = await selectionId({
    base: "b",
    commit: "c",
    extensions: ["x", "y"],
    repoChecks: ["r", "s"],
  });
  const b = await selectionId({
    base: "b",
    commit: "c",
    extensions: ["y", "x"],
    repoChecks: ["s", "r"],
  });
  assertEquals(a, b);
  assertMatch(a, /^[0-9a-f]{64}$/);
  const c = await selectionId({
    base: "b2",
    commit: "c",
    extensions: ["x", "y"],
    repoChecks: ["r", "s"],
  });
  assertNotEquals(a, c);
});

Deno.test("pool keeps order and never exceeds its limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const jobs = Array.from({ length: 9 }, (_, i) => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (i % 3)));
    inFlight--;
    return i;
  });
  assertEquals(await pool(jobs, 3), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assertEquals(peak, 3);
  assertEquals(await pool([], 3), []);
});

Deno.test("refTimestamp is compact UTC with no ':' or '.'", () => {
  const t = refTimestamp(new Date("2026-11-11T23:54:01.234Z"));
  assertEquals(t, "20261111T235401234Z");
});

// ---------------------------------------------------------------------------
// quality
// ---------------------------------------------------------------------------

Deno.test("judgeQuality: 87% with provisional 100% passes", () => {
  const r = judgeQuality(
    JSON.stringify({
      status: "passed",
      percentage: 87,
      ifProvisionalEarned: { percentage: 100 },
    }),
    0,
  );
  assertEquals(r.passed, true);
  assertEquals(r.percentage, 87);
  assertEquals(r.provisionalPercentage, 100);
});

Deno.test("judgeQuality fails every shape CI fails", () => {
  const cases: Array<[string, number | null, string]> = [
    ["", 0, "printed nothing"],
    ["<html>503 Service Unavailable</html>", 1, "did not return JSON"],
    ["[]", 0, "did not return JSON"],
    ["null", 0, "did not return JSON"],
    [JSON.stringify({ status: "failed", percentage: 100 }), 0, "status"],
    [JSON.stringify({ status: "passed", percentage: 92 }), 0, "score is 92%"],
    [
      JSON.stringify({ status: "passed", percentage: 100, allPassed: false }),
      0,
      "allPassed",
    ],
    ["{}", null, "did not start"],
  ];
  for (const [out, code, reason] of cases) {
    const r = judgeQuality(out, code);
    assertEquals(r.passed, false, out);
    assert(r.reason?.includes(reason), `${out}: ${r.reason}`);
  }
});

// ---------------------------------------------------------------------------
// ci_patterns
// ---------------------------------------------------------------------------

Deno.test("ci_patterns matches ci.yml (drift check)", async () => {
  const ciYml = new URL(
    "../../../../.github/workflows/ci.yml",
    import.meta.url,
  );
  const text = await Deno.readTextFile(ciYml).catch(() => null);
  if (text === null) {
    console.warn("ci.yml not found beside this extension; drift check skipped");
    return;
  }
  assert(
    text.includes(`'${BARE_SPECIFIER_PATTERN}'`),
    "bare pattern drifted",
  );
  assert(text.includes(`'${ZOD_PIN_PATTERN}'`), "zod pattern drifted");
  for (const flag of GREP_FLAGS) {
    assert(text.includes(flag), `flag drifted: ${flag}`);
  }
});

Deno.test("CI's greps over this extension see only the model's pin", async () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const pins = (await sh(root, ZOD_PIN_COMMAND)).split("\n").filter(Boolean);
  assertEquals(pins.length, 1, pins.join(", "));
  assertMatch(pins[0], new RegExp("^" + pin("\\d+\\.\\d+\\.\\d+") + "$"));
  assertEquals(await sh(root, BARE_SPECIFIER_COMMAND), "");
});

Deno.test("CI's greps judge a fixture the way CI does", async () => {
  const dir = await Deno.makeTempDir({ prefix: "civ-grep-test-" });
  try {
    await Deno.mkdir(`${dir}/ext/extensions/models`, { recursive: true });
    await Deno.mkdir(`${dir}/scripts/gen`, { recursive: true });
    // A codegen template under scripts/ is not a pin.
    await Deno.writeTextFile(
      `${dir}/scripts/gen/t.ts`,
      `const t = '${pin("${ZOD_VERSION}")}';\n`,
    );
    await Deno.writeTextFile(
      `${dir}/ext/extensions/models/m.ts`,
      `import { z } ${pin("4.6.7")};\n`,
    );
    assertEquals(judgeZodPins(await sh(dir, ZOD_PIN_COMMAND)), null);
    assertEquals(
      judgeBareSpecifiers(await sh(dir, BARE_SPECIFIER_COMMAND)),
      null,
    );

    await Deno.writeTextFile(
      `${dir}/ext/extensions/models/n.ts`,
      `import { z } ${pin("4.6.5")};\nimport p ${FROM} "postgres";\n`,
    );
    // A bare specifier in a test file is not shipped.
    await Deno.writeTextFile(
      `${dir}/ext/extensions/models/n_test.ts`,
      `import { z } ${FROM} "zod";\n`,
    );
    const pins = judgeZodPins(await sh(dir, ZOD_PIN_COMMAND));
    assert(pins?.includes("inconsistent"), String(pins));
    const bare = judgeBareSpecifiers(await sh(dir, BARE_SPECIFIER_COMMAND));
    assert(bare?.includes("n.ts"), String(bare));
    assert(!bare?.includes("n_test.ts"), String(bare));
  } finally {
    await rmrf(dir);
  }
});

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

Deno.test("resolveCommit resolves refs and refuses option-shaped input", async () => {
  const repo = await tempRepo();
  try {
    const head = await gitText(repo, ["rev-parse", "HEAD"]);
    assertEquals(await resolveCommit(repo, "main"), head);
    await assertRejects(() => resolveCommit(repo, "--output=/tmp/x"));
    await assertRejects(() => resolveCommit(repo, "no-such-ref"));
  } finally {
    await rmrf(repo);
  }
});

Deno.test("withWorktree removes its worktree even when fn throws", async () => {
  const repo = await tempRepo();
  try {
    let seen = "";
    await assertRejects(
      () =>
        withWorktree(repo, "HEAD", undefined, async (wt) => {
          seen = wt;
          assert((await Deno.stat(`${wt}/a.txt`)).isFile);
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals(await Deno.stat(seen).catch(() => null), null);
    const list = await gitText(repo, ["worktree", "list", "--porcelain"]);
    assert(!list.includes(WORKTREE_PREFIX), list);
    assertEquals(await sh(repo, "git status --porcelain"), "");
  } finally {
    await rmrf(repo);
  }
});

Deno.test("removeStaleWorktrees removes only old throwaway worktrees", async () => {
  const repo = await tempRepo();
  const parent = await Deno.makeTempDir({ prefix: "civ-stale-test-" });
  try {
    const wt = `${parent}/${WORKTREE_PREFIX}abc`;
    await gitText(repo, ["worktree", "add", "--detach", wt, "HEAD"]);
    await removeStaleWorktrees(repo, undefined, Date.now());
    assert(
      await Deno.stat(wt).catch(() => null),
      "a fresh worktree was removed",
    );
    await removeStaleWorktrees(repo, undefined, Date.now() + 7 * 3600 * 1000);
    assertEquals(await Deno.stat(wt).catch(() => null), null);
  } finally {
    await rmrf(parent);
    await rmrf(repo);
  }
});

// ---------------------------------------------------------------------------
// refstore
// ---------------------------------------------------------------------------

Deno.test("postAttestation round-trips through a bare remote and never overwrites", async () => {
  const repo = await tempRepo();
  const remote = await Deno.makeTempDir({ prefix: "civ-remote-test-" });
  try {
    await sh(remote, "git init -q --bare .");
    await sh(repo, `git remote add origin ${remote}`);
    const commit = await gitText(repo, ["rev-parse", "HEAD"]);
    const tree = await gitText(repo, ["rev-parse", "HEAD^{tree}"]);
    const now = new Date("2026-11-11T00:00:00.000Z");

    const posted = await postAttestation(repo, {
      commit,
      tree,
      document: { hello: "world" },
      remote: "origin",
      now,
    });
    assertEquals(posted.ref, `${REF_PREFIX}/${tree}/20261111T000000000Z`);
    assert(!posted.ref.slice("refs/".length).includes(":"));
    assertEquals(await listAttestationRefs(repo, tree, "origin"), [posted.ref]);
    const body = await sh(remote, `git show ${posted.ref}:attestation.json`);
    assertEquals(JSON.parse(body), { hello: "world" });
    assertEquals(await sh(repo, "git status --porcelain"), "");

    // Same ref, different content: a non-forced push is rejected.
    await assertRejects(
      () =>
        postAttestation(repo, {
          commit,
          tree,
          document: { hello: "again" },
          remote: "origin",
          now,
        }),
      Error,
      "failed",
    );
    const still = await sh(remote, `git show ${posted.ref}:attestation.json`);
    assertEquals(JSON.parse(still), { hello: "world" });

    await assertRejects(
      () =>
        postAttestation(repo, {
          commit,
          tree: "0".repeat(40),
          document: {},
          remote: "origin",
        }),
      Error,
      "has tree",
    );
  } finally {
    await rmrf(remote);
    await rmrf(repo);
  }
});
