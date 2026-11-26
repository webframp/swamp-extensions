## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `get_accounts_account_id_logpush_transformers_transformer_id_content`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** Logpush transformer methods: list, create, preview, get, update, delete, plus reading a transformer's content and versions (8 methods).

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Apart from the fixes above, additive only.
