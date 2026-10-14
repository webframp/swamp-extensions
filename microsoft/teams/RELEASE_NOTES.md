## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.19.1

**Fixed:** `attention` and `list_chats` sent `$expand=members,viewpoint` to
Graph's `/me/chats`. `viewpoint` is a per-user computed property, not a
navigation property, so Graph rejected the whole request with `Parsing OData
Select and Expand failed`, and both methods failed outright. `viewpoint` is
now requested via `$select` (alongside every other `GraphChat` field, since
both methods echo raw chat objects into their output resources) while
`$expand` is left to do only what it can: expand `members`.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
