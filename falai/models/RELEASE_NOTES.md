## 2026.09.17.2

Add get_model_insights method for the new /models/{id}/insights endpoint. Also:
response schema fields are now generated as optional/nullable-optional
regardless of the spec's required list, so reading a resource stored under an
older model version no longer throws when the live API has since added required
fields (quantity/unit on billing events); list methods with a documented default
page size now use it to detect truncation when the caller omits limit.
