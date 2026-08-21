## 2026.08.20.1

**Changed:** Bump @webframp/agentcore 2026.08.05.1 → 2026.08.20.1

## 2026.08.15.1

**Changed:** Bump @webframp/agentcore 2026.08.02.1 → 2026.08.05.1

## 2026.08.05.1

**Changed:** Bump @webframp/agentcore 2026.07.31.1 → 2026.08.02.1

## 2026.08.02.2

**Fixed:** The workflow's `description` field embedded a live
`data.latest("agentcore-provisioner", "provision")` CEL expression as
"documentation." Swamp evaluates every `${{ ... }}` expression found anywhere in
a workflow definition — including inside `description` text — eagerly and
strictly, before any job runs. Since the referenced resource does not exist
until the `provision` job completes, this expression threw
`Invalid expression: No such key: attributes` on every fresh bootstrap, aborting
the workflow before job 1 ever started. The `description` field no longer
contains a live expression; it points to the README for the exact CEL snippet to
use in a driver config instead.

**Fixed:** The README's "After Bootstrap" example used the same wrong instance
name (`"provision"` instead of `"main"`, the actual `writeResource()` instance
name) that issue #330 identified in the sibling datastore-bootstrap extensions.
A user who copied that snippet into their own `driverConfig` would hit the same
"No such key: attributes" error.

**Upgrade note:** No schema or model change. Re-pull to get a workflow that
actually completes a fresh run, and a correct README example.
