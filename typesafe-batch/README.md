# @webframp/typesafe-batch

`triage_batch` for `@swamp/typesafe-ai`: evaluate many small items against one
shared question set in a single method run, and store the answers as one
resource.

The official `ask` method evaluates one state. A queue of review items or a list
of adoption candidates has many independent items, and running `ask` once per
item in a `forEach` would contend on the model lock. `triage_batch` takes the
lock once, evaluates the items with bounded concurrency, and isolates each
item's failure.

## Install

```bash
swamp extension pull @webframp/typesafe-batch
swamp model create @swamp/typesafe-ai jev \
  --global-arg 'apiKey=${{ vault.get("secrets", "TYPESAFE_API_KEY") }}'
```

Without `apiKey`, the method falls back to the `TYPESAFE_API_KEY` environment
variable, as the official methods do.

## Usage

```yaml
# batch.yaml
name: nightly
concurrency: 4
items:
  - id: mr-101
    state: { title: "Bump lodash", draft: false, approvedByMe: false }
  - id: mr-102
    state: { title: "WIP: refactor", draft: true, approvedByMe: false }
questions:
  review_needed:
    type: noul
    instructions: Does this merge request need my review now?
  urgency:
    type: score
    instructions: How urgently should I review it today?
    criteria:
      - "Routine: can wait"
      - "This week"
      - "Today"
```

```bash
swamp model method run jev triage_batch --input-file batch.yaml
swamp data get jev triage-batch-nightly --json
```

In a workflow, build `items` with a CEL projection over another model's data,
and set `allowFailure: true` on the step so a provider outage leaves the factual
data in place.

## Arguments

| Argument      | Default        | Notes                                                                                                      |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `items`       | required       | 1–100 `{id, state}`; ids are unique, at most 200 chars                                                     |
| `questions`   | required       | Map of `noul`, `choice`, or `score` questions                                                              |
| `name`        | `latest`       | Suffix of `triage-batch-<name>`: 1–63 lowercase letters, digits, `-`, `_`, starting with a letter or digit |
| `concurrency` | `4`            | Requests in flight, 1–10                                                                                   |
| `model`       | global `model` | System One model override                                                                                  |

## Output

One `triageBatch` resource, `triage-batch-<name>`:

- `results[]`: `{ id, answers }` for each item that was evaluated. A `score`
  answer is a probability-weighted position from 0 to one less than the number
  of criteria, with a `legend` and a `confidence`.
- `failures[]`: `{ id, reason }` for each item that could not be evaluated.
  Provider errors are not stored, because they can echo request content.
- `sourceFingerprint`: a SHA-256 of the canonical items. A consumer compares it
  with its own input to reject answers computed from a different snapshot.
- `model`, `totalInputTokens`, `totalOutputTokens`, `evaluatedAt`.

Raw item state and question text are never stored.

## Troubleshooting

- **Every item is in `failures[]`.** Check the API key and `baseUrl`, then run
  the official `ask` method on one item to see the provider's error.
- **Validation fails on `items` or `name`.** Two items share an id, there are
  more than 100, an id is empty or longer than 200 characters, or `name` starts
  with `-` or `_` or has a character other than a lowercase letter, digit, `-`,
  or `_`.
- **A warning says `triage_batch` already exists.**
  `@webframp/operator-briefing` 2026.09.25.1 and earlier shipped its own copy.
  Upgrade it to 2026.09.26.1 or later.
- **A workflow step passes `items` as a string.** A folded YAML scalar (`>-`)
  coerces the CEL result to a string. Quote the expression on one line.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
