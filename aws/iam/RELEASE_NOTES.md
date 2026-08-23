## 2026.08.23.1

**Fixed:** README's five usage examples used a broken CLI command form
(method before instance, extension name spliced in). Corrected to the
standard `swamp model method run <instance> <method>` form used elsewhere.

**Changed:** Documentation only — no code changes otherwise. Clarified that
`discover_trust_map` reads previously written `roles-<profile>` resources and
never calls the IAM API itself. Added a `## Troubleshooting` section covering
the per-profile silent degrade in `discover_all`, the exact error thrown by
`discover_trust_map` when no role data exists, `pathPrefix` filtering to an
empty result set with no error signal, the `MAX_PAGES = 200` pagination cap,
and the silent catch on malformed `AssumeRolePolicyDocument` that drops a role
from the trust graph.
