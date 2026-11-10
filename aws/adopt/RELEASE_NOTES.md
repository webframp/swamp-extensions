## 2026.11.10.1

**Changed:** Bump @aws-sdk/* 3.1139.0 → 3.1164.0 (7 packages)

**Changed:** Bump @swamp/aws/apigatewayv2 2026.09.24.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/autoscaling 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/cloudfront 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/cloudwatch 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/ec2 2026.09.24.1 → 2026.11.08.3

**Changed:** Bump @swamp/aws/ecr 2026.09.24.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/ecs 2026.09.24.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/efs 2026.09.24.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/eks 2026.09.24.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/elasticache 2026.09.24.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/elasticloadbalancingv2 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/events 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/iam 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/kms 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/lambda 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/logs 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/rds 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/route53 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/s3 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/secretsmanager 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/sns 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/sqs 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/aws/ssm 2026.09.25.1 → 2026.11.08.2

**Changed:** Bump @swamp/typesafe-ai 2026.09.15.1 → 2026.10.23.1

**Changed:** Bump @webframp/typesafe-batch 2026.09.26.1 → 2026.11.03.1

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The manifest now shows how to wire the `@swamp/typesafe-ai` model's
`apiKey` from a vault (`swamp vault put` plus a `vault.get` expression) instead
of only saying a TypeSafe API key is needed. The README and manifest store the
key as `swamp vault put typesafe API_KEY` and wire
`${{ vault.get("typesafe", "API_KEY") }}`, the same vault and key
`@webframp/typesafe-batch` documents for the same `jev` model, and both show
`swamp vault create` for a repo with no vault yet. The manifest also recommends
an SSO named profile or an attached IAM role for AWS credentials.

**Upgrade note:** Documentation only; no behavioral or schema changes.
