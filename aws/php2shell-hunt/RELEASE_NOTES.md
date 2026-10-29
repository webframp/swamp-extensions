## 2026.10.28.1

**Added:** Hunt now reports a `truncated` boolean in the exposure report, set
true when any CloudWatch Logs Insights query returned the 1000-row limit so a
match count may undercount the true number of hits.

**Fixed:** On abort or timeout, in-flight Logs Insights queries are now stopped
with `StopQueryCommand` instead of being abandoned, so a cancelled hunt no
longer leaves billable queries running in AWS. Abort is re-checked after each
poll sleep so cancellation is honoured promptly.

**Changed:** The Lane B upload-marker regex now escapes every regex
metacharacter in `payloadStrings` entries (previously only `/` and `\`), so a
crafted or unusual marker cannot break or alter the Logs Insights query.

**Changed:** The `@swamp/typesafe-ai` dependency is pinned to an exact version
(`2026.09.15.1`), matching the repo's exact-pin requirement.

**Upgrade note:** Schema is additive (`truncated` is a new field). No migration
required; an identity upgrades-chain entry carries existing stored reports
forward.

## 2026.10.22.1

**Added:** Initial release. Head-hunts PHP2Shell exposure (CVE-2026-109618,
CVE-2026-109619) across AWS using read-only service telemetry — no SSH or
in-guest access.

- `show_iocs` emits the indicator set (CVEs, six IOC IPs, the
  `PHP_SESSION_UPLOAD_PROGRESS` upload marker, the 2026-10-17 earliest-known
  exploitation date, fixed PHP versions) as queryable data.
- `discover_log_groups` enumerates and ranks CloudWatch log groups across the
  configured regions by likely relevance (flow / WAF / ALB / app), so an agent
  can present candidates and a user can choose `logGroupNames` for the logs
  lane. Runs no queries.
- `scan_inspector` queries Amazon Inspector v2 for the two CVEs across regions.
- `scan_guardduty` correlates GuardDuty findings since 2026-10-17 against the
  IOC IPs and RCE/backdoor-shaped finding types.
- `scan_logs` runs CloudWatch Logs Insights over supplied log groups for IOC IP
  contact (flow logs) and the upload marker (WAF/ALB/app logs).
- `scan_securityhub` opportunistically queries an aggregated Security Hub;
  skips cleanly when none is present.
- `hunt` runs every lane across the configured scope and regions, correlates
  them, and writes a per-account exposure verdict
  (`confirmed_exposure` / `active_targeting` / `possible_probe` / `no_signal` /
  `inconclusive`). A lane that could not run is recorded in `lanesSkipped`; an
  account with no runnable lane is `inconclusive`, never `no_signal`.

**Optional jev enrichment:** when the `jevBehavior` global argument names a
pre-created `@swamp/typesafe-ai` (jev) behavior whose apiKey resolves from a
vault, `hunt` asks jev — through `runModel` — to calibrate the fuzzy GuardDuty
RCE-hint and log upload-marker signals, and thresholds the `possible_probe`
verdict on jev's judgement rather than a substring match. CVE matches stay
binary and are never sent to jev. With no jevBehavior the hunt is unchanged. A
jev failure is recorded (`jevEnriched: false` + `jevSkipReason`) and falls back
to the heuristic — it never silently yields a clean verdict.
