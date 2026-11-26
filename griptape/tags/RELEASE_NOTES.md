## 2026.11.26.1

**Changed:** Method descriptions now come from the current Griptape OpenAPI
spec. They state that tag profile reads and deletes are open on every plan,
while creating or updating a profile and listing tags require an organization
whose `can_audit_usage` is true (others get 403).

**Upgrade note:** Documentation only. Methods, arguments, resource schemas and
stored data are unchanged.
