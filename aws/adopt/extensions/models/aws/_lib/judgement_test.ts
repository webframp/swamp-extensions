// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import type { AdoptionCandidate } from "./adoption.ts";
import {
  assignWaves,
  buildJudgeRequest,
  canonicalJson,
  decideCandidates,
  DEFAULT_DECIDE_OPTIONS,
  DISPOSITIONS,
  itemsFingerprint,
  JUDGE_QUESTIONS,
  type Judgement,
  normalizeScore,
  type PlanView,
  readAnswers,
  settle,
} from "./judgement.ts";

// =============================================================================
// Fixtures
// =============================================================================

function candidate(
  cfnType: string,
  identifier: string,
  over: Partial<AdoptionCandidate> = {},
): AdoptionCandidate {
  const service = cfnType.split("::")[1].toLowerCase();
  return {
    id: `${cfnType}/${identifier}`,
    swampType: `@swamp/aws/${service}/x`,
    cfnType,
    identifier,
    region: "us-east-1",
    scope: "sweep",
    dependsOn: [],
    tags: {},
    modelName: `adopt-${service}-${identifier}`,
    cfnStack: null,
    swampManaged: false,
    flags: [],
    judgeState: { Name: identifier },
    ...over,
  };
}

function plan(candidates: AdoptionCandidate[]): PlanView {
  return {
    scope: "sweep",
    accountId: "111111111111",
    region: "us-east-1",
    stackName: null,
    candidates,
    fetchedAt: "2026-09-26T00:00:00.000Z",
  };
}

const VPC = candidate("AWS::EC2::VPC", "vpc-app");
const SUBNET = candidate("AWS::EC2::Subnet", "subnet-app", {
  dependsOn: [VPC.id],
});
const BUCKET = candidate("AWS::S3::Bucket", "app-data");
const QUEUE = candidate("AWS::SQS::Queue", "jobs");

function score(value: number, levels = 4, confidence = 0.9) {
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) {
    legend[String(i)] = `level ${i}`;
    probabilities[String(i)] = 0;
  }
  return { type: "score", score: value, legend, probabilities, confidence };
}

function answers(
  disposition: string,
  over: {
    confidence?: number;
    blast?: number;
    owned?: number;
    risk?: number;
  } = {},
) {
  return {
    disposition: {
      type: "choice",
      choice: disposition,
      probabilities: {},
      confidence: over.confidence ?? 0.9,
    },
    blast_radius: score(over.blast ?? 0),
    controller_owned: { type: "noul", noul: over.owned ?? 0.1 },
    risk: score(over.risk ?? 0),
  };
}

async function batchFor(
  p: PlanView,
  byCandidate: Record<string, Record<string, unknown>>,
  failures: string[] = [],
): Promise<Judgement> {
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 100);
  const idOf = Object.fromEntries(
    Object.entries(request.itemCandidates).map(([item, c]) => [c, item]),
  );
  return {
    sourceFingerprint: request.fingerprint,
    results: Object.entries(byCandidate).map(([c, a]) => ({
      id: idOf[c],
      answers: a,
    })),
    failures: failures.map((c) => ({
      id: idOf[c],
      reason: "evaluation unavailable",
    })),
    model: "jev-latest",
    evaluatedAt: "2026-09-26T00:01:00.000Z",
  };
}

async function decide(
  p: PlanView,
  judgement: Judgement | null,
  judge = true,
) {
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 100);
  return decideCandidates(p, request, judgement, {
    judge,
    ...DEFAULT_DECIDE_OPTIONS,
  });
}

function decisionFor(
  d: Awaited<ReturnType<typeof decide>>,
  c: AdoptionCandidate,
) {
  return d.decisions.find((x) => x.id === c.id)!;
}

// =============================================================================
// Questions and settlement
// =============================================================================

Deno.test("JUDGE_QUESTIONS asks the four design questions", () => {
  assertEquals(Object.keys(JUDGE_QUESTIONS).sort(), [
    "blast_radius",
    "controller_owned",
    "disposition",
    "risk",
  ]);
  assertEquals(
    Object.keys(JUDGE_QUESTIONS.disposition.criteria),
    [...DISPOSITIONS],
  );
  assertEquals(JUDGE_QUESTIONS.blast_radius.criteria.length, 4);
  assertEquals(JUDGE_QUESTIONS.risk.criteria.length, 4);
});

