## 2026.10.21.1

**Changed:** The README now opens with a Credentials section. Store the key with
`swamp vault put griptape API_KEY` and set `apiKey` to
`${{ vault.get("griptape", "API_KEY") }}`. The previous example passed a
placeholder literal (`apiKey=GRIPTAPE_CLOUD_API_KEY`).

**Changed:** The `apiKey` description and the missing-key error now point to the
vault. The `GT_CLOUD_API_KEY` environment variable is still read when `apiKey`
is unset, but it is now documented as a discouraged fallback because swamp does
not redact it. Key resolution is unchanged.

**Added:** The README tells you to pass the `value` argument of `create_secret`
and `update_secret` as a `vault.get` expression. A literal value is recorded in
cleartext with the run's inputs.

**Upgrade note:** Documentation and message text only. No schema or behavioral
changes.
