## 2026.10.20.1

**Added:** `passwordOnly` config option. When `true`, `get` returns only the
first line of an entry, which is the password by pass convention, instead of the
whole decrypted file. Defaults to `false`.

**Added:** `fieldSeparator` config option for per-key field selection. With
`fieldSeparator: "#"`, the key `smtp/example#login` returns the value of the
`login:` line of `smtp/example`. Field names match case-insensitively, line 1 is
never searched, and URI lines such as `otpauth://...` are not fields. A key
whose text after the separator is not a field name (`team#a/entry`, `a#`) names
an entry, so keys from `list` stay readable. Separators containing `/` or
whitespace are rejected. A missing field fails with an error naming the entry
and field, never its content. `put` rejects a key that selects a field. Unset by
default, so keys are taken literally.

**Added:** A get or put whose key selects a field records the field name in a
new `vault.secret_field` span attribute, and `vault.secret_key` carries the
entry path without the selector. Neither ever carries a value.

**Fixed:** Spans reported a stale instrumentation-scope version
(`2026.08.20.1`); they now report the published version.

**Upgrade note:** No behavior changes unless you opt in. `get` still returns the
whole multiline entry by default. The README now documents that default and how
it breaks a consumer that expects a bare password (#499).
