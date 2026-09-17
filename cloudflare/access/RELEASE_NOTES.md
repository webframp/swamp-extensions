## 2026.09.17.1

No API surface changes — the pinned OpenAPI spec (SHA 29f8cda9) is unchanged.
This regenerates all extensions to pick up three codegen-harness fixes: (1) an
id-accessor coercion fix (String(...) around a created-resource id) already
present in the generator but not yet applied to on-disk output; (2) response
schema fields are now generated as optional/nullable-optional regardless of the
spec's required list, so reading a resource stored under an older model version
no longer throws Required when the live API has since added a required field;
(3) cursor-paginated list methods now follow result_info.cursor across pages
(via a new cfApiPaginatedCursor helper) instead of fetching only page one and
hardcoding truncated: false.
