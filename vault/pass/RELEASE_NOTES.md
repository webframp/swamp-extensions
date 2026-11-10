## 2026.11.10.1

**Changed:** `get()` on an entry that is not in the password store now rejects
with `code: "secret_not_found"` (error name `SecretNotFoundError`). swamp reads
that code to tell a missing secret apart from a real failure. A GPG decryption
error, missing key, or locked agent still rejects without the code. The error
message is unchanged, so anything matching on `is not in the password store`
keeps working. Tracing spans for a missing entry now record
`error.type: "SecretNotFoundError"` instead of `"Error"`; every other failure
still records `"Error"`.

**Changed:** When `storeDir` does not exist or is not a directory, `get()` on a
missing entry now rejects with `pass store directory "<dir>" does not exist or
is not a directory; check the vault's storeDir config` instead of pass's "not
in the password store" message. A mistyped `storeDir` no longer looks like an
absent secret.

**Changed:** Bump @opentelemetry/api 1.9.1 → 1.10.0

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

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
