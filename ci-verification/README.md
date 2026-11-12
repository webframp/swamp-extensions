# @webframp/ci-verification

Pre-PR verification for
[webframp/swamp-extensions](https://github.com/webframp/swamp-extensions),
recorded as typed, versioned swamp data. It runs the checks CI runs against one
commit and stores every result and its log, keyed by the commit's tree hash.
From those results it builds an attestation and posts it as a git ref.

Every method resolves the commit once and runs in a throwaway detached worktree
at that commit, so the verified state is the committed state. The caller's
checkout, index and branch are never touched. The worktree is removed when the
method ends, including on failure or cancellation.

## Methods

- **discover**: runs the commit's own `scripts/ci-discover` against a base and
  records which extensions and repo-wide checks the diff selects
  (`selection-<tree>`).
- **check**: for each selected extension, runs `deno task check`, `lint`,
  `fmt:check`, `test` and `swamp extension fmt manifest.yaml --check`
  (`check-<tree>-<slug>`). Then runs the repo-wide checks: the reserved data
  name scan, CI's bare-specifier and zod-pin greps, and the four tasks of each
  `scripts/` tool the diff touches (`repocheck-<tree>-<check>`).
- **quality**: runs `swamp extension quality manifest.yaml --json` for each
  selected extension under CI's pass condition (`quality-<tree>-<slug>`).
- **attest**: builds `attestation-<tree>` from the recorded results. It
  recomputes the gate and writes nothing if any selected result is missing,
  failed, or was recorded for another selection or model version, or if the
  change touches the trust root and no approval was given.
- **post**: pushes the attestation to `refs/attestations/<tree>/<timestamp>` on
  a remote. The push is never forced, so an existing attestation is never
  overwritten.

Each result's log is stored as a `log` file beside it, capped at 256 KiB (the
tail is kept and the result is marked `truncated`).

`check` and `quality` run up to `concurrency` extensions at once (default 4). A
rerun reuses a stored result only when it passed for the same selection, model
version, and `deno` and `swamp` versions. A failed result is always run again,
so after a fix only the failures rerun.

## Usage

The shipped workflow runs discover, check and quality in sequence, each job only
when the previous one succeeded. Every step names the model type
(`modelType: "@webframp/ci-verification"`) and the instance name
(`modelName: ci-verification`), so swamp creates the `ci-verification` instance
on the first run and reuses it after that. To run the methods directly before
the workflow has run, create the instance first:

```bash
swamp model create @webframp/ci-verification ci-verification
```

```bash
swamp extension pull @webframp/ci-verification

swamp workflow run @webframp/ci-verification-verify \
  --input repoPath=/path/to/swamp-extensions \
  --input commit=$(git -C /path/to/swamp-extensions rev-parse HEAD) \
  --input base=origin/main
```

Inspect results with swamp data, for example every failed result:

```bash
swamp data query 'modelName == "ci-verification" && isLatest == true &&
  content.status == "failed"' --json
```

When the change has been reviewed and is ready to release, build and post the
attestation. Reviews and approvals are recorded as given and marked
`reviewsAndApprovalsCallerAsserted`; the model does not verify them.

```bash
swamp model method run ci-verification attest \
  --input repoPath=/path/to/swamp-extensions --input commit=<sha> \
  --input 'reviews:json=[{"name":"code-review","verdict":"pass"}]' \
  --input 'approvals:json=[{"gateId":"release-approval","decision":"approve","by":"<name>"}]'

swamp model method run ci-verification post \
  --input repoPath=/path/to/swamp-extensions --input commit=<sha>
```

## Credentials

The model reads no secrets and takes none as arguments. Child processes get an
allowlisted environment, never the caller's whole environment:

- **deno tasks** (code under test) get a throwaway `HOME`, `PATH`, locale, and
  TLS and proxy settings. Cloud credentials, swamp tokens and the real home
  directory do not reach them.
- **swamp** (manifest fmt and quality) gets the real `HOME`, so it uses the
  logged-in swamp CLI. In CI the same command authenticates with `SWAMP_API_KEY`
  and `SWAMP_SIGNIN_TOKEN`, which are passed through when set.
- **git** gets the real `HOME` and `SSH_AUTH_SOCK`, so `post` pushes with your
  existing git credentials.

## What an attestation covers

An attestation records `coverage.covered` and `coverage.notCovered`:

- **Covered:** CI's extension-check tasks, manifest fmt and the import specifier
  greps, the quality gate, and the reserved data name scan for the selected
  extensions, plus the tasks of each `scripts/` tool the change touches.
- **Not covered:** manifest fmt for extensions outside the selection, `scripts/`
  tools the change does not touch, and CI's agent reviews (adversarial-review
  and ci-security-review). CI also runs on the merge of head into the current
  base, while this runs on head; `subject.baseIsAncestor` records whether the
  base was an ancestor of head.

## Trust root

Discovery and verification run the commit's own `scripts/ci-discover`,
`scripts/check-reserved-names` and this extension's tests. A change to any of
those, or to `.github/workflows/`, alters what verification checks, so the
passing result was computed by the changed code. Such files are listed in
`trustRootChanged` and the attestation sets `requiresSignOff: true`. `attest`
refuses such a change unless at least one approval is passed, so a person's
sign-off is part of the gate, not only a flag. The approval is recorded as
asserted by the caller; the model does not check who gave it.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
