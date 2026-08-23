## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added a
`## Troubleshooting` section covering storage-account name collisions (global
uniqueness isn't checked against other tenants), `AuthorizationPermissionMismatch`
errors from mixing `--auth-mode login` (Azure AD RBAC, used only by container
operations) with ARM permissions used elsewhere, stale/expired `az login`
sessions masquerading as "not found" because exists-checks match error
substrings, and the explicit `getConnectionString` failure mode.