Deno.test("settle excludes controller-owned flags and keeps cfn-stack for jev", () => {
  assertEquals(settle({ flags: ["asg-managed"] })?.disposition, "exclude");
  assertEquals(
    settle({ flags: ["service-linked-role"] })?.disposition,
    "exclude",
  );
  assertEquals(settle({ flags: ["default-vpc"] })?.disposition, "observe-only");
  assertEquals(settle({ flags: ["cfn-stack"] }), null);
  assertEquals(settle({ flags: [] }), null);
});

Deno.test("settle lets read-failed win over every other flag", () => {
  assertEquals(
    settle({ flags: ["default-vpc", "read-failed"] })?.flag,
    "read-failed",
  );
});

// =============================================================================
// Judge request
// =============================================================================

Deno.test("buildJudgeRequest sends only unmanaged, unsettled candidates", async () => {
  const p = plan([
    VPC,
    SUBNET,
    candidate("AWS::S3::Bucket", "cdk-x-assets-1", { flags: ["cdk-assets"] }),
    candidate("AWS::S3::Bucket", "managed", { swampManaged: true }),
  ]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 100);
  assertEquals(
    Object.values(request.itemCandidates).sort(),
    [
      SUBNET.id,
      VPC.id,
    ].sort(),
  );
  assertEquals(request.counts, {
    candidates: 4,
    alreadyManaged: 1,
    settled: 1,
    judged: 2,
    overflow: 0,
  });
  assertEquals(request.items[0].id, VPC.modelName, "rank order: VPC first");
  assertEquals(request.items[0].state.attributes, VPC.judgeState);
  assertMatch(request.batchName, /^adopt-[0-9a-f]{8}$/);
});

Deno.test("buildJudgeRequest records candidates over the cap as overflow", async () => {
  const p = plan([VPC, SUBNET, BUCKET]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 2);
  assertEquals(request.items.length, 2);
  assertEquals(request.overflow, [BUCKET.id]);
  assertEquals(request.counts.overflow, 1);
});

Deno.test("the fingerprint survives a JSON round trip, as through a workflow", async () => {
  const p = plan([
    candidate("AWS::EC2::SecurityGroup", "sg-1", {
      judgeState: {
        SecurityGroupIngress: [{ FromPort: 443, CidrIp: "0.0.0.0/0" }],
      },
    }),
  ]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 100);
  const transported = JSON.parse(JSON.stringify(request.items));
  assertEquals(await itemsFingerprint(transported), request.fingerprint);
});

Deno.test("undefined and Date values fingerprint as the workflow transports them", async () => {
  const p = plan([
    candidate("AWS::S3::Bucket", "odd", {
      judgeState: {
        Missing: undefined,
        When: new Date("2026-01-01T00:00:00.000Z"),
      } as Record<string, unknown>,
    }),
  ]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 100);
  const transported = JSON.parse(JSON.stringify(request.items));
  assertEquals(request.items, transported);
  assertEquals(await itemsFingerprint(transported), request.fingerprint);
});

Deno.test("canonicalJson sorts keys at every depth", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: 2, c: [3] } }),
    '{"a":{"c":[3],"d":2},"b":1}',
  );
});

// =============================================================================
// Answers
// =============================================================================

Deno.test("normalizeScore maps a score onto 0–1 by its legend size", () => {
  assertEquals(normalizeScore(score(3))?.value, 1);
  assertEquals(normalizeScore(score(1.5))?.value, 0.5);
  assertEquals(normalizeScore(score(1, 3))?.value, 0.5);
  assertEquals(normalizeScore(score(2))?.level, "level 2");
  assertEquals(normalizeScore({ type: "noul", noul: 1 }), null);
  assertEquals(normalizeScore(score(1, 1)), null);
});

Deno.test("readAnswers tolerates missing and malformed answers", () => {
  const view = readAnswers({ disposition: { type: "noul", noul: 1 } });
  assertEquals(view.disposition, null);
  assertEquals(view.risk, null);
  assertEquals(view.controllerOwned, null);
});

