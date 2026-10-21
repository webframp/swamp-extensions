## 2026.10.21.1

**Changed:** Secrets Datadog returns are now stored in a vault, not in plaintext
resource data. The stored resource holds a `vault.get` reference in place of
each value:

- `patch_global_variable`: `value.value`, the global variable's value
- `get_test_file_download_url`: `url`, a presigned download URL
- `get_test_file_multipart_presigned_urls`: `multipart_presigned_urls_params`,
  the presigned upload URLs

**Changed:** Because the model now declares sensitive output, swamp refuses to
run any of its methods, reads included, until a vault exists. Without one a
method fails with "no vault is configured"; create one with
`swamp vault create local_encryption datadog`.

**Changed:** The `json_patch` argument of `patch_global_variable` is marked
sensitive, so swamp masks its values in output. A patch that sets `/value/value`
carries the variable's secret.

**Changed:** The README now shows how to store the API key and application key
in a `datadog` vault and wire them with `${{ vault.get("datadog", "API_KEY") }}`
and `${{ vault.get("datadog", "APP_KEY") }}`, and lists the fields stored in a
vault. The previous example passed `DD_API_KEY` and `DD_APP_KEY` as literal
global arguments, which swamp rejects for sensitive arguments. The `apiKey` and
`appKey` descriptions now say the same.

**Upgrade note:** Anything that reads `value.value`, `url` or
`multipart_presigned_urls_params` from data written by this version gets a vault
reference instead of the plaintext value. Data stored by earlier versions is
unchanged.
