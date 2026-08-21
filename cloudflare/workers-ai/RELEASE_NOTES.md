## 2026.08.21.1

**Fixed:** Regenerated with three cloudflare-codegen fixes: (1)
discriminated-union request bodies with a sibling top-level discriminator
property (e.g. gateway proxy_endpoints kind) now correctly build the body from
the full oneOf variant instead of silently dropping it to undefined; (2) DELETE
methods with a request body (e.g. r2 delete_objects bulk-delete-by-list) now
send that body instead of ignoring it; (3) oneOf/anyOf request body variants
that are $ref (e.g. r2 sippy config) are now resolved to their real schema
instead of collapsing to z.unknown(). Same generator fix as workers-scripts in
#352, now caught up for these 7 services.

**Changed:** The following methods were removed — they are no longer present
in the upstream Cloudflare API spec this extension is generated from:
`ai_search_namespace_instance_upload_item`, `workers_ai_upload_finetune_asset`,
`workers_ai_post_run_cf_facebook_nonomni_detr_resnet_50`,
`workers_ai_post_run_cf_microsoft_nonomni_resnet_50`,
`workers_ai_post_run_cf_microsoft_resnet_50`,
`workers_ai_post_run_cf_openai_whisper`,
`workers_ai_post_run_cf_openai_whisper_tiny_en`, `workers_ai_post_to_markdown`.
