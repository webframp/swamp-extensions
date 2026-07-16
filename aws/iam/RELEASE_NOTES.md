## 2026.07.16.1

**Fixed:** This extension was merged 2026-06-25 (#151) but never actually published — the publish workflow's change-detection missed the manifest version bump in that merge and picked up an unrelated concurrent branch instead. This release is the first real publish; there is no prior published version to compare against.

**Added:** Cross-account IAM observation model — trust map discovery, access key age tracking, and wildcard/GovCloud/bare-account ARN handling in trust relationships.
