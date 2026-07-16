## 2026.07.16.2

**Fixed:** `2026.07.16.1` published successfully but the registry's
`latestVersion` never advanced to it (filed as swamp Lab #1195) —
`swamp extension pull` was still resolving `2026.06.23.1`. This bump re-triggers
the publish. No content change beyond the previous release.
