## 2026.10.14.3

**Changed (breaking):** `delete_api_key` is removed. The fal.ai API now revokes
keys with `POST /keys/{key_id}/revoke`, and the generated method is
`revoke_api_key`, which takes the same `key_id` argument. Revoking is a
different operation from deleting: the API may keep a revoked key in listings.
The model keeps no `delete_api_key` alias. Workflows and scripts that call
`delete_api_key` must switch to `revoke_api_key`.

**Fixed:** `revoke_api_key` writes the API response to a `revoke_api_key`
resource keyed by `key_id`, so revoking several keys keeps a record of each
instead of overwriting one `-current` instance. The resource schema keeps the
fields the API returns rather than storing an empty object. `delete_api_key`
wrote no data.

**Added:** `create_api_key` accepts optional `description`, `preset`
(`FULL`, `AGENT`, `API`, `DEPLOY`, `READONLY`, `BILLING`, `COMPUTE`,
`SERVERLESS`; the API defaults to `API`), `permissions` (an explicit list, used
instead of a preset), and `expires_at` (ISO8601). The model does not enforce
that `preset` and `permissions` are exclusive; the API decides. Listed keys now
report `description`, `mode`, `preset`, `permissions`, and `expires_at`, and
`scope` may be `ADMIN` in addition to `API`.

**Upgrade note:** The new key fields are optional, so stored resources remain
valid and the model's upgrade chain gains identity steps. Only the method
rename needs action.
