## 2026.11.16.1

**Fixed:** `update_snippet` rejected every call that passed `files` with
GitLab's `400 files[0][action] is missing`, for both project and instance
snippets, so no file update ever succeeded. Each `files[]` entry now carries
an `action`, defaulting to `update`. Title, description, and visibility-only
updates were unaffected.

**Added:** Each `files` entry accepts an optional `action` (`create`,
`update`, `delete`, or `move`) and, for `move`, a `previousPath` giving the
file's current path (`filePath` is the new path). `content` is now optional in
the schema and is required only for `create` and `update`.

**Upgrade note:** No schema changes to stored resources. The model version
moves to 2026.11.16.1 with an identity upgrade. Existing calls that pass
`filePath` and `content` keep working unchanged.
