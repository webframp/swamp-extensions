## 2026.10.21.1

**Fixed:** Tracing spans reported a stale instrumentation version
(`2026.10.20.1`) instead of the published version. The tracer version now
matches `manifest.yaml`, and a test fails if the two drift apart again.

**Fixed:** The README showed model arguments in a `source: vault` / `vault:` /
`key:` form. swamp does not support that form; secrets reach a model only
through `${{ vault.get("<vault>", "<key>") }}`. Both examples, including the
field-selection one (`smtp/example#login`), now use `vault.get`.

**Changed:** The `swamp vault read-secret --force` example now warns that it
prints the plaintext value, and the multiline-entry example no longer prints a
password-shaped literal.

**Upgrade note:** Secret storage and retrieval behave as before; only the
instrumentation version on emitted spans changes.
