## 2026.08.21.2

**Changed:** Error messages across `build`, `push`, `login`, and `inspect` now
name the operation and the image tag or registry involved, instead of surfacing
raw CLI or runtime errors:

- If the container CLI binary itself fails to launch (e.g. it isn't installed or
  isn't on `PATH`), the error now says which command and arguments were
  attempted instead of a bare "No such file or directory".
- `login` failures now include the registry URL being authenticated against.
- After a successful `build`, the follow-up call that looks up the new image's
  ID no longer fails silently — if that lookup fails, `build` now throws an
  error saying the build succeeded but the image ID could not be retrieved,
  instead of writing a resource with an empty `imageId`.
- After a successful `push`, the follow-up calls that look up the pushed image's
  digest and size no longer fail silently — failures now throw with the tag and
  CLI exit code instead of writing a resource with an empty digest or a `null`
  size.
- `inspect` now reports a clear "failed to parse ... as JSON" error (including
  the tag and the parser's message) if the CLI's output isn't valid JSON,
  instead of an unqualified `SyntaxError`.

No schema or behavioral changes to successful operations — only error paths are
affected.
