## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Fixed:** `create_user_labels` wrote to a resource the model does not declare,
so it always failed. It now writes the resource the model declares.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected:
`create_api_shield_expression_templates_fallthrough`,
`create_api_shield_endpoint_management_add_operation_to_a_zone`,
`create_api_shield_operations_bulk_post_labels_to_operations` and
`create_api_shield_operations_post_labels_to_operation`.

**Upgrade note:** Results earlier versions wrote to the `created` instance stay
there; new runs write under the new names.
