import { assert, assertEquals, assertRejects } from "@std/assert";
import { buildAttestation, summarizeGate } from "./attestation.ts";
import { gitText } from "./git.ts";
import { fileStem } from "./steps.ts";
import type { StepRecord } from "./types.ts";

const ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
};

function step(name: string, status: StepRecord["status"]): StepRecord {
  return {
    name,
    status,
    exitCode: 0,
    durationMs: 1,
    startedAt: "2026-11-10T00:00:00.000Z",
  };
}

async function repoWithRun(): Promise<{
  repo: string;
  out: string;
  commit: string;
  cleanup: () => Promise<void>;
}> {
  const repo = await Deno.makeTempDir({ prefix: "verify-att-repo-" });
  const out = await Deno.makeTempDir({ prefix: "verify-att-out-" });
  await gitText(["init", "-q", repo]);
  await Deno.writeTextFile(`${repo}/a.txt`, "a\n");
  await gitText(["add", "a.txt"], { cwd: repo });
  await gitText(["commit", "-q", "-m", "init"], { cwd: repo, env: ID });
  const commit = await gitText(["rev-parse", "HEAD"], { cwd: repo });
  await Deno.writeTextFile(
    `${out}/discover.json`,
    JSON.stringify({
      scope: "scoped",
      reason: "r",
      extensions: ["x"],
      base: commit,
    }),
  );
  await Deno.mkdir(`${out}/steps`);
  for (const s of [step("x:test", "passed"), step("x:lint", "passed")]) {
    await Deno.writeTextFile(
      `${out}/steps/${fileStem(s.name)}.json`,
      JSON.stringify(s),
    );
  }
  return {
    repo,
    out,
    commit,
    cleanup: async () => {
      await Deno.remove(repo, { recursive: true });
      await Deno.remove(out, { recursive: true });
    },
  };
}

Deno.test("the gate is recomputed from steps: any failure or skip is not a pass", () => {
  assertEquals(summarizeGate([]).allPassed, false);
  assertEquals(summarizeGate([step("a", "passed")]).allPassed, true);
  assertEquals(
    summarizeGate([step("a", "passed"), step("b", "failed")]).allPassed,
    false,
  );
  assertEquals(
    summarizeGate([step("a", "passed"), step("b", "skipped")]).allPassed,
    false,
  );
});

Deno.test("an attestation is built from the recorded run, keyed by tree", async () => {
  const f = await repoWithRun();
  try {
    const a = await buildAttestation({
      repoDir: f.repo,
      outDir: f.out,
      commit: f.commit,
      branch: "feat/x",
    });
    assertEquals(a.subject.commit, f.commit);
    assertEquals(
      a.subject.tree,
      await gitText(["rev-parse", "HEAD^{tree}"], { cwd: f.repo }),
    );
    assertEquals(a.steps.map((s) => s.name), ["x:lint", "x:test"]);
    assert(a.gate.allPassed);
    assertEquals(a.discovery.extensions, ["x"]);
    assertEquals(a.environment.deno, Deno.version.deno);
  } finally {
    await f.cleanup();
  }
});

Deno.test("building for a commit other than the checkout's HEAD is refused", async () => {
  const f = await repoWithRun();
  try {
    await assertRejects(
      () =>
        buildAttestation({
          repoDir: f.repo,
          outDir: f.out,
          commit: "f".repeat(40),
          branch: "x",
        }),
      Error,
      "not the commit being attested",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("building without a discovery record is refused", async () => {
  const f = await repoWithRun();
  try {
    await Deno.remove(`${f.out}/discover.json`);
    await assertRejects(
      () =>
        buildAttestation({
          repoDir: f.repo,
          outDir: f.out,
          commit: f.commit,
          branch: "x",
        }),
      Error,
      "discover",
    );
  } finally {
    await f.cleanup();
  }
});
