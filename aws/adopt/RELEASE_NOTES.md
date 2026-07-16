## 2026.07.16.1

**Fixed:** The pinned dependency on `@swamp/aws/secretsmanager@2026.05.18.1` no
longer resolved in the registry, which broke `swamp extension pull` for this
extension and for anything depending on it transitively (e.g.
`@webframp/aws/drift-state`). Bumped the pin to `2026.06.15.1`, the current
published version. This extension only references the secretsmanager model
type name in generated setup commands — it doesn't call into the package's
code — so there's no behavior change beyond the pull now succeeding.
