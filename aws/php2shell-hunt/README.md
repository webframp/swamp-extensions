# @webframp/aws/php2shell-hunt

Head-hunt exposure and indicators of compromise for the **PHP2Shell** remote
code execution vulnerabilities **CVE-2026-109618** and **CVE-2026-109619**
across AWS — using only the signals AWS already collects. No SSH, no agents, no
in-guest access. Strictly read-only.

This complements [`@swamp/cve/php-rce-2026-10`](https://swamp-club.com/extensions/@swamp/cve/php-rce-2026-10),
which scans and patches hosts directly over SSH/Docker. Where that model asks
"is this host running vulnerable PHP, and can I patch it?", this one asks "what
has AWS already observed about exposure and targeting across my accounts?" —
and answers it without touching a single instance.

## Why AWS-side telemetry

The AWS Security Blog disclosure
([MadPot, 2026-10-21](https://aws.amazon.com/blogs/security/amazon-threat-intelligence-identifies-php2shell-exploitation-prior-to-public-disclosure-in-madpot/))
made three points this model is built around:

1. **Exploitation predates disclosure.** A honeypot hit landed 2026-10-17, four
   days before the embargo lifted. Every lane investigates from 2026-10-17 by
   default, not from the disclosure date.
2. **Signatures lag the first exploit.** So this model hunts behavioral and
   network indicators (GuardDuty finding types, IOC IP contact, an upload-path
   marker), not just a CVE signature.
3. **Measure response in hours.** The hunt is a single re-runnable command that
   produces versioned, queryable state you can diff day over day.

## Signal lanes

| Lane | AWS source | What it looks for |
| --- | --- | --- |
| Inspector | Amazon Inspector v2 `ListFindings` | Findings for the two CVEs (vulnerable PHP inventory) |
| GuardDuty | GuardDuty `ListFindings` / `GetFindings` | Findings since 2026-10-17 whose remote IP matches an IOC, or whose type is RCE/backdoor-shaped |
| Logs | CloudWatch Logs Insights | IOC IP contact in VPC flow logs; `PHP_SESSION_UPLOAD_PROGRESS` in WAF/ALB/app logs |
| Security Hub | Security Hub `GetFindings` | Aggregated GuardDuty/Inspector findings in one query (opportunistic) |

## Scope and regions

One behavior instance fans out internally (factory pattern — one lock, one run).

- `scope=self` (default) — only the credentialed account.
- `scope=accounts` — the 12-digit IDs in `accountIds`.
- `scope=organization` — every active account resolved from AWS Organizations.
  Point `profile` at a delegated-admin / management account. If the org cannot
  be enumerated, the run degrades to the credentialed account and records why.
- `regions` — defaults to the four US commercial regions
  (`us-east-1`, `us-east-2`, `us-west-1`, `us-west-2`). Set it to cover others.

## Verdicts

`hunt` writes one `exposure_report` with a per-account verdict and an org
rollup (the worst account verdict):

| Verdict | Meaning |
| --- | --- |
| `confirmed_exposure` | Inspector or Security Hub reports a listed CVE on a resource. Patch now; investigate from 2026-10-17. |
| `active_targeting` | Contact with published IOC infrastructure (GuardDuty IOC IP or flow-log contact). |
| `possible_probe` | Exploitation-shaped activity (upload marker or RCE-shaped GuardDuty finding) without a confirmed vulnerable install. |
| `no_signal` | Lanes ran and found nothing. **Not** proof of safety — see the coverage caveats. |
| `inconclusive` | No lane could run for this account. Nothing was inspected. See `lanesSkipped`. |

Every verdict carries its `evidence`, the `lanesRun`, and `lanesSkipped` with a
reason per skip. A clean result is auditable: you can see exactly what was and
was not inspected.

## Coverage caveats (read these)

- **Amazon Inspector only sees what it scans** — SSM-managed EC2, scanned ECR
  images, and Lambda. PHP on an unmanaged VM or in an unscanned base image is
  invisible to the Inspector lane. Absence of an Inspector hit is **not** proof
  of safety; that is why the GuardDuty and log lanes exist and why
  `inconclusive` is distinct from `no_signal`.
- **The logs lane needs explicit `logGroupNames`.** Flow logs, WAF logs, and
  ALB access logs live in customer-named CloudWatch log groups, and
  S3-delivered logs are out of reach of Logs Insights entirely. Omit the groups
  and the lane is skipped (and recorded as such), not silently passed.
- **The IOC IPs are shared anonymization infrastructure.** Per AWS, investigate
  observations involving them; do not blind-block.

## Required IAM permissions

- `inspector2:ListFindings`
- `guardduty:ListDetectors`, `guardduty:ListFindings`, `guardduty:GetFindings`
- `logs:StartQuery`, `logs:GetQueryResults`
- `securityhub:GetFindings` (optional lane)
- `organizations:ListAccounts` (organization scope only)

`ReadOnlyPlus`-style roles cover all of these.

## Usage

Single account, default US regions:

```bash
# Create the behavior pointed at one account
AWS_PROFILE="my-account/ReadOnlyPlus" \
  swamp behavior create @webframp/aws/php2shell-hunt hunt

# Emit the indicator set as queryable data (no AWS calls)
swamp behavior run hunt show_iocs
swamp data query 'behavior("hunt") && name == "php2shell"' --select content

# Full hunt for one account, with flow + WAF log groups
swamp behavior run hunt hunt \
  --input 'logGroupNames=["/vpc/flowlogs","/aws/waf/php-app"]'
```

Org-wide from a delegated-admin account, three regions:

```bash
swamp behavior create @webframp/aws/php2shell-hunt org-hunt \
  --global-arg scope=organization \
  --global-arg 'regions=["us-east-1","us-east-2","us-west-2"]'
swamp behavior run org-hunt hunt

# Read the correlated verdict
swamp data query 'behavior("org-hunt") && name == "report"' --select content
```

## Methods

| Method | Purpose |
| --- | --- |
| `show_iocs` | Emit the PHP2Shell indicator set as data. No AWS calls. |
| `discover_log_groups` | Find and rank CloudWatch log groups for the logs lane. No queries. |
| `scan_inspector` | Inspector v2 findings for the CVEs across regions. |
| `scan_guardduty` | GuardDuty findings since the IoC date, correlated to IOC IPs / RCE types. |
| `scan_logs` | Logs Insights: IOC IP contact + upload marker. Needs `logGroupNames`. |
| `scan_securityhub` | Opportunistic aggregated Security Hub lane. |
| `hunt` | Run all lanes, correlate, write a per-account exposure verdict. |

## Guided log-group setup

The logs lane needs explicit `logGroupNames`, and swamp behaviors do not prompt.
`discover_log_groups` closes that gap: it enumerates CloudWatch log groups across
the configured regions, classifies each by name (`flow_log`, `waf_log`,
`alb_log`, `app_log`, or lower-confidence `possible_access_log`), ranks them, and
writes a `log_group_candidates` resource. It runs no queries and never claims a
group definitely holds the signal — the classification is a name heuristic.

```bash
swamp behavior run hunt discover_log_groups
# Read the ranked candidates and the recommended set (relevance >= 60)
swamp data query 'behavior("hunt") && name == "candidates"' --select content
```

The workflow is: the model discovers and ranks, you (or an agent reading the
`recommended` list) choose, and the chosen names are passed to `hunt` or
`scan_logs` as `logGroupNames`. Pass `prefix` to narrow a large account.

## Optional jev enrichment

The GuardDuty RCE-hint and log upload-marker signals are fuzzy: a finding type
containing "Backdoor" or a `PHP_SESSION_UPLOAD_PROGRESS` string is suggestive,
not conclusive. If you have a [TypeSafe (jev)](https://swamp-club.com/extensions/@swamp/typesafe-ai)
API key, the hunt can ask jev — a calibrated System One model — whether each
fuzzy signal is genuinely consistent with PHP2Shell exploitation, and threshold
the `possible_probe` verdict on jev's judgement instead of a substring match.

Enrichment is strictly optional and additive. With no key, the hunt behaves
exactly as it does without jev. CVE matches (Inspector, Security Hub) are always
binary and never sent to jev. Only the GuardDuty RCE-hint findings and log
upload-markers are evaluated, with compact, secret-free descriptors.

```bash
# Store the key in a vault, then create a jev behavior that resolves it.
# (jev's apiKey is sensitive and must come from a vault, not a literal.)
swamp vault put typesafe TYPESAFE_API_KEY
swamp behavior create @swamp/typesafe-ai jev-hunt \
  --global-arg 'apiKey=${{ vault.get("typesafe", "TYPESAFE_API_KEY") }}'

# Point the hunt at that jev behavior by name.
swamp behavior create @webframp/aws/php2shell-hunt hunt \
  --global-arg jevBehavior=jev-hunt
swamp behavior run hunt hunt
```

The `exposure_report` records `jevEnriched` and, when enrichment could not run
(for example jev is unreachable, or `runModel` is called on a remote worker
where it is unavailable), a `jevSkipReason`. A jev failure never silently
produces a clean verdict — the raw heuristic still fires and the skip is logged.

## Related

- [`@webframp/aws/guardduty`](https://swamp-club.com/extensions/@webframp/aws/guardduty) — general-purpose GuardDuty findings reader.
- [`@webframp/aws/securityhub-findings`](https://swamp-club.com/extensions/@webframp/aws/securityhub-findings) — Security Hub findings lifecycle.
- [`@webframp/aws/logs`](https://swamp-club.com/extensions/@webframp/aws/logs) — general CloudWatch Logs Insights.
- [`@swamp/typesafe-ai`](https://swamp-club.com/extensions/@swamp/typesafe-ai) — jev calibrated decisions (optional enrichment dependency).

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
