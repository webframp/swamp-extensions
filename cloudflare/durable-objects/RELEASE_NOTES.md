## 2026.09.17.2

Adversarial review on PR #427 found: (1) a user-supplied cursor argument was
silently discarded (excluded from the params passed to cfApiPaginatedCursor, so
resuming from a prior truncated result always re-fetched from page one instead);
(2) cfApiPaginatedCursor claimed truncated: false when a response had no
result_info at all, which could silently under-report results on endpoints that
omit that field. Both are fixed: a caller-supplied cursor now flows through as
the starting point, and a missing result_info now marks truncated: true instead
of claiming completeness. Also fixed a trailing '?' on URLs with no query
params.
