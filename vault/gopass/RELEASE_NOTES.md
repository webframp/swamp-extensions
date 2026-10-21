## 2026.10.21.1

**Fixed:** Tracing spans reported a stale instrumentation version
(`2026.08.20.1`) instead of the published version. The tracer version now
matches `manifest.yaml`, and a test fails if the two drift apart again (the
`test` task in `deno.json` now grants read access to `manifest.yaml` for it).

**Fixed:** The README's model example used `{{ vault "default" "..." }}`, which
is not swamp syntax and never resolved to the secret: swamp rejects a literal
value for an argument marked sensitive, and passes it through as literal text to
one that is not. It now uses `${{ vault.get("default", "...") }}`.

**Changed:** The `swamp vault read-secret --force` examples now warn that they
print the plaintext value, and point to `vault.get` for model use.

**Upgrade note:** Secret storage and retrieval behave as before; only the
instrumentation version on emitted spans changes.
