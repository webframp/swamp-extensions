import { assert, assertEquals, assertRejects } from "@std/assert";
import { git, gitText } from "./git.ts";
import {
  fetchLatestAttestation,
  listAttestationRefs,
  postAttestation,
  refFor,
  refTimestamp,
} from "./refstore.ts";
import { type Attestation, ATTESTATION_VERSION } from "./types.ts";

const ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
};

interface Fixture {
  work: string;
  remote: string;
  commit: string;
  tree: string;
  cleanup: () => Promise<void>;
}

/** A work repo with one commit and a local bare repo as its origin. */
async function fixture(): Promise<Fixture> {
  const base = await Deno.makeTempDir({ prefix: "verify-refstore-" });
  const remote = `${base}/remote.git`;
  const work = `${base}/work`;
  await gitText(["init", "-q", "--bare", remote]);
  await gitText(["init", "-q", work]);
  await Deno.writeTextFile(`${work}/a.txt`, "a\n");
  await gitText(["add", "a.txt"], { cwd: work });
  await gitText(["commit", "-q", "-m", "init"], { cwd: work, env: ID });
  await gitText(["remote", "add", "origin", remote], { cwd: work });
  const commit = await gitText(["rev-parse", "HEAD"], { cwd: work });
  const tree = await gitText(["rev-parse", "HEAD^{tree}"], { cwd: work });
  return {
    work,
    remote,
    commit,
    tree,
    cleanup: () => Deno.remove(base, { recursive: true }),
  };
}

function attestationFor(f: Fixture, note = "one"): Attestation {
  return {
    version: ATTESTATION_VERSION,
    subject: { commit: f.commit, tree: f.tree, base: f.commit, branch: note },
    discovery: { scope: "scoped", reason: "r", extensions: [], base: f.commit },
    steps: [],
    reviews: [],
    environment: { deno: "2", swamp: "x", os: "linux" },
    timing: {
      startedAt: "2026-11-10T00:00:00Z",
      completedAt: "2026-11-10T00:00:00Z",
    },
    gate: { allPassed: false, stepsTotal: 0, stepsPassed: 0, stepsSkipped: 0 },
  };
}

Deno.test("timestamps sort in time order and are valid in a ref name", () => {
  const a = refTimestamp(new Date("2026-11-10T01:02:03.004Z"));
  const b = refTimestamp(new Date("2026-11-10T01:02:03.005Z"));
  assertEquals(a, "20261110T010203004Z");
  assert(a < b);
  assertEquals(
    refFor("t", new Date("2026-11-10T01:02:03.004Z")),
    `refs/attestations/t/${a}`,
  );
});

Deno.test("a posted attestation round-trips through a fresh clone", async () => {
  const f = await fixture();
  try {
    const posted = await postAttestation(f.work, attestationFor(f), {
      now: new Date("2026-11-10T01:00:00.000Z"),
    });
    assertEquals(
      posted.ref,
      refFor(f.tree, new Date("2026-11-10T01:00:00.000Z")),
    );

    // A repository that has never seen the work repo's objects.
    const other = await Deno.makeTempDir({ prefix: "verify-fresh-" });
    try {
      await gitText(["init", "-q", other]);
      await gitText(["remote", "add", "origin", f.remote], { cwd: other });
      const got = await fetchLatestAttestation(other, f.tree);
      assert(got);
      assertEquals(got.ref, posted.ref);
      assertEquals(got.attestation.subject.tree, f.tree);
    } finally {
      await Deno.remove(other, { recursive: true });
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("the newest attestation for a tree wins", async () => {
  const f = await fixture();
  try {
    await postAttestation(f.work, attestationFor(f, "older"), {
      now: new Date("2026-11-10T01:00:00.000Z"),
    });
    await postAttestation(f.work, attestationFor(f, "newer"), {
      now: new Date("2026-11-10T02:00:00.000Z"),
    });
    assertEquals((await listAttestationRefs(f.work, f.tree)).length, 2);
    const got = await fetchLatestAttestation(f.work, f.tree);
    assertEquals(got?.attestation.subject.branch, "newer");
  } finally {
    await f.cleanup();
  }
});

Deno.test("an existing attestation cannot be overwritten without force", async () => {
  const f = await fixture();
  try {
    const now = new Date("2026-11-10T01:00:00.000Z");
    await postAttestation(f.work, attestationFor(f, "original"), { now });
    await assertRejects(
      () => postAttestation(f.work, attestationFor(f, "replacement"), { now }),
      Error,
      "pushing",
    );
    const got = await fetchLatestAttestation(f.work, f.tree);
    assertEquals(got?.attestation.subject.branch, "original");
  } finally {
    await f.cleanup();
  }
});

Deno.test("no attestation for a tree reads as null", async () => {
  const f = await fixture();
  try {
    assertEquals(await fetchLatestAttestation(f.work, f.tree), null);
  } finally {
    await f.cleanup();
  }
});

Deno.test("an attestation whose tree is not its commit's tree is refused", async () => {
  const f = await fixture();
  try {
    const a = attestationFor(f);
    a.subject.tree = "0".repeat(40);
    await assertRejects(() => postAttestation(f.work, a), Error, "claims tree");
    assertEquals((await listAttestationRefs(f.work, "0".repeat(40))).length, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a ref holding malformed JSON throws instead of reading as none", async () => {
  const f = await fixture();
  try {
    const blob = await gitText(["hash-object", "-w", "--stdin"], {
      cwd: f.work,
      stdin: "not json{",
    });
    const dir = await gitText(["mktree"], {
      cwd: f.work,
      stdin: `100644 blob ${blob}\tattestation.json\n`,
    });
    const c = await gitText(["commit-tree", dir, "-m", "bad"], {
      cwd: f.work,
      env: ID,
    });
    const push = await git([
      "push",
      "origin",
      `${c}:${refFor(f.tree, new Date())}`,
    ], {
      cwd: f.work,
    });
    assert(push.ok);
    await assertRejects(
      () => fetchLatestAttestation(f.work, f.tree),
      Error,
      "not valid JSON",
    );
  } finally {
    await f.cleanup();
  }
});
