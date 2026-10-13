# @webframp/aws/acm-diagnostics

A swamp extension model for investigating AWS Certificate Manager issuance and
validation problems. It answers what a stuck or failed certificate leaves
unclear: which domain failed validation, which DNS record ACM expects for it,
why the certificate failed, and which resources still use it.

Certificates managed through Cloud Control (`@swamp/aws/certificatemanager`)
return only the properties declared in a template. They do not carry validation
status, expected DNS records, failure reasons, or in-use resources. Those fields
come only from ACM's `DescribeCertificate`, which this extension reads.

## Features

- **Per-domain validation state** -- `validationStatus` and `validationMethod`
  for every domain on a certificate, with the domains that are not `SUCCESS`
  listed as `pendingValidation`
- **Expected DNS records** -- the exact CNAME name, type, and value ACM wants,
  ready to compare against Route53 (for example with
  `@webframp/aws/dns-observation`)
- **In-use resources** -- `inUseBy` ARNs, which block certificate deletion
- **Fan-out** -- one `describe_certificates` call covers up to 100 ARNs under a
  single model lock and writes one resource per certificate plus a roll-up
- **Missing is a finding** -- a deleted certificate (or one in another account) is recorded
  as `ResourceNotFoundException` and listed under `notFound`. Other failures
  (`AccessDeniedException`, throttling, expired credentials) are listed under
  `errored` in the summary and **do not overwrite** a certificate's last good
  record. Neither hides the remaining certificates. If *no* certificate can be
  described, the method fails after writing the summary, so an expired SSO token
  cannot read as a clean run
- **Complete listings** -- `list_certificates` asks ACM for every key type.
  ACM's default filter returns only RSA_1024 and RSA_2048 certificates, which
  would hide EC and RSA_3072/4096 certificates. It also requests every key pair
  origin; the default omits ACME-issued certificates

## Prerequisites

This extension uses the default AWS credential chain, or the optional `profile`
global argument. The IAM principal needs:

- `acm:ListCertificates`
- `acm:DescribeCertificate`

## Usage

```bash
swamp extension pull @webframp/aws/acm-diagnostics

swamp model create @webframp/aws/acm-diagnostics acm-prod \
  --global-arg region=us-east-1 --global-arg profile=prod-account

# Find certificates stuck waiting on validation
swamp model method run acm-prod list_certificates \
  --input 'statuses=["PENDING_VALIDATION","VALIDATION_TIMED_OUT"]' \
  --input instanceName=stuck

# Describe them: which domain failed, and what record does ACM want?
swamp model method run acm-prod describe_certificates \
  --input 'certificateArns=["arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"]' \
  --input summaryName=stuck-summary
```

Read results with `swamp data query`:

```bash
# Roll-up: pending validations, in-use certificates, missing ARNs
swamp data query 'model("acm-prod") && name == "stuck-summary"' --select content

# The expected CNAME for every domain that is not validated
swamp data query 'model("acm-prod") && name == "cert-00000000-0000-0000-0000-000000000000"' --select content
```

## Methods

| Method | Purpose | Resource written |
| ------ | ------- | ---------------- |
| `list_certificates` | List certificates by status and domain substring | `certificate_list` (`instanceName`) |
| `describe_certificates` | Validation state, expected records, failure reason, in-use | `certificate` (one per certificate, named `cert-<uuid>`) and `describe_summary` (`summaryName`, default `describe-summary`) |

## Limits and caveats

- `domainContains` is applied client-side after `ListCertificates`, which has no
  domain filter. It matches the primary domain and the subject alternative names
  ACM returns in the list. Pagination is bounded at 50 pages and `truncated` is
  set when the cap is hit, so a filter on a very large account can miss matches.
- Certificate ARNs must be full ACM ARNs ending in a UUID; the UUID becomes the
  data name. `instanceName` and `summaryName` accept letters, digits, `.`, `_`
  and `-`, and reject `latest` (reserved by swamp) and the `cert-` prefix (used
  for certificate records).
- Every request has a 30s deadline, and a `describe_certificates` call has a
  5-minute total budget. ARNs left when the budget runs out are reported under
  `errored` as `BudgetExceeded`.
- A `ValidationStatus` of `FAILED` or a missing `resourceRecord` usually means
  the DNS record was never created. Check the zone, then compare the record to
  the one ACM expects.
- Describing a certificate that was deleted (or lives in another account)
  returns `ResourceNotFoundException`, recorded as `found: false`.
- An ARN whose region differs from the model's `region` is listed under
  `errored` as `RegionMismatch`, without an API call or a record. Create one
  model per region.
- When the same UUID is requested for two accounts, both records carry a hash
  suffix (`cert-<uuid>-<hash>`), whichever one succeeds, so names stay stable
  across runs.
- `CloudFront` certificates must be in `us-east-1`; set `region` to match the
  certificate.
