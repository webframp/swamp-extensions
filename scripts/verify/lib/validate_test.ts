import { assert, assertEquals } from "@std/assert";
import {
  MAX_AGE_MS,
  renderSummary,
  validateAttestation,
  type ValidationInput,
  WARN_AGE_MS,
} from "./validate.ts";
import {
  type Attestation,
  ATTESTATION_VERSION,
  requiredStepNames,
  type StepRecord,
} from "./types.ts";

const NOW = new Date("2026-11-10T12:00:00Z");
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

function step(
  name: string,
  status: StepRecord["status"] = "passed",
): StepRecord {
  return {
    name,
    status,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 10,
    startedAt: NOW.toISOString(),
  };
}

function attestation(
  extensions: string[],
  over: Partial<Attestation> = {},
): Attestation {
  const steps = requiredStepNames(extensions).map((n) => step(n));
  return {
    version: ATTESTATION_VERSION,
    subject: { commit: COMMIT, tree: TREE, base: "c".repeat(40), branch: "x" },
    discovery: {
      scope: "scoped",
      reason: "r",
      extensions,
      base: "c".repeat(40),
    },
    steps,
    reviews: [{ name: "adversarial", verdict: "pass" }],
    environment: { deno: "2.9.8", swamp: "x", os: "linux" },
    timing: { startedAt: NOW.toISOString(), completedAt: NOW.toISOString() },
    gate: {
      allPassed: true,
      stepsTotal: steps.length,
      stepsPassed: steps.length,
      stepsSkipped: 0,
    },
    ...over,
  };
}

function input(
  a: Attestation,
  expected: string[],
  over: Partial<ValidationInput> = {},
): ValidationInput {
  return {
    attestation: a,
    headCommit: COMMIT,
    headTree: TREE,
    expectedExtensions: expected,
    trustRootChanges: [],
    now: NOW,
    ...over,
  };
}

Deno.test("a complete, fresh attestation passes clean", () => {
  const r = validateAttestation(input(attestation(["aws/a"]), ["aws/a"]));
  assertEquals(r.errors, []);
  assertEquals(r.warnings, []);
  assert(r.gate.allPassed);
});

Deno.test("an attestation for a different tree fails", () => {
  const a = attestation(["aws/a"]);
  a.subject.tree = "d".repeat(40);
  const r = validateAttestation(input(a, ["aws/a"]));
  assert(r.errors.some((e) => e.includes("tree")));
});

Deno.test("an attestation that examined fewer extensions than the PR touches fails", () => {
  // The scenario behind DR-1: local discovery ran against a stale base and
  // selected one extension; the PR touches two.
  const a = attestation(["aws/a"]);
  const r = validateAttestation(input(a, ["aws/a", "aws/b"]));
  assert(
    r.errors.some((e) => e.includes("did not cover") && e.includes("aws/b")),
  );
  assert(r.errors.some((e) => e.includes("missing")));
});

Deno.test("an attestation that claims coverage without its steps fails", () => {
  const a = attestation(["aws/a", "aws/b"]);
  a.steps = a.steps.filter((s) => !s.name.startsWith("aws/b:"));
  const r = validateAttestation(input(a, ["aws/a", "aws/b"]));
  assert(r.errors.some((e) => e.includes("required step(s) missing")));
});

Deno.test("a failed required step fails", () => {
  const a = attestation(["aws/a"]);
  a.steps = a.steps.map((s) =>
    s.name === "aws/a:test" ? { ...s, status: "failed" as const } : s
  );
  const r = validateAttestation(input(a, ["aws/a"]));
  assert(r.errors.some((e) => e.includes("aws/a:test (failed)")));
  assertEquals(r.gate.allPassed, false);
});

Deno.test("a skipped required step does not satisfy the requirement", () => {
  const a = attestation(["aws/a"]);
  a.steps = a.steps.map((s) =>
    s.name === "aws/a:quality" ? { ...s, status: "skipped" as const } : s
  );
  const r = validateAttestation(input(a, ["aws/a"]));
  assert(r.errors.some((e) => e.includes("aws/a:quality (skipped)")));
});

