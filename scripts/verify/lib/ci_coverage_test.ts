/**
 * Keeps ci.yml and the attestation in step. Local verification and CI run the
 * same checks only if nothing is added to one and forgotten in the other, so
 * this test makes the relationship explicit and fails when it drifts:
 *
 * - every ci.yml job is classified here;
 * - every job that can block a merge is in `ci-gate`'s needs, and the gate's
 *   script checks each of them;
 * - every job claimed as attested maps to steps the attestation requires;
 * - every scripts/ tool with a test task runs in the scripts-check matrix.
 */

import { assert, assertEquals } from "@std/assert";
import { requiredStepNames } from "./types.ts";

const ROOT = new URL("../../../", import.meta.url);
const CI = await Deno.readTextFile(
  new URL(".github/workflows/ci.yml", ROOT),
);

/** Jobs whose work the attestation records, and the steps that record it. */
const ATTESTED: Record<string, string[]> = {
  "extension-check": ["x:check", "x:lint", "x:fmt:check", "x:test"],
  "reserved-data-names": ["reserved-data-names"],
  "quality-gate": ["x:quality"],
};

/**
 * Jobs that block a merge but are only partly attested, or not at all. Each is
 * a known gap in what an attestation proves. Listing one here is a decision to
 * leave it to CI; removing it means attesting it.
 */
const PARTLY_OR_NOT_ATTESTED = [
  // The manifest format check is attested; the repo-wide import-specifier and
  // zod-pin greps are not.
  "manifest-validate",
  // Runs every scripts/ tool's tasks regardless of the diff.
  "scripts-check",
  // Agent reviews: the attestation can record a verdict but no local reviewer
  // is wired in yet.
  "adversarial-review",
  "ci-security-review",
  // Selects the extensions every other job runs for; the attestation records
  // its output (discovery) and the validator recomputes it.
  "discover",
];

/** Jobs that do not decide a merge. */
const INFRASTRUCTURE = [
  "ci-gate",
  "verify-workflow",
  "attestation-shadow",
  "dispatch-publish",
];

function jobNames(): string[] {
  const after = CI.slice(CI.indexOf("\njobs:\n"));
  return [...after.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

/** The text of one job, up to the next job. */
function jobBlock(name: string): string {
  const start = CI.search(new RegExp(`^ {2}${name}:\\s*$`, "m"));
  assert(start >= 0, `job ${name} not found in ci.yml`);
  const rest = CI.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function gateNeeds(): string[] {
  const block = jobBlock("ci-gate");
  const m = block.match(/^ {4}needs:\n((?: {6}- .+\n)+)/m);
  assert(m, "ci-gate has no needs list");
  return m[1].split("\n").filter(Boolean).map((l) => l.replace(/^ +- /, ""));
}

Deno.test("every ci.yml job is classified exactly once", () => {
  const classified = [
    ...Object.keys(ATTESTED),
    ...PARTLY_OR_NOT_ATTESTED,
    ...INFRASTRUCTURE,
  ];
  assertEquals(
    new Set(classified).size,
    classified.length,
    "a job is listed in more than one category",
  );
  assertEquals(
    [...classified].sort(),
    [...jobNames()].sort(),
    "ci.yml jobs and the classification in this test differ: classify the new or removed job",
  );
});

Deno.test("ci-gate needs exactly the jobs that can block a merge", () => {
  const blocking = [...Object.keys(ATTESTED), ...PARTLY_OR_NOT_ATTESTED];
  assertEquals([...gateNeeds()].sort(), [...blocking].sort());
});

Deno.test("ci-gate's script checks every job it needs", () => {
  const block = jobBlock("ci-gate");
  for (const job of gateNeeds()) {
    assert(
      new RegExp(`^\\s+check\\s+${job}\\s`, "m").test(block),
      `ci-gate needs ${job} but its script never checks the result`,
    );
  }
});

Deno.test("every attested job maps to steps the attestation requires", () => {
  const required = new Set(requiredStepNames(["x"]));
  for (const [job, steps] of Object.entries(ATTESTED)) {
    for (const step of steps) {
      assert(
        required.has(step),
        `${job} is claimed as attested, but no required step is named ${step}`,
      );
    }
  }
});

Deno.test("advisory jobs are not in the gate", () => {
  for (const job of ["verify-workflow", "attestation-shadow"]) {
    assert(
      !gateNeeds().includes(job),
      `${job} is advisory and must not block a merge`,
    );
  }
});

Deno.test("every scripts/ tool with a test task runs in scripts-check", async () => {
  const matrix = CI.match(/dir: \[([^\]]+)\]/);
  assert(matrix, "scripts-check dir matrix not found");
  const inMatrix = new Set(matrix[1].split(",").map((s) => s.trim()));

  const withTests: string[] = [];
  for await (const e of Deno.readDir(new URL("scripts/", ROOT))) {
    if (!e.isDirectory) continue;
    try {
      const cfg = JSON.parse(
        await Deno.readTextFile(new URL(`scripts/${e.name}/deno.json`, ROOT)),
      );
      if (cfg.tasks?.test) withTests.push(e.name);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  assert(withTests.length > 0);
  for (const dir of withTests) {
    assert(
      inMatrix.has(dir),
      `scripts/${dir} has a test task but is not in the scripts-check matrix`,
    );
  }
});
