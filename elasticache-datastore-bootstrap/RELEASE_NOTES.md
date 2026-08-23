## 2026.08.23.1

**Fixed:** README's Development section referenced a nonexistent
`valkey-datastore-bootstrap` directory; corrected to
`elasticache-datastore-bootstrap`.

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering the multiple-default-VPC error, the
`create-failed`/`deleting`/`deleted` terminal-state branches in
`waitForCacheAvailable`, the self-healing ingress-rule check in
`ensureSecurityGroup` that silently reopens port 6379 to the VPC CIDR on re-run,
and divergent `securityGroupId` reporting when reusing a cache created with a
different security group.
