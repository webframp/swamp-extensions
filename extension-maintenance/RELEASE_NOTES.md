## 2026.09.19.1

**Changed:** The dependency audit now recognizes the `@swamp-club/swamp-testing`
JSR package instead of the deprecated `@systeminit/swamp-testing` scope. Swamp
core renamed the testing SDK scope; the old alias is being retired upstream. The
`readTestingVersion` lookup, the JSR latest-version query, and the reported
dependency name all move to the new scope. Auditing a repo still pinned to the
old scope will now report the testing dependency as absent — repin to
`@swamp-club/swamp-testing` to restore the audit.

**Upgrade note:** No model schema, method, resource, or global-argument change.
The model has no `upgrades:` array, so no migration entry is required.
