## 2026.10.21.1

**Changed:** Documentation only: the README no longer lists environment
variables or a static shared-credentials file as a way to supply AWS
credentials. It now recommends AWS SSO or a named profile
(`aws sso login --profile <name>`, then `--global-arg profile=<name>`), or an
IAM role attached to where swamp runs. Credential resolution is unchanged: the
model still uses the AWS SDK default credential chain when `profile` is unset.

**Upgrade note:** No code, schema, or behavioral changes. The model version
moves to 2026.10.21.1 with an identity upgrade.
