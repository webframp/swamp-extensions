## 2026.10.21.1

**Fixed:** The `status` method's setup hints showed literal secrets:
`serviceAccountJson=<contents of service-account.json>`,
`clientSecret=<secret-value>` and `analyticsKey=<vault-reference>` (a
placeholder with no syntax). Each hint now stores the secret with
`swamp vault put` and wires the argument with a `vault.get` expression.

**Changed:** The Bedrock hint recommends an SSO named profile or an attached IAM
role instead of listing environment variables as a credential source.

**Changed:** The README and manifest Quick Start store the GCP, Azure and
Anthropic credentials in vaults and wire them with `vault.get`. The Azure
example previously omitted `tenantId`, `clientId` and `clientSecret` entirely.

**Changed:** The README and manifest Quick Start create each vault (`gcp`,
`azure`, `anthropic`) with `swamp vault create local_encryption <name>` before
storing a secret in it, a once-only step for a repo with no vault yet.

**Upgrade note:** The `status` output text changed; its schema did not. No other
behavioral changes.
