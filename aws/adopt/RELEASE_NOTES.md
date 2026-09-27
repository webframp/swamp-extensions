## 2026.09.26.2

**Added:** `prepare_judgement` writes a `judgeRequest` (`judge-<plan>`): the
unmanaged candidates the deterministic flags did not settle, in rank order and
capped at `maxItems` (at most 100), with the four jev questions (`disposition`,
`blast_radius`, `controller_owned`, `risk`) and a fingerprint of the items.

**Added:** `decide` writes an `adoptionDecision` (`decision-<plan>`). Flags
settle controller-owned candidates (`exclude`), the default VPC
(`observe-only`), and read failures (`needs-human`). jev's answers decide the
rest only when the batch fingerprint matches the request and the rules allow it:
an answer below `minConfidence` (default 0.7), a `manage` jev also rates
controller-owned, and a stateful `manage` with high blast radius go to a human.
A candidate with no usable answer goes to a human with the reason. High-risk
candidates are listed in `findings[]` whatever their disposition. `manage` and
`observe-only` candidates are ordered into dependency waves, and every decision
records who made it and why.

**Added:** The `@webframp/adopt-find-unmanaged` workflow runs sweep, prepare,
jev `triage_batch`, and decide, then a manual approval, then a `get` on each
candidate to observe through its official `@swamp/aws/*` type, one model per
candidate. `judge=false` skips jev and sends unsettled candidates to a human.

**Added:** `@webframp/adopt-decision-report`, a default report of the adopt
model type. After `decide` it renders the decision for review before approval:
coverage and gaps, the jev outcome, dispositions, waves, high-risk findings, and
why candidates went to a human. After a sweep it renders the plan's coverage.

**Changed:** Manifest dependencies now pin every registry type's `@swamp/aws/*`
package (23 packages), `@swamp/typesafe-ai` 2026.09.15.1, and
`@webframp/typesafe-batch` 2026.09.26.1.

**Changed:** `prefix` is limited to 64 characters on `plan_account_sweep`,
`plan_stack_adoption`, and `discover_all`. Sweep model names become jev item
ids, which `triage_batch` caps at 200 characters; the other two methods take the
same limit for consistency.

**Fixed:** `@webframp/adopt-report` counted a guard-skipped step as failed. It
now reports skipped steps separately and leaves them out of the attempted count.
It also showed no error for a failed step, because it read `error` where swamp
supplies `errorMessage`.

## 2026.09.26.1

**Added:** `plan_account_sweep` enumerates every registry type in a region
through Cloud Control and writes an `adoptionPlan` resource (`sweep-<region>`)
that records the account and region. Each candidate carries its swamp type,
primary identifier, live `dependsOn`, tags, a model name scoped to account and
region, the `aws:cloudformation:stack-name` tag, `swampManaged`, deterministic
flags, and a `judgeState` projection. Child types (ECS services, ELB listeners,
Route 53 record sets, EKS nodegroups) are listed once per parent. Types that
cannot be listed, fully or for some parents, are recorded in `coverage.gaps[]`
with a reason, and the sweep continues. `swampManaged` matches stored swamp
state on each type's own ARN (or an SQS queue URL), only within the sweep's
account and region; a record with neither matches only when the type's
identifier is globally unique, and `coverage.warnings` counts the records that
could not be scoped.

**Added:** `ADOPTION_TYPES`, a registry of 41 adoptable types with tier,
dependency rank, statefulness, identifier properties, parent, references, and
judge attributes. `deno task check:registry` verifies every row against the
published `@swamp/aws/*` packages.

**Changed:** `CFN_TO_SWAMP_TYPE_MAP` is now derived from `ADOPTION_TYPES`, so it
has 41 entries instead of 14; the 14 existing mappings are unchanged.
`plan_stack_adoption` maps 36 of them. The other five are listed in `unmapped[]`
with the reason a stack's physical ID cannot address them: `AWS::EC2::EIP`,
`AWS::ECS::Service`, and `AWS::Route53::RecordSet` have composite Cloud Control
identifiers; `AWS::Events::Rule` is identified by ARN, not name; and the
physical ID of `AWS::EKS::Nodegroup` is unconfirmed. EIPs were mapped before,
but their `get` could not succeed; an EIP that a previous plan mapped is not
reported as an orphan. Stack model names use `ecs-cluster` and `eks-cluster` so
the two cluster types cannot collide; other stack model names are unchanged.

**Changed:** Bump @swamp/aws/rds and @swamp/aws/secretsmanager 2026.09.24.1 →
2026.09.25.1. Add @aws-sdk/client-cloudcontrol and @aws-sdk/client-sts 3.1139.0.

**Fixed:** README and manifest now list the CloudFormation and Cloud Control
permissions, and the README's dependency versions match the manifest.

## 2026.09.24.1

**Changed:** Bump @aws-sdk/* 3.1133.0 → 3.1139.0 (5 packages)

**Changed:** Bump @swamp/aws/ec2 2026.09.17.1 → 2026.09.24.1

**Changed:** Bump @swamp/aws/rds 2026.09.17.1 → 2026.09.24.1

**Changed:** Bump @swamp/aws/secretsmanager 2026.09.17.1 → 2026.09.24.1

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
