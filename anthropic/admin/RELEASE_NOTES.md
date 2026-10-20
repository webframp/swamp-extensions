## 2026.10.20.1

**Added:** First release. Reads members, custom roles, and RBAC groups (with
their attached roles, members, and member counts by organization role) through
the Claude Enterprise Admin API, adds members to direct groups, and switches
members between the `user` and `managed` (Custom) organization roles.

Write methods are dry runs unless `dryRun` is `false`. `set_member_roles` with
`role: managed` requires coverage — `requireGroupId` with `expectRoleId` (the
group must carry the role; only its members change) or `requireRoleId` (only
members of some group carrying the role change) — so nobody becomes Custom
before the role applies. `sync_access` reports per-role coverage counts for
verification. Only `user` and `managed` members are ever targeted. Every run
writes an audit record (dry runs and applies in separate instances, one version
per run) with previous roles for rollback. Requests are paced client-side (default 80/min against the API's
100/min), time out after 30 seconds, and are retried on 429, 5xx, and no
response; runs stop on 401/403 or repeated identical failures.