// =============================================================================
// Decide
// =============================================================================

Deno.test("decide sends every unsettled candidate to a human when judge is off", async () => {
  const d = await decide(plan([VPC, BUCKET]), null, false);
  assertEquals(d.judgement.status, "disabled");
  for (const x of d.decisions) {
    assertEquals(x.disposition, "needs-human");
    assertEquals(x.decidedBy, "default");
    assertEquals(x.jev, null);
  }
  assertEquals(d.findings, []);
});

Deno.test("decide reports an unavailable batch, never a guess", async () => {
  const d = await decide(plan([VPC]), null);
  assertEquals(d.judgement.status, "unavailable");
  assertMatch(decisionFor(d, VPC).reason, /no jev batch reached decide/);
});

Deno.test("decide ignores a batch computed from a different candidate set", async () => {
  const p = plan([VPC, BUCKET]);
  const batch = await batchFor(p, { [VPC.id]: answers("manage") });
  batch.sourceFingerprint = "sha256-other";
  const d = await decide(p, batch);
  assertEquals(d.judgement.status, "mismatched");
  assertEquals(decisionFor(d, VPC).disposition, "needs-human");
  assertEquals(d.warnings.length, 1);
});

Deno.test("decide takes jev's disposition when the rules allow it", async () => {
  const p = plan([VPC, SUBNET]);
  const batch = await batchFor(p, {
    [VPC.id]: answers("observe-only"),
    [SUBNET.id]: answers("manage"),
  });
  const d = await decide(p, batch);
  assertEquals(d.judgement.status, "used");
  const subnet = decisionFor(d, SUBNET);
  assertEquals(subnet.disposition, "manage");
  assertEquals(subnet.decidedBy, "jev");
  assertEquals(subnet.confidence, 0.9);
  assertEquals(decisionFor(d, VPC).disposition, "observe-only");
});

Deno.test("decide sends a low-confidence answer to a human", async () => {
  const p = plan([VPC]);
  const batch = await batchFor(p, {
    [VPC.id]: answers("manage", { confidence: 0.5 }),
  });
  const x = decisionFor(await decide(p, batch), VPC);
  assertEquals(x.disposition, "needs-human");
  assertEquals(x.decidedBy, "rule");
  assertMatch(x.reason, /confidence 0\.50, below 0\.7/);
  assertEquals(x.jev?.disposition, "manage");
});

Deno.test("decide never manages what jev rates controller-owned", async () => {
  const p = plan([VPC]);
  const batch = await batchFor(p, {
    [VPC.id]: answers("manage", { owned: 0.8 }),
  });
  const x = decisionFor(await decide(p, batch), VPC);
  assertEquals(x.disposition, "needs-human");
  assertMatch(x.reason, /controller-owned/);
});

Deno.test("decide needs a human to manage a stateful, high-blast resource", async () => {
  const p = plan([BUCKET, candidate("AWS::EC2::VPC", "vpc-2")]);
  const batch = await batchFor(p, {
    [BUCKET.id]: answers("manage", { blast: 2 }),
    "AWS::EC2::VPC/vpc-2": answers("manage", { blast: 3 }),
  });
  const d = await decide(p, batch);
  assertEquals(decisionFor(d, BUCKET).disposition, "needs-human");
  assertMatch(decisionFor(d, BUCKET).reason, /stateful with high blast radius/);
  assertEquals(
    d.decisions.find((x) => x.id === "AWS::EC2::VPC/vpc-2")!.disposition,
    "manage",
    "a VPC is not stateful",
  );
});

Deno.test("decide lists high-risk candidates whatever their disposition", async () => {
  const p = plan([BUCKET, QUEUE, VPC]);
  const batch = await batchFor(p, {
    [BUCKET.id]: answers("exclude", { risk: 3 }),
    [QUEUE.id]: answers("manage", { risk: 2 }),
    [VPC.id]: answers("manage", { risk: 1 }),
  });
  const d = await decide(p, batch);
  assertEquals(d.findings.map((f) => f.id), [BUCKET.id, QUEUE.id]);
  assertEquals(d.findings[0].disposition, "exclude");
  assertEquals(d.findings[0].riskLevel, "level 3");
});

