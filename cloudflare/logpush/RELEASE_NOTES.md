## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_post_accounts_account_id_logpush_jobs`,
`put_accounts_account_id_logpush_jobs_job_id`,
`create_post_accounts_account_id_logpush_ownership`,
`create_post_accounts_account_id_logpush_ownership_validate`,
`delete_accounts_account_id_logpush_validate_destination`,
`delete_accounts_account_id_logpush_validate_destination_exists` and 6 more. The
README's new "Secrets" section lists them per method.

**Changed:** Secrets returned by `create_post_accounts_account_id_logpush_jobs`,
`get_accounts_account_id_logpush_jobs_job_id`,
`put_accounts_account_id_logpush_jobs_job_id`,
`create_post_zones_zone_id_logpush_jobs`,
`get_zones_zone_id_logpush_jobs_job_id` and
`put_zones_zone_id_logpush_jobs_job_id` are now stored in a vault, and the
stored resource holds a `vault.get` reference instead of the value. Because the
model now declares secret output, swamp refuses to run any of the model's
methods, reads included, until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Changed:** Secrets inside list items, maps or unions, which swamp cannot move
into a vault, are now removed before the result is stored. Affected:
`get_accounts_account_id_logpush_datasets_dataset_id_jobs`,
`get_accounts_account_id_logpush_jobs`,
`get_zones_zone_id_logpush_datasets_dataset_id_jobs` and
`get_zones_zone_id_logpush_jobs`.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected:
`create_post_accounts_account_id_logpush_ownership`,
`create_post_accounts_account_id_logpush_ownership_validate`,
`delete_accounts_account_id_logpush_validate_destination`,
`delete_accounts_account_id_logpush_validate_destination_exists`,
`create_post_accounts_account_id_logpush_validate_origin`,
`create_post_zones_zone_id_logpush_edge_jobs` and 5 more.

**Upgrade note:** Resources stored by earlier versions of the methods in the
README's "Secrets" section may hold plaintext secrets; delete them with
`swamp data delete` and rotate the affected credentials. Results earlier
versions wrote to the `created` instance stay there; new runs write under the
new names.
