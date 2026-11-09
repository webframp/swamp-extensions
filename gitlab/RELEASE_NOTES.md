## 2026.11.09.1

**Fixed:** `get_snippet` with `includeContent` or `filePath` returned the HTML
sign-in page as the snippet's `content` on a GitLab instance behind SSO, and
reported success. It fetched the snippet's `raw_url`, a web route that ignores
the `PRIVATE-TOKEN` header. It now reads content through the API raw endpoints
(`/snippets/:id/raw`, `/snippets/:id/files/:ref/:file_path/raw`, and their
`/projects/:id/...` forms), which accept the token. Reported and diagnosed by
@acameron17 in #549.

**Changed:** A raw response that is an HTML sign-in page now fails with an
error instead of being stored as content (detected by the `/users/auth/`
marker in an HTML response; an HTML snippet file that itself contains that
string would also be rejected). The raw read no longer follows redirects, so
the token cannot be forwarded to another origin; a redirect is an error.
`project` and `filePath` containing `.` or `..` segments are rejected. The size cap, binary check and
secret redaction are unchanged. `get_snippet` no longer needs the snippet's
`raw_url` and no longer fetches it, so the external-host refusal for `raw_url`
is gone; requests only ever go to the configured host.

**Upgrade note:** No schema changes. The model version moves to 2026.11.09.1 with an
identity upgrade.
