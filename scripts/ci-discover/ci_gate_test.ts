/**
 * Keeps the CI Gate in ci.yml complete.
 *
 * merge.yml merges only when the `CI Gate` job succeeded, and that job decides
 * from the jobs it `needs`. A blocking job added to ci.yml but not to those
 * needs would never stop a merge, and nothing else would notice. These tests
 * fail when that drift happens.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";

const CI_PATH = new URL("../../.github/workflows/ci.yml", import.meta.url);

/** Jobs that do not decide a merge, so the gate does not need them. */
const NON_GATING = new Set([
  // The gate itself.
  "ci-gate",
  // Runs only on main after a merge, to start publishing.
  "dispatch-publish",
]);

interface Job {
  name?: string;
  needs?: string | string[];
  steps?: Array<{ run?: string }>;
}

interface Workflow {
  jobs: Record<string, Job>;
}

function load(): Workflow {
  const doc = parse(Deno.readTextFileSync(CI_PATH)) as Workflow;
  assert(doc?.jobs, "ci.yml has no jobs");
  return doc;
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function gate(doc: Workflow): Job {
  const job = doc.jobs["ci-gate"];
  assert(job, "ci.yml has no ci-gate job");
  return job;
}

Deno.test("the gate job is named CI Gate, the name merge.yml looks up", () => {
  assertEquals(gate(load()).name, "CI Gate");
});

Deno.test("every job is either needed by the gate or listed as non-gating", () => {
  const doc = load();
  const needed = new Set(needsOf(gate(doc)));
  const missing = Object.keys(doc.jobs).filter((name) =>
    !needed.has(name) && !NON_GATING.has(name)
  );
  assertEquals(
    missing,
    [],
    `add these jobs to ci-gate's needs and to its script, or to NON_GATING in this test: ${
      missing.join(", ")
    }`,
  );
});

Deno.test("the gate needs only jobs that exist and are not non-gating", () => {
  const doc = load();
  for (const name of needsOf(gate(doc))) {
    assert(
      doc.jobs[name],
      `ci-gate needs '${name}', which ci.yml does not define`,
    );
    assert(
      !NON_GATING.has(name),
      `ci-gate needs '${name}', which is non-gating`,
    );
  }
});

Deno.test("the gate's script checks the result of every job it needs", () => {
  const job = gate(load());
  const script = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
  for (const name of needsOf(job)) {
    assert(
      new RegExp(`^\\s*check\\s+${name}\\s`, "m").test(script),
      `ci-gate needs '${name}' but its script never checks the result`,
    );
  }
});
