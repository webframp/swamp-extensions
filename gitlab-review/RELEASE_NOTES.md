## 2026.10.21.2

**Changed:** Documentation only: the setup example stored the token with
`echo "$GITLAB_TOKEN" | swamp vault put gitlab TOKEN`, which assumes the token
already sits in an environment variable. It now uses the interactive
`swamp vault put gitlab TOKEN` prompt, or a pipe from another secret store. The
`token` global argument description now says to supply it as
`${{ vault.get("gitlab", "TOKEN") }}` and never as a literal.

**Upgrade note:** No schema or behavioral changes. The model version moves to
2026.10.21.2 with an identity upgrade.
