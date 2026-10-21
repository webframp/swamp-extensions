## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_a_new_output_connected_to_a_live_input` and
`create_signed_url_tokens_for_videos`. The README's new "Secrets" section lists
them per method.

**Changed:** Secrets returned by `create_signing_keys`, `create_a_live_input`,
`get_stream_live_inputs_retrieve_a_live_input`, `update_a_live_input`,
`stream_live_inputs_disable_a_live_input`,
`stream_live_inputs_enable_a_live_input` and 6 more are now stored in a vault,
and the stored resource holds a `vault.get` reference instead of the value.
Because the model now declares secret output, swamp refuses to run any of the
model's methods, reads included, until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Changed:** Secrets inside list items, maps or unions, which swamp cannot move
into a vault, are now removed before the result is stored. Affected:
`list_all_outputs_associated_with_a_specified_live_input`.

**Fixed:** `create_signing_keys`, `create_webhooks`, `update_video_details`,
`create_downloads` and `create_type_specific_downloads` wrote to a resource the
model does not declare, so they always failed. They now write the resource the
model declares.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` or `uid` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected:
`create_stream_video_clipping_clip_videos_given_a_start_and_end_time`,
`create_stream_videos_upload_videos_from_a_url`,
`create_stream_videos_upload_videos_via_direct_upload_ur_ls`,
`create_a_live_input`, `create_a_new_output_connected_to_a_live_input`,
`create_watermark_profiles_via_basic_upload` and 2 more.

**Upgrade note:** Resources stored by earlier versions of the methods in the
README's "Secrets" section may hold plaintext secrets; delete them with
`swamp data delete` and rotate the affected credentials. Results earlier
versions wrote to the `created` instance stay there; new runs write under the
new names.
