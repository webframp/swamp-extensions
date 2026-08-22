## 2026.08.21.1

**Changed:** `subnet_ids` is now validated as a comma-separated list of
`subnet-[a-f0-9]+` IDs at model-creation time, instead of accepting any string
and letting a malformed value fail deep inside the AWS CLI call with an opaque
error.

`max_acu` must now be greater than or equal to `min_acu`. Previously an inverted
range (e.g. `max_acu=2` with `min_acu=4`) was accepted and passed straight
through to `create-db-cluster`, which rejects it with a generic RDS validation
error that doesn't identify which argument was wrong.
