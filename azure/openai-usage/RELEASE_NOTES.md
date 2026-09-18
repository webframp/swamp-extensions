## 2026.09.18.1

**Fixed:** `list_ai_resources` no longer discards the truncation signal from
resource discovery. If ARM pagination for a subscription exceeds the internal
page cap, or a subscription's listing fails outright, the written
`resource_list` resource now sets `truncated: true` and a warning is logged,
instead of silently returning a partial list that looks complete.

**Changed:** `resource_list` resources now include a `truncated` field
(optional, defaults absent on older data).

**Upgrade note:** Normalized npm:zod reference globally to 4.6.5.
