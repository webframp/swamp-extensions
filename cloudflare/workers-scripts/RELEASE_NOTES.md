## 2026.08.13.2

**Removed:** update_worker_script_upload_worker_module and
worker_versions_upload_version methods. These endpoints require
multipart/form-data uploads that cfApi's JSON helper cannot serve. Use
@webframp/cloudflare/worker's deploy method for script uploads.

**Fixed:** Codegen now resolves requestBody $ref before content-type filtering.
