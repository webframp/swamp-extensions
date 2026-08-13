# Data Output Contracts for Extension Interoperability

Status: **Accepted**
Date: 2026-08-13
Author: Sean Escriva

## Context

Extensions in this repository produce versioned data resources that other
extensions consume. The primary consumer today is `@webframp/operator-briefing`,
a workflow-scope report that aggregates data from multiple source models into a
unified operator briefing. The pattern applies to any consuming extension or
report that reads data produced by a different model type.

When the consumer's expectations diverge from the source's actual output, the
consumer degrades silently at runtime — producing "no recognizable data shape"
notes instead of actionable signals. These failures are discoverable but avoidable
if both sides follow a consistent contract.

## Decision

Source extensions own the data contract. Consumers discover it via
`swamp model type describe <type> --json` and author their normalizers against
the declared `dataOutputSpecs` schemas. There is no shared import mechanism
between extensions at this time (see `docs/plans/shared-schema-proposal.md` for
a future possibility).

## Source-Side Contract

Every model resource spec MUST follow these rules:

### 1. Flat, typed top-level fields

Domain data lives at the top level of the resource with explicit key names and
types declared in the Zod schema. No opaque `data: z.unknown()` bags.

```typescript
// Wrong — polymorphic envelope hides the real contract
resources: {
  costs: {
    schema: z.object({
      region: z.string(),
      queryType: z.string(),
      data: z.unknown(),       // ← consumer cannot reason about this
      fetchedAt: z.string(),
    }),
  },
}

// Correct — one spec per structurally distinct output
resources: {
  cost_trend: {
    schema: z.object({
      dataPoints: z.array(z.object({ date: z.string(), amount: z.number() })),
      trend: z.string(),
      totalCost: z.number(),
      days: z.number(),
      fetchedAt: z.string(),
    }),
  },
  cost_by_service: {
    schema: z.object({
      services: z.array(z.object({ service: z.string(), amount: z.number(), ... })),
      totalCost: z.number(),
      days: z.number(),
      fetchedAt: z.string(),
    }),
  },
}
```

### 2. `fetchedAt: string` on every resource

Every resource MUST include a top-level `fetchedAt` field containing an ISO 8601
timestamp. Consumers use this for freshness judgment (stale > N hours).

### 3. One spec per structurally distinct output

If a model supports multiple query types that produce structurally different
data, use separate `dataOutputSpecs` entries. Do not overload a single spec
with a discriminator field and varying payloads.

The spec name becomes the primary identifier for consumers dispatching by shape.
It appears in `swamp model type describe` output and in data queries via
`specName`.

### 4. Lowercase camelCase field names

Follow JavaScript/TypeScript naming conventions. Do not mirror upstream API
casing (e.g., AWS returns `CRITICAL` but the model schema uses `critical`).
The model is a typed abstraction over the upstream API, not a passthrough.

### 5. Degradation fields

When a source can partially fail (multi-account sweeps, paginated fetches):

- `failedProfiles: string[]` — which accounts/profiles could not be reached
- `truncated: boolean` — whether results were cut off by pagination limits

These fields allow the consumer to distinguish "no data observed" from "zero
results observed" — the difference between degraded and healthy.

### 6. No fabricated zeros

If a fetch failed, do not write a resource with zero-valued fields. Either
skip writing the resource (let the consumer note its absence) or include a
`degraded: true` flag. A written resource with `critical: 0` means "zero
critical findings were observed," not "the observation failed."

## Consumer-Side Contract

Reports and other extensions consuming data from source models MUST follow
these rules:

### 1. Consult the declared schema before authoring

Run `swamp model type describe <type> --json` and read the `dataOutputSpecs`
entry for the spec you intend to consume. The `schema.properties` and
`schema.required` arrays define the contract.

### 2. Schema-contract dispatch, not shape guessing

Identify incoming data by checking for the spec's *required* fields — the
fields listed in the schema's `required` array. Do not probe for arbitrary
field presence that might match multiple specs.

```typescript
// Wrong — guessing at shapes
if ("summary" in data) { ... }
if ("dau" in data && "mau" in data) { ... }

// Correct — checking required fields that uniquely identify the spec
// SeveritySummarySchema requires: critical, high, medium, low, total, fetchedAt
if ("critical" in data && "high" in data && "total" in data) { ... }
```

When a model produces multiple specs from a single method, use the spec's
distinguishing required fields to identify which resource you are processing.

### 3. Handle absent resources gracefully

A step may not produce data (method failure, conditional execution). The
consumer emits a note and continues. The report's `degraded` flag is set only
when a registered normalizer produces zero signals AND at least one data
resource was expected.

### 4. Never fabricate values from missing fields

If a field the normalizer needs is absent or has an unexpected type, the
signal for that resource is skipped. Do not substitute defaults that could
be mistaken for real observations.

### 5. Emit notes on unrecognized shapes

When data arrives from a registered model type but matches none of the
expected spec shapes, emit a diagnostic note:

```typescript
notes.push(`Security Hub: no recognizable data shape in step output.`);
```

This surfaces the mismatch in the report without marking the entire briefing
as failed.

## Step Classification for Workflow Reports

Workflow-scope reports iterate step executions and dispatch by model type.
Steps fall into three categories:

| Category | Mechanism | Report behavior |
|----------|-----------|-----------------|
| Source | Registry normalizer | Produces queue/ops signals |
| Known non-source | `nonSourceModelTypes` set | Silent skip, no degradation |
| Unknown | No registry entry, not in non-source set | Skip + count + note + mark degraded |

**When to add to `nonSourceModelTypes`:** A model type that runs in the
workflow but is a *consumer or output action* (not a data source for the
briefing) belongs here. Examples: the metrics accumulator
(`@webframp/operator-briefing/metrics`) which appends trend data, and the
operator board (`@webframp/gitlab/operator-board`) which publishes a GitLab
issue from the queue data.

The "unknown" category exists for discovery — when a new step appears in the
workflow that nobody has classified yet, the report flags it so the operator
can decide whether to write a normalizer or mark it as a non-source.

## Adding a New Source

The checklist for wiring a new data source into a consuming report:

1. **Inspect the source schema.** Run `swamp model type describe <type> --json`
   and identify the spec(s) relevant to the consumer.
2. **Add the workflow step.** Wire the model method into the workflow DAG with
   appropriate `dependsOn` conditions.
3. **Write the normalizer.** Import the necessary types, dispatch by the spec's
   required fields, produce `Contribution { queue, ops, notes }`.
4. **Register it.** Add one line to `registry.ts` mapping the model type to the
   normalizer function.
5. **Test it.** Write a unit test with sample data matching the declared schema.
   Include edge cases: empty arrays, degraded fetches, truncated results.

## Versioning and Breaking Changes

When a source model changes its schema in a breaking way (renamed fields,
removed required fields, changed types):

- The source MUST bump its version and include an `upgrades` entry that
  migrates existing cached data to the new shape.
- The consumer normalizer MUST be updated to handle both the old and new
  shapes during the transition period (old cached data may still exist).
- Once all cached data has aged out (governed by the spec's
  `garbageCollection` setting), the old-shape handling can be removed.

Non-breaking additions (new optional fields) require no consumer changes —
the normalizer ignores fields it does not read.
