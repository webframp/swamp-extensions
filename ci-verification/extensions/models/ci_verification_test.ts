// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end tests of the model's methods against a real temporary git
 * repository shaped like swamp-extensions, with a fake `swamp` on PATH. Nothing
 * here reaches the network or the real swamp CLI.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261030.68";
import {
  COVERAGE,
  EXTENSION_TASKS,
  model,
  MODEL_VERSION,
  names,
} from "./ci_verification.ts";
import { childEnv, run } from "./_lib/exec.ts";
import { WORKTREE_PREFIX } from "./_lib/git.ts";

type Ctx = Parameters<typeof model.methods.discover.execute>[1];
type Stored = Record<string, Record<string, unknown>>;

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
  return r.stdout.trim();
}

async function write(path: string, text: string) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, text);
}

const passTasks = Object.fromEntries(EXTENSION_TASKS.map((t) => [t, "exit 0"]));

const QUALITY_PASS = JSON.stringify({
  status: "passed",
  percentage: 87,
  ifProvisionalEarned: { percentage: 100 },
});
const QUALITY_FAIL = JSON.stringify({ status: "passed", percentage: 92 });

interface Fixture {
  repo: string;
  base: string;
  head: string;
  tree: string;
  /** A second commit with head's tree. */
  twin: string;
  remote: string;
  cleanup: () => Promise<void>;
}

/**
 * A repository with a fixture ci-discover, a reserved-name scanner, and two
 * extensions. ext-a's test task fails unless it runs with a throwaway HOME and
 * without the operator's AWS_PROFILE. group/ext-b fails its test and its
 * quality score when `bFails` is set.
 */
