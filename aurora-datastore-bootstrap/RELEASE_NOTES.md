## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added a `## Troubleshooting`
section covering the missing-default-VPC error, the "need 2+ subnets" check in
`getSubnetIds`, the 600s/15s cluster-available timeout, and a real gotcha found
while reading the code: the provisioner only waits for the _cluster_ to reach
`available`, never the writer instance, so connections can fail immediately
post-bootstrap. Also documents the `rds-db:connect` policy being scoped only to
`master_username`.
