## 2026.08.21.2

**Changed:** AWS CLI, Docker build, ECR login, and image push failures now name
the exact command and target that failed (repository name, image tag, registry,
or region) instead of surfacing only the raw stderr text. Previously a failed
`aws` call or `docker` step raised a bare "AWS CLI failed" / "Image push failed"
message with no indication of which resource or image was involved, which made
triage in CI logs slower. The underlying error text is preserved in full.
