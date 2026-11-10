## 2026.11.10.1

**Changed:** Bump @aws-sdk/* 3.1139.0 → 3.1164.0 (2 packages)

**Changed:** Bump @opentelemetry/api 1.9.1 → 1.10.0

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README no longer lists environment variables as a credential
source. It recommends an SSO named profile (`aws sso login --profile <name>`
with `AWS_PROFILE`) or an attached IAM role, and warns against static access
keys.

**Upgrade note:** Documentation only; no behavioral or schema changes.