Deno.test("an attested gate that lies is overridden by the steps", () => {
  const a = attestation(["aws/a"]);
  a.steps = a.steps.map((s) =>
    s.name === "aws/a:lint" ? { ...s, status: "failed" as const } : s
  );
  a.gate.allPassed = true;
  const r = validateAttestation(input(a, ["aws/a"]));
  assert(r.errors.length > 0);
  assert(r.warnings.some((w) => w.includes("disagrees")));
});

Deno.test("extra attested extensions beyond the PR are fine", () => {
  const a = attestation(["aws/a", "aws/b"]);
  const r = validateAttestation(input(a, ["aws/a"]));
  assertEquals(r.errors, []);
});

Deno.test("freshness warns past 24 hours and fails past the limit", () => {
  const warn = attestation(["aws/a"]);
  warn.timing.completedAt = new Date(NOW.getTime() - WARN_AGE_MS - 60_000)
    .toISOString();
  const w = validateAttestation(input(warn, ["aws/a"]));
  assertEquals(w.errors, []);
  assert(w.warnings.some((x) => x.includes("old")));

  const old = attestation(["aws/a"]);
  old.timing.completedAt = new Date(NOW.getTime() - MAX_AGE_MS - 60_000)
    .toISOString();
  const o = validateAttestation(input(old, ["aws/a"]));
  assert(o.errors.some((e) => e.includes("day(s) old")));
});

Deno.test("a missing completion time fails", () => {
  const a = attestation(["aws/a"]);
  a.timing.completedAt = "not a date";
  const r = validateAttestation(input(a, ["aws/a"]));
  assert(r.errors.some((e) => e.includes("completion time")));
});

Deno.test("a review that did not pass fails; no review only warns", () => {
  const bad = attestation(["aws/a"], {
    reviews: [{ name: "adversarial", verdict: "missing" }],
  });
  assert(
    validateAttestation(input(bad, ["aws/a"])).errors.some((e) =>
      e.includes("adversarial (missing)")
    ),
  );

  const none = attestation(["aws/a"], { reviews: [] });
  const r = validateAttestation(input(none, ["aws/a"]));
  assertEquals(r.errors, []);
  assert(r.warnings.some((w) => w.includes("no review")));
});

Deno.test("a changed trust root warns, and fails in strict mode", () => {
  const a = attestation(["aws/a"]);
  const changes = ["scripts/verify/main.ts"];
  const loose = validateAttestation(
    input(a, ["aws/a"], { trustRootChanges: changes }),
  );
  assertEquals(loose.errors, []);
  assert(loose.warnings.some((w) => w.includes("verification tooling")));

  const strict = validateAttestation(
    input(a, ["aws/a"], { trustRootChanges: changes, strict: true }),
  );
  assert(strict.errors.some((e) => e.includes("verification tooling")));
});

Deno.test("a different Deno version warns", () => {
  const r = validateAttestation(input(attestation(["aws/a"]), ["aws/a"], {
    expectDeno: "2.9.9",
  }));
  assertEquals(r.errors, []);
  assert(r.warnings.some((w) => w.includes("2.9.9")));
});

Deno.test("a different commit with the same tree only warns", () => {
  const r = validateAttestation(
    input(attestation(["aws/a"]), ["aws/a"], { headCommit: "e".repeat(40) }),
  );
  assertEquals(r.errors, []);
  assert(r.warnings.some((w) => w.includes("same tree")));
});

Deno.test("an unknown version fails", () => {
  const a = attestation(["aws/a"]);
  (a as unknown as { version: number }).version = 99;
  assert(
    validateAttestation(input(a, ["aws/a"])).errors.some((e) =>
      e.includes("unknown attestation version")
    ),
  );
});

Deno.test("the summary renders untrusted text as inert code spans", () => {
  const md = renderSummary(COMMIT, TREE, "refs/x", {
    errors: ["bad `name`\n[link](http://evil)"],
    warnings: [],
    gate: { allPassed: false, passed: 0, failed: 0, skipped: 0 },
  });
  assert(!md.includes("`name`"));
  assert(md.includes("❌ Failed"));
  // Newlines inside an error cannot start a new markdown line of their own.
  assert(!md.includes("\n[link]"));
});
