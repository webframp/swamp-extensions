# @webframp/editorial-review

Reviews prose against fixed editorial principles and returns structured findings
with a revised draft. The principles live in
[`guides/editorial-principles.md`](guides/editorial-principles.md). Benjamin
Dreyer supplies the correctness rules and Verlyn Klinkenborg the sentence rules.
A catalogue of anti-patterns common in generated prose and a short house style
complete it.

Claude does the editing through `@keeb/anthropic/claude` `cli_generate_many`,
which runs the local `claude` CLI. The host needs Claude Code installed and
logged in; no API key is involved.

## Install

```bash
swamp extension pull @webframp/editorial-review
```

The pull brings `@keeb/anthropic` with it. Review it before trusting the `keeb`
collective.

## Run

```bash
# a file in the repo
swamp workflow run @webframp/editorial-review \
  --input draftPath=docs/posts/draft.md --input contentKind="blog post"

# inline text, one pass, with a house voice
swamp workflow run @webframp/editorial-review \
  --input draftText="$(cat notes.md)" --input recheck=false \
  --input voiceModel=voice
```

Whether you use `draftPath` or `draftText`, the full draft is stored in
plaintext: in the `review-request` data, in the Claude steps' recorded inputs,
and, for `draftText`, in the workflow run's inputs. Every run also sends it to
Anthropic. Don't review text that may not be stored or shared.

## Read the result

```bash
swamp report get @webframp/editorial-review \
  --workflow @webframp/editorial-review            # markdown
swamp report get @webframp/editorial-review \
  --workflow @webframp/editorial-review --json     # JSON contract
```

## Inputs

| Input            | Default            | Meaning                                                                  |
| ---------------- | ------------------ | ------------------------------------------------------------------------ |
| `draftPath`      | `""`               | Draft file, relative to the repo root or absolute inside it              |
| `draftText`      | `""`               | Inline draft, used when `draftPath` is empty                             |
| `contentKind`    | `prose`            | What the draft is; given to the editor                                   |
| `voiceModel`     | `""`               | A `@dougschaefer/writing-voice` behavior to add to the guide             |
| `recheck`        | `true`             | Re-review the revision; doubles the Claude calls                         |
| `model`          | `claude-opus-5-5`  | Claude model for both passes                                             |
| `effort`         | `high`             | claude CLI effort                                                        |
| `timeoutSeconds` | `900`              | Per-call timeout                                                         |
| `instanceName`   | `editorial-review` | Behavior name for this review's data; vary it to run reviews in parallel |

Give exactly one of `draftPath` and `draftText`. A draft path must resolve
inside the repository, after symlinks, and the draft must be under 200 KB.

## House voice

`voiceModel` names an existing `@dougschaefer/writing-voice` behavior. The
`prepare` method reads its latest `voice-profile` record and any standalone
`anti-pattern-<name>` records from `add-anti-pattern`; a standalone record
replaces a profile entry of the same name. The prose rules, kill list and
anti-patterns go into the system prompt after the principles. On tone and
register the voice wins; on grammar and economy the guide does. Run the voice
behavior's `get` method first: `prepare` fails when the named behavior has no
voice data.

## What the workflow does

1. **prepare** (`@webframp/editorial-review`) writes `review-request`: the draft
   with its sha256 and sentence stats, the principles' sha256, the voice, and a
   one-item `cliRequests` list holding the system prompt, the review prompt and
   the output JSON schema.
2. **review** runs `@keeb/anthropic/claude` `cli_generate_many` on behavior
   `<instanceName>-claude` with that list. The answer lands in
   `cli-editorial-review`: `findings`, `revisedDraft` and optional `notes` under
   `structured`, plus `ok`, `costUsd` and the serving model. An assert checks
   that the call succeeded and the answer has the right shape.
3. **recheck**, unless `recheck=false`: `recheck` writes `recheck-request` from
   the revised draft, and a second call writes `cli-editorial-recheck` with the
   violations that remain or that the revision introduced.

The workflow uses `cli_generate_many` with a single request, not `cli_generate`,
because only the former takes the system prompt as a method input. Method inputs
that read data resolve when the step runs; global arguments resolve at run
start, before `prepare` has written the request.

Each finding carries `section` (a guide number such as `3.6`, or
`voice:<anti-pattern>`), the offending `sentence`, the `problem` and a
`suggestedFix`; an empty fix means delete the sentence.

## Report

The workflow-scope report renders:

- findings from each pass, grouped by guide part;
- the sentence-shape self-check (guide 2.3) over the original draft: sentence
  lengths, opener counts, repeated openers, and the openers guide 2.7 asks you
  to question;
- word counts before and after, with a warning when the revision grew;
- a line diff and the final draft (the second pass's revision when it ran).

It never throws. When a step is missing or its data cannot be read, the report
sets `degraded: true`, lists the reasons in `notes`, and renders what it has.
`status` is `complete`, `partial` (a pass is missing but a revision exists) or
`degraded` (no revision).

## Updating the principles

The guide is vendored. Edit `guides/editorial-principles.md`, bump the version,
and publish. Every request records the guide's sha256, so past reviews stay
traceable to the version they used.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