Deno.test("decide explains a per-item jev failure and an over-cap candidate", async () => {
  const p = plan([VPC, BUCKET, QUEUE]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 2);
  const full = await batchFor(p, {}, [VPC.id]);
  const idOf = (id: string) =>
    Object.entries(request.itemCandidates).find(([, c]) => c === id)![0];
  const judgement: Judgement = {
    ...full,
    sourceFingerprint: request.fingerprint,
    failures: [{ id: idOf(VPC.id), reason: "evaluation unavailable" }],
  };
  const d = decideCandidates(p, request, judgement, {
    judge: true,
    ...DEFAULT_DECIDE_OPTIONS,
  });
  assertMatch(decisionFor(d, VPC).reason, /could not evaluate/);
  assertMatch(
    decisionFor(d, QUEUE).reason,
    /over the judge cap of 2 candidates/,
  );
  assertEquals(d.judgement.failed, 1);
  assertEquals(d.judgement.overflow, 1);
});

Deno.test("decide settles flagged candidates by rule and skips managed ones", async () => {
  const role = candidate("AWS::IAM::Role", "AWSServiceRoleForECS", {
    flags: ["service-linked-role"],
  });
  const managed = candidate("AWS::S3::Bucket", "known", { swampManaged: true });
  const d = await decide(plan([role, managed]), null);
  assertEquals(d.judgement.status, "not-needed");
  assertEquals(decisionFor(d, role).disposition, "exclude");
  assertEquals(decisionFor(d, role).decidedBy, "rule");
  assertEquals(d.alreadyManaged, [managed.id]);
  assertEquals(d.decisions.length, 1);
  assertEquals(d.summary.alreadyManaged, 1);
});

Deno.test("decide orders observe candidates into dependency waves", async () => {
  const lambda = candidate("AWS::Lambda::Function", "api", {
    dependsOn: [SUBNET.id],
  });
  const p = plan([lambda, SUBNET, VPC]);
  const batch = await batchFor(p, {
    [VPC.id]: answers("manage"),
    [SUBNET.id]: answers("manage"),
    [lambda.id]: answers("observe-only"),
  });
  const d = await decide(p, batch);
  assertEquals(d.waves, [
    { wave: 0, candidates: [VPC.id] },
    { wave: 1, candidates: [SUBNET.id] },
    { wave: 2, candidates: [lambda.id] },
  ]);
  assertEquals(d.observe.map((o) => o.id), [VPC.id, SUBNET.id, lambda.id]);
  assertEquals(d.observe[2].disposition, "observe-only");
});

Deno.test("a dependency on a candidate that is not observed does not delay a wave", async () => {
  const p = plan([VPC, SUBNET]);
  const batch = await batchFor(p, {
    [VPC.id]: answers("needs-human"),
    [SUBNET.id]: answers("manage"),
  });
  const d = await decide(p, batch);
  assertEquals(decisionFor(d, SUBNET).wave, 0);
  assertEquals(decisionFor(d, VPC).wave, null);
});

Deno.test("a zero cap is reported as capped, not as nothing to judge", async () => {
  const p = plan([VPC, BUCKET]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 0);
  const d = decideCandidates(p, request, null, {
    judge: true,
    ...DEFAULT_DECIDE_OPTIONS,
  });
  assertEquals(d.judgement.status, "capped");
  assertMatch(decisionFor(d, VPC).reason, /over the judge cap of 0/);
});

Deno.test("judge off explains itself even for candidates over the cap", async () => {
  const p = plan([VPC, BUCKET]);
  const request = await buildJudgeRequest(p, "sweep-us-east-1", 1);
  const d = decideCandidates(p, request, null, {
    judge: false,
    ...DEFAULT_DECIDE_OPTIONS,
  });
  for (const x of d.decisions) {
    assertEquals(x.reason, "not judged: the judge input is off");
  }
});

Deno.test("assignWaves breaks a dependency cycle and warns", () => {
  const warnings: string[] = [];
  const waves = assignWaves([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ], warnings);
  assertEquals(waves.size, 2);
  assertEquals(warnings.length, 1);
  assertMatch(warnings[0], /dependency cycle/);
});
