## 2026.08.21.1

**Changed:** Security Hub and Organizations API failures now surface with the
operation and inputs that were in flight instead of a bare SDK error. Every
`GetFindings`, `BatchUpdateFindings`, and `ListAccounts` call across
`list_findings`, `get_finding_details`, `get_severity_summary`,
`list_findings_by_type`, `diff_findings`, `resolve_accounts`,
`list_all_findings`, and the shared archive/resolve/reopen update path now
catches failures and rethrows with the method name, the filters or finding
ARNs involved, and the original error preserved as `cause`. Previously a
throttled or permission-denied call would bubble up as a generic AWS SDK
exception with no indication of which query or update triggered it.
