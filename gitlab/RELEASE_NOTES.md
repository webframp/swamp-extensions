## 2026.10.21.3

**Fixed:** The README told you to store the token with a `vault set` subcommand
that swamp does not have, passing the token on the command line where it would
land in shell history. It now creates the vault if needed and stores the token
with `swamp vault put gitlab TOKEN`, which prompts for the value. The registry
Quick Start shows the same steps.

**Changed:** The `token` global argument description now says to supply it as
`${{ vault.get("gitlab", "TOKEN") }}` and never as a literal.

**Upgrade note:** No schema or behavioral changes. The model version moves to
2026.10.21.3 with an identity upgrade.
