## 2026.10.21.1

**Changed:** The README no longer lists environment variables as a credential
source. It recommends an SSO named profile (`aws sso login --profile <name>`
with `AWS_PROFILE`) or an attached IAM role, and warns against static access
keys.

**Upgrade note:** Documentation only; no behavioral or schema changes.
