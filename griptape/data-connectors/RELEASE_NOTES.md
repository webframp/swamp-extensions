## 2026.10.21.1

**Changed:** The README now opens with a Credentials section. Store the key with
`swamp vault put griptape API_KEY` and set `apiKey` to
`${{ vault.get("griptape", "API_KEY") }}`. The previous example passed a
placeholder literal (`apiKey=GRIPTAPE_CLOUD_API_KEY`).

**Changed:** The `apiKey` description and the missing-key error now point to the
vault. The `GT_CLOUD_API_KEY` environment variable is still read when `apiKey`
is unset, but it is now documented as a discouraged fallback because swamp does
not redact it. Key resolution is unchanged.

**Changed:** The Google Drive access token that Griptape returns in
`config.google_drive.access_token` is now marked sensitive on the
`data_connector` resource. `create_data_connector`, `get_data_connector` and
`update_data_connector` store it in a vault, and the resource holds a vault
reference instead of the token. Because the resource now declares a sensitive
field, swamp refuses to run any method of this extension, reads included, until
a vault exists (`swamp vault create local_encryption griptape`).

**Changed:** `list_data_connectors` drops `config.google_drive.access_token`
from every item in the `data_connectors` snapshot. Swamp cannot store a field
inside a list in a vault, and before this release the token was written in
cleartext. Use `get_data_connector` to keep it.

**Fixed:** The `config` argument of `create_data_connector` and
`update_data_connector`, which can carry an S3 secret access key, a Confluence
API token or a Google Drive auth code, was not marked sensitive, so swamp did
not redact it. It is now.

**Upgrade note:** Create a vault before running any method of this extension
(`swamp vault create local_encryption griptape`). Data written by earlier
versions still holds the token in cleartext. Remove it with `swamp data delete`.
