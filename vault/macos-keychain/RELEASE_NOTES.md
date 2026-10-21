## 2026.10.21.1

**Fixed:** Tracing spans reported a stale instrumentation version
(`2026.08.20.1`) instead of the published version. The tracer version now
matches `manifest.yaml`, and a test fails if the two drift apart again (the
`test` task in `deno.json` now grants read access to `manifest.yaml` for it).

**Fixed:** The README's model example used a `vault://keychain/...` default
value. swamp does not resolve `vault://` strings: it rejects such a literal for
an argument marked sensitive, and passes it through as literal text to one that
is not. The example now uses `${{ vault.get("keychain", "...") }}`.

**Changed:** The `swamp vault read-secret --force` example now warns that it
prints the plaintext value.

**Upgrade note:** Secret storage and retrieval behave as before; only the
instrumentation version on emitted spans changes. If you followed the old
example, replace the `vault://` value with a `vault.get` expression.
