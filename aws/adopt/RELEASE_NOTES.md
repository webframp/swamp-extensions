## 2026.08.24.1

**Fixed:** Updated stale dependency versions in README (ec2, rds, secretsmanager
now reference current manifest versions).

**Added:** Troubleshooting section documenting the irrelevant `AWS_REGION` env
var, `MAX_PAGES = 5` truncation behavior, first-run orphan detection limits,
silent resource omission for missing identifiers, and CloudFormation nested
stack pagination.
