## 2026.07.10.1

**Changed:** Hardened `failedProfiles` error redaction. Persisted error text now
also strips internal URLs and ANSI color codes, and collapses the common
`granted`/AWS SSO credential-process failure to a short, actionable code
(`sso-login-required`). Previously the raw error embedded the organization's SSO
portal URL, which would surface in the briefing-facing snapshot. Real
identifiers (ARNs, account ids) are still redacted as before. No API, schema, or
method-signature changes.
