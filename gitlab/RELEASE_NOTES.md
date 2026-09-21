## 2026.09.21.1

**Added:** Snippet management, closing GitHub issue #411:

- `create_snippet` — create an instance/personal snippet (`POST /snippets`) or
  a project snippet (`POST /projects/:id/snippets`) depending on whether a
  `project` argument is given. Accepts one or more `files` (`filePath` +
  `content`, mapped to GitLab's `file_path`/`content`) — the legacy top-level
  `file_name`+`content` form is not supported. `visibility` defaults to
  `private` (`private`/`internal`/`public`).
- `list_snippets` — the caller's personal snippets (`GET /snippets`), or a
  project's snippets when `project` is given (`GET /projects/:id/snippets`).
  Paginated the same way `list_branches`/`list_repository_tree` are, flagging
  `truncated` from GitLab's `x-next-page` header.
- `get_snippet` — fetch a snippet's metadata (instance/personal or project,
  by `id`). Set `includeContent` to also fetch raw file content — the whole
  snippet by default, or a specific file via `filePath` — capped at 500KB and
  redacted for common credential patterns exactly like `get_file`, including
  rejecting binary content rather than decoding it as corrupted text.
- `update_snippet` — update an existing snippet's `title`, `description`,
  `visibility`, and/or `files` (only the fields provided are sent).
- `delete_snippet` — delete a snippet by `id` (instance/personal, or project
  when `project` is given). Throws a descriptive error on a non-2xx response
  (e.g. 404) rather than silently succeeding.

All five accept an optional `project` argument: omitted means the instance
(personal) snippet endpoints, provided means the project-scoped ones. New
resources: `snippetDetail` (create/get/update — `infinite` lifetime, snippets
are durable), `snippetList` (list — `15m` lifetime), `snippetDeleted` (delete
— `infinite` lifetime).

**Changed:** None — this release is purely additive. `GitLabClient` gained
new instance-level HTTP helpers (`getInstance`, `getInstanceList`,
`postInstance`, `putInstance`, `deleteInstance`, `getRawTextOrNull`) plus
project-scoped `get`/`del`, since GitLab's snippet GraphQL surface doesn't
cover create/delete and instance snippets live directly off the API base URL
rather than under `/projects/:id` like everything else this model reads.

**Upgrade note:** No co-upgrades required. All new resources and methods are
additive; no `globalArguments` change.
