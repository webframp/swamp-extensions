## 2026.10.14.2

**Changed (breaking):** `delete_api_key` is removed. The fal.ai API now revokes
keys with `POST /keys/{key_id}/revoke`, and the generated method is
`revoke_api_key`, which takes the same `key_id` argument. It writes a
`revoke_api_key` resource (instance `revoke_api_key-current`) with the API
response; `delete_api_key` wrote no data. Workflows and scripts that call
`delete_api_key` must switch to `revoke_api_key`.

**Added:** `create_api_key` accepts optional `description`, `preset`
(`FULL`, `AGENT`, `API`, `DEPLOY`, `READONLY`, `BILLING`, `COMPUTE`,
`SERVERLESS`), `permissions`, and `expires_at`. Listed keys now report
`description`, `mode`, `preset`, `permissions`, and `expires_at`, and `scope`
may be `ADMIN` in addition to `API`.

**Upgrade note:** The new key fields are optional, so stored resources remain
valid and the model's upgrade chain gains an identity step. Only the method
rename needs action.
