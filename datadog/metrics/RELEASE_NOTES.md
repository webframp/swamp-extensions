## 2026.11.05.3

**Fixed:** `reorder_tag_indexing_rules` no longer writes an empty resource under
a constant `"created"` instance name. The endpoint returns `204 No Content`, so
there is nothing to persist — the method now issues the reorder call and returns
no data handles, and the `reorder_tag_indexing_rules` resource spec is removed.
The request body is also sent in the correct JSON:API envelope
(`{data: {type: "tag_indexing_rules", attributes: {...}}}`) the endpoint expects.

**Upgrade note:** `reorder_tag_indexing_rules` previously stored an empty
`{}` resource on every call; it now stores nothing. No other method is affected.

## 2026.11.05.1

**Added:** Regenerated from the current Datadog OpenAPI spec. New methods for
derived metrics (`create_derived_metric`, `get_derived_metric`,
`update_derived_metric`, `delete_derived_metric`) and tag indexing rules
(`list_tag_indexing_rules`, `list_tag_indexing_rules_for_metric`,
`get_tag_indexing_rule`, `create_tag_indexing_rule`, `update_tag_indexing_rule`,
`delete_tag_indexing_rule`, `reorder_tag_indexing_rules`), with matching
`derived_metric`, `tag_indexing_rule`, `tag_indexing_rules`, and
`tag_indexing_rules_for_metric` resources.

**Upgrade note:** Additive only — existing methods, arguments, and resource
schemas are unchanged, so stored data continues to validate. No migration
required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows how to store the API key and application key
in a `datadog` vault and wire them with `${{ vault.get("datadog", "API_KEY") }}`
and `${{ vault.get("datadog", "APP_KEY") }}`. The previous example passed
`DD_API_KEY` and `DD_APP_KEY` as literal global arguments, which swamp rejects
for sensitive arguments.

**Changed:** The `apiKey` and `appKey` descriptions now say to supply them with
a `vault.get` expression. Both were already marked sensitive.

**Upgrade note:** Documentation and argument descriptions only. Methods,
arguments, resource schemas and stored data are unchanged.
