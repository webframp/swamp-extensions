## 2026.11.26.1

**Added:** Custom domain methods (`list_custom_domain`, `create_custom_domain`, `delete_custom_domain`), model alias methods (list, get, create, update, delete), logging state (`get_logging_state`, `patch_logging_state`), AI Gateway billing and provider methods (`aig_billing_set_topup_config`, `get_topup_eligibility`, `aig_config_test_providers`, `get_aig_config_fetch_providers`, `get_aig_config_fetch_custom_domain`), `create_workers_ai_ai_gateway_web_search`, `delete_finetune`, `get_workers_ai_download_finetune_asset`, and `ai_search_namespace_purge_instance_cache`.

**Removed:** 123 methods the API no longer exposes. Roughly 113 are per-model run methods (`create_workers_ai_post_run_*`, `workers_ai_post_run_*`, and `get_workers_ai_post_websocket_run_*`); the API no longer publishes one operation per model. Also removed: `create_ai_search_instance_search`, `create_ai_search_instance_chat_completion`, `get_ai_search_stats`, `get_ai_search_fetch_instance`, `update_ai_search_instance_change_job_status`, `create_aig_billing_set_topup_config`, `get_topup_config`, `get_topup_limits`, `get_spending_limit`, and `delete_spending_limit`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the removed methods must stop using them. Existing stored data is unchanged.
