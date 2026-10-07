## 2026.10.07.1

**Fixed:** `get_test_file_download_url` and
`get_test_file_multipart_presigned_urls` wrote their results under resource
names (`get_test_file_download_url`, `get_test_file_multipart_presigned_urls`)
that the model never declared. They now write to the declared
`test_file_download_url` and `test_file_multipart_presigned_urls` resources, and
their log messages use the new names.

**Fixed:** The shared API helper no longer throws on a successful response with
an empty body (such as 202 Accepted); it returns an empty result. Paginated list
requests tolerate an empty page body the same way. A body that is not valid JSON
now fails with an error naming the HTTP method, path, and status, with a snippet
of the body.

**Upgrade note:** No methods, arguments, or schemas changed. If you read results
of the two methods above by resource name, use the new names.
