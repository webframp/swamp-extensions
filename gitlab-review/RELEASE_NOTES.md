## 2026.10.22.1

**Fixed:** `post_inline_review` always failed when run through swamp with
`Method arguments validation failed: Unrecognized keys: "host", "token"`. swamp
merges a definition's `globalArguments` under per-method arguments before
validating them, and the method's arguments schema was `.strict()`, so it
rejected the merged `host` and `token`. The arguments schema now strips unknown
keys like every other method in this extension. Each comment is still validated
strictly.

**Upgrade note:** No schema or behavioral changes beyond the fix. The model
version moves to 2026.10.22.1 with an identity upgrade.

## 2026.10.21.2

**Changed:** Documentation only: the setup example stored the token with
`echo "$GITLAB_TOKEN" | swamp vault put gitlab TOKEN`, which assumes the token
already sits in an environment variable. It now uses the interactive
`swamp vault put gitlab TOKEN` prompt, or a pipe from another secret store. The
`token` global argument description now says to supply it as
`${{ vault.get("gitlab", "TOKEN") }}` and never as a literal.

**Upgrade note:** No schema or behavioral changes. The model version moves to
2026.10.21.2 with an identity upgrade.