async function fixture(
  bFails: boolean,
  touchTrustRoot = true,
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "civ-model-test-" });
  const repo = `${root}/repo`;
  const remote = `${root}/remote.git`;
  const bin = `${root}/bin`;

  await write(
    `${repo}/scripts/ci-discover/deno.json`,
    JSON.stringify({
      tasks: { discover: "deno run discover.ts", ...passTasks },
    }),
  );
  await write(
    `${repo}/scripts/ci-discover/discover.ts`,
    `console.log(JSON.stringify({ scope: "scoped", reason: "fixture", extensions: ["ext-a", "group/ext-b"] }));\n`,
  );
  await write(
    `${repo}/scripts/check-reserved-names/deno.json`,
    // deno task appends the scanned path, so the task must accept an argument.
    JSON.stringify({ tasks: { scan: "echo scanned" } }),
  );
  await write(
    `${repo}/ext-a/deno.json`,
    JSON.stringify({ tasks: { ...passTasks, test: "bash ./check-env.sh" } }),
  );
  await write(
    `${repo}/ext-a/check-env.sh`,
    [
      'case "$HOME" in *ci-verification-home-*) ;; *) echo "real HOME: $HOME"; exit 1;; esac',
      '[ -z "${AWS_PROFILE:-}" ] || { echo "AWS_PROFILE leaked"; exit 1; }',
      "",
    ].join("\n"),
  );
  await write(`${repo}/ext-a/quality.json`, QUALITY_PASS);
  await write(
    `${repo}/group/ext-b/deno.json`,
    JSON.stringify({
      tasks: { ...passTasks, test: bFails ? "exit 1" : "exit 0" },
    }),
  );
  await write(
    `${repo}/group/ext-b/quality.json`,
    bFails ? QUALITY_FAIL : QUALITY_PASS,
  );

  await write(
    `${bin}/swamp`,
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      '  "--version "*) echo "swamp 0.0.0-test" ;;',
      '  "extension fmt") exit 0 ;;',
      '  "extension quality") cat quality.json ;;',
      "  *) exit 64 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await Deno.chmod(`${bin}/swamp`, 0o755);

  await sh(
    repo,
    "git init -q -b main . && git add -A && git commit -q -m base",
  );
  const base = await sh(repo, "git rev-parse HEAD");
  if (touchTrustRoot) {
    await write(`${repo}/scripts/ci-discover/README.md`, "changed\n");
  }
  await write(`${repo}/ext-a/notes.txt`, "changed\n");
  await sh(repo, "git add -A && git commit -q -m head");
  const head = await sh(repo, "git rev-parse HEAD");
  const tree = await sh(repo, "git rev-parse HEAD^{tree}");
  await sh(repo, "git commit -q --allow-empty -m twin");
  const twin = await sh(repo, "git rev-parse HEAD");
  await sh(repo, `git checkout -q ${head}`);
  await sh(root, `git init -q --bare ${remote}`);
  await sh(repo, `git remote add origin ${remote}`);

  const oldPath = Deno.env.get("PATH") ?? "";
  const oldAws = Deno.env.get("AWS_PROFILE");
  Deno.env.set("PATH", `${bin}:${oldPath}`);
  Deno.env.set("AWS_PROFILE", "civ-leak-probe");

  return {
    repo,
    base,
    head,
    tree,
    twin,
    remote,
    cleanup: async () => {
      Deno.env.set("PATH", oldPath);
      if (oldAws === undefined) Deno.env.delete("AWS_PROFILE");
      else Deno.env.set("AWS_PROFILE", oldAws);
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

function ctx(storedResources: Stored = {}) {
  const t = createModelTestContext({ storedResources });
  return { ...t, ctx: t.context as unknown as Ctx };
}

/** Everything a context has written, as the next run's stored data. */
function stored(t: ReturnType<typeof ctx>, seed: Stored = {}): Stored {
  const out: Stored = structuredClone(seed);
  for (const r of t.getWrittenResources()) {
    out[r.name] = structuredClone(r.data as Record<string, unknown>);
  }
  return out;
}

async function discover(f: Fixture, t: ReturnType<typeof ctx>) {
  await model.methods.discover.execute(
    { repoPath: f.repo, commit: f.head, base: f.base },
    t.ctx,
  );
}

async function check(f: Fixture, t: ReturnType<typeof ctx>, commit = f.head) {
  await model.methods.check.execute(
    { repoPath: f.repo, commit, concurrency: 2 },
    t.ctx,
  );
}

async function quality(f: Fixture, t: ReturnType<typeof ctx>) {
  await model.methods.quality.execute(
    { repoPath: f.repo, commit: f.head, concurrency: 2 },
    t.ctx,
  );
}

async function attest(
  f: Fixture,
  t: ReturnType<typeof ctx>,
  reviews: Array<{ name: string; verdict: "pass" | "fail" }> = [
    { name: "code-review", verdict: "pass" },
  ],
  commit = f.head,
  approvals: Array<{ gateId: string; decision: string }> = [
    { gateId: "release-approval", decision: "approve" },
  ],
) {
  await model.methods.attest.execute(
    {
      repoPath: f.repo,
      commit,
      reviews,
      approvals,
    },
    t.ctx,
  );
}

const REPO_CHECKS = [
  "reserved-data-names",
  "bare-import-specifiers",
  "zod-pin",
  ...EXTENSION_TASKS.map((task) => `scripts/ci-discover:${task}`),
];

async function assertCheckoutUntouched(f: Fixture) {
  assertEquals(await sh(f.repo, "git status --porcelain"), "");
  assertEquals(await sh(f.repo, "git rev-parse HEAD"), f.head);
  const list = await sh(f.repo, "git worktree list --porcelain");
  assert(!list.includes(WORKTREE_PREFIX), list);
}

Deno.test("discover records the selection from the commit's own ci-discover", async () => {
  const f = await fixture(true);
  try {
    const t = ctx();
    await discover(f, t);
    const [w] = t.getWrittenResources();
    assertEquals(w.specName, "selection");
    assertEquals(w.name, names.selection(f.tree));
    const sel = w.data as Record<string, unknown>;
    assertEquals(sel.commit, f.head);
    assertEquals(sel.base, f.base);
    assertEquals(sel.baseIsAncestor, true);
    assertEquals(sel.scope, "scoped");
    assertEquals(sel.extensions, [
      { dir: "ext-a", slug: "ext-a" },
      { dir: "group/ext-b", slug: "group.ext-b" },
    ]);
    assertEquals(sel.repoChecks, REPO_CHECKS);
    assertEquals(sel.trustRootChanged, ["scripts/ci-discover/README.md"]);
    assertEquals(sel.modelVersion, MODEL_VERSION);
    assertMatch(String(sel.selectionId), /^[0-9a-f]{64}$/);
    await assertCheckoutUntouched(f);
  } finally {
    await f.cleanup();
  }
});

Deno.test("check records every result and log, fails on a failing extension, then reruns only failures", async () => {
  const f = await fixture(true);
  try {
    const t = ctx();
    await discover(f, t);
    await assertRejects(
      () => check(f, t),
      Error,
      "1 check(s) failed: group/ext-b",
    );

    const written = t.getWrittenResources();
    const a = written.find((r) => r.name === names.check(f.tree, "ext-a"));
    const b = written.find((r) =>
      r.name === names.check(f.tree, "group.ext-b")
    );
    // ext-a passing proves its tasks ran with a throwaway HOME and no AWS_PROFILE.
    assertEquals(a?.data.status, "passed");
    assertEquals(b?.data.status, "failed");
    const bResults = b?.data.results as Array<{ name: string; status: string }>;
    assertEquals(bResults.map((r) => r.name), [
      ...EXTENSION_TASKS,
      "manifest-fmt",
    ]);
    assertEquals(
      bResults.filter((r) => r.status === "failed").map((r) => r.name),
      ["test"],
    );
    for (const c of REPO_CHECKS) {
      const r = written.find((w) => w.name === names.repoCheck(f.tree, c));
      assertEquals(r?.specName, "repocheck", c);
      assertEquals(r?.data.status, "passed", c);
    }
    // One log per result, each named by the result that points at it.
    const files = t.getWrittenFiles();
    assertEquals(files.length, 2 + REPO_CHECKS.length);
    for (const w of written.filter((w) => w.specName !== "selection")) {
      assert(files.some((f) => f.name === w.data.log), String(w.data.log));
    }
    const bLog = new TextDecoder().decode(
      files.find((x) => x.name === b?.data.log)?.content,
    );
    assert(bLog.includes("deno task test (exit 1)"), bLog);
    await assertCheckoutUntouched(f);

    // A rerun reuses passed results and runs the failed one again.
    const t2 = ctx(stored(t));
    await assertRejects(() => check(f, t2), Error, "group/ext-b");
    assertEquals(
      t2.getWrittenResources().map((r) => r.name),
      [names.check(f.tree, "group.ext-b")],
    );

    // A result recorded with other tools is not reused.
    const seed = stored(t);
    (seed[names.check(f.tree, "ext-a")].tools as { deno: string }).deno =
      "deno 0.0.0";
    const t3 = ctx(seed);
    await assertRejects(() => check(f, t3));
    assert(
      t3.getWrittenResources().some((r) =>
        r.name === names.check(f.tree, "ext-a")
      ),
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("check and attest refuse a selection recorded for another commit with the same tree", async () => {
  const f = await fixture(false);
  try {
    const t = ctx();
    await discover(f, t);
    await assertRejects(() => check(f, t, f.twin), Error, "run discover again");
    await assertRejects(
      () => attest(f, t, [], f.twin),
      Error,
      "run discover again",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("quality applies CI's pass condition per extension", async () => {
  const f = await fixture(true);
  try {
    const t = ctx();
    await discover(f, t);
    await assertRejects(
      () => quality(f, t),
      Error,
      "quality failed for 1 extension(s): group/ext-b",
    );
    const q = (s: string) =>
      t.getWrittenResources().find((r) => r.name === names.quality(f.tree, s))
        ?.data;
    assertEquals(q("ext-a")?.status, "passed");
    assertEquals(q("ext-a")?.percentage, 87);
    assertEquals(q("ext-a")?.provisionalPercentage, 100);
    assertEquals(q("group.ext-b")?.status, "failed");
    assertMatch(String(q("group.ext-b")?.reason), /score is 92%/);
    await assertCheckoutUntouched(f);
  } finally {
    await f.cleanup();
  }
});

Deno.test("attest refuses while any selected check has failed", async () => {
  const f = await fixture(true);
  try {
    const t = ctx();
    await discover(f, t);
    await assertRejects(() => check(f, t));
    await assertRejects(() => quality(f, t));
    const err = await assertRejects(() => attest(f, t), Error);
    assert(err.message.includes("group/ext-b checks: failed"), err.message);
    assert(err.message.includes("group/ext-b quality: failed"), err.message);
    assert(!t.getWrittenResources().some((r) => r.specName === "attestation"));
  } finally {
    await f.cleanup();
  }
});

Deno.test("attest builds the attestation from recorded results, recomputes the gate, and post pushes it", async () => {
  const f = await fixture(false);
  try {
    const t = ctx();
    await discover(f, t);
    await check(f, t);
    await quality(f, t);
    const passing = stored(t);

    const ta = ctx(passing);
    await attest(f, ta);
    const att = ta.getWrittenResources().find((r) =>
      r.specName === "attestation"
    );
    assertEquals(att?.name, names.attestation(f.tree));
    // deno-lint-ignore no-explicit-any
    const a = att!.data as Record<string, any>;
    assertEquals(a.subject.commit, f.head);
    assertEquals(a.subject.tree, f.tree);
    assertEquals(a.discovery.extensions, ["ext-a", "group/ext-b"]);
    assertEquals(a.gate, {
      allPassed: true,
      extensions: 2,
      checks: 2 * (EXTENSION_TASKS.length + 1 + 1) + REPO_CHECKS.length,
    });
    assertEquals(a.coverage, {
      covered: [...COVERAGE.covered],
      notCovered: [...COVERAGE.notCovered],
    });
    assertEquals(a.reviewsAndApprovalsCallerAsserted, true);
    assertEquals(a.trustRootChanged, ["scripts/ci-discover/README.md"]);
    assertEquals(a.requiresSignOff, true);
    assertEquals(a.reviews, [{ name: "code-review", verdict: "pass" }]);

    // The gate is recomputed from stored results: any one bad result refuses.
    const extA = names.check(f.tree, "ext-a");
    const qualB = names.quality(f.tree, "group.ext-b");
    const zod = names.repoCheck(f.tree, "zod-pin");
    const mutations: Array<[string, (s: Stored) => void, string]> = [
      ["failed check", (s) => (s[extA].status = "failed"), "ext-a checks"],
      ["missing quality", (s) => delete s[qualB], "quality: no result"],
      [
        "other selection",
        (s) => (s[zod].selectionId = "x"),
        "another selection",
      ],
      [
        "other model version",
        (s) => (s[extA].modelVersion = "2000.01.01.1"),
        "model version 2000.01.01.1",
      ],
    ];
    for (const [label, mutate, expected] of mutations) {
      const seed = structuredClone(passing);
      mutate(seed);
      const tm = ctx(seed);
      const err = await assertRejects(() => attest(f, tm), Error);
      assert(err.message.includes(expected), `${label}: ${err.message}`);
      assert(
        !tm.getWrittenResources().some((r) => r.specName === "attestation"),
        label,
      );
    }
    const tr = ctx(passing);
    await assertRejects(
      () => attest(f, tr, [{ name: "code-review", verdict: "fail" }]),
      Error,
      "review code-review: fail",
    );

    // The change touches scripts/ci-discover/, so a pass needs an approval
    // whose decision is "approve".
    const tn = ctx(passing);
    await assertRejects(
      () => attest(f, tn, undefined, f.head, []),
      Error,
      'trust root changed (scripts/ci-discover/README.md): an approval with decision "approve" is required',
    );
    assert(!tn.getWrittenResources().some((r) => r.specName === "attestation"));
    // Any approval that is not "approve" refuses, even beside an approval.
    const notApproved: Array<
      [string, Array<{ gateId: string; decision: string }>, string]
    > = [
      [
        "a rejection",
        [{ gateId: "release-approval", decision: "reject" }],
        'approval release-approval: decision is "reject", not "approve"',
      ],
      [
        "another decision",
        [{ gateId: "release-approval", decision: "approved" }],
        'approval release-approval: decision is "approved", not "approve"',
      ],
      [
        "a rejection beside an approval",
        [
          { gateId: "quality-waiver", decision: "reject" },
          { gateId: "release-approval", decision: "approve" },
        ],
        'approval quality-waiver: decision is "reject", not "approve"',
      ],
    ];
    for (const [label, approvals, expected] of notApproved) {
      const ts = ctx(passing);
      await assertRejects(
        () => attest(f, ts, undefined, f.head, approvals),
        Error,
        expected,
        label,
      );
      assert(
        !ts.getWrittenResources().some((r) => r.specName === "attestation"),
        label,
      );
    }

    // post pushes the stored attestation as a ref, and refuses a twin commit.
    const tp = ctx(stored(ta, passing));
    await model.methods.post.execute(
      { repoPath: f.repo, commit: f.head, remote: "origin" },
      tp.ctx,
    );
    const posted = tp.getWrittenResources()[0];
    assertEquals(posted.specName, "posted");
    const ref = String(posted.data.ref);
    assertMatch(
      ref,
      new RegExp(`^refs/attestations/${f.tree}/\\d{8}T\\d{9}Z$`),
    );
    const body = JSON.parse(
      await sh(f.remote, `git show ${ref}:attestation.json`),
    );
    assertEquals(body.subject.tree, f.tree);
    assertEquals(body.gate.allPassed, true);
    await assertRejects(
      () =>
        model.methods.post.execute(
          { repoPath: f.repo, commit: f.twin, remote: "origin" },
          ctx(stored(ta, passing)).ctx,
        ),
      Error,
      "is for commit",
    );
    await assertCheckoutUntouched(f);
  } finally {
    await f.cleanup();
  }
});

Deno.test("the model version matches manifest.yaml", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../../manifest.yaml", import.meta.url),
  );
  const m = manifest.match(/^version: "([^"]+)"$/m);
  assertEquals(m?.[1], model.version);
  assertEquals(MODEL_VERSION, model.version);
});

Deno.test("attest needs no approval when the trust root is untouched", async () => {
  const f = await fixture(false, false);
  try {
    const t = ctx();
    await discover(f, t);
    await check(f, t);
    await quality(f, t);
    await attest(f, t, [], f.head, []);
    const att = t.getWrittenResources().find((r) =>
      r.specName === "attestation"
    );
    assertEquals(att?.data.trustRootChanged, []);
    assertEquals(att?.data.requiresSignOff, false);
    assertEquals(att?.data.approvals, []);
  } finally {
    await f.cleanup();
  }
});

Deno.test("every workflow step names the model type, so swamp creates the instance", async () => {
  const yaml = await Deno.readTextFile(
    new URL("../workflows/verify.yaml", import.meta.url),
  );
  const tasks = yaml.split(/\n\s+task:\n/).slice(1);
  assertEquals(tasks.length, 3);
  const methods: string[] = [];
  for (const task of tasks) {
    assertMatch(task, /^\s+type: model_method$/m);
    assertMatch(task, /^\s+modelType: "@webframp\/ci-verification"$/m);
    assertMatch(task, /^\s+modelName: ci-verification$/m);
    assert(
      !/modelIdOrName/.test(task),
      "a step must not need an existing instance",
    );
    const m = task.match(/^\s+methodName: (\S+)$/m);
    assert(m, task);
    methods.push(m[1]);
  }
  assertEquals(methods, ["discover", "check", "quality"]);
  for (const name of methods) assert(name in model.methods, name);
  assertEquals(model.type, "@webframp/ci-verification");
});
