## 2026.11.22.1

**Fixed:** `quality-gate` failed every extension against swamp's rubric v6. The
CLI cannot award `repository-verified` for a public repository, so a compliant
extension scores 87% locally and reaches 100% only in `ifProvisionalEarned`. The
gate now passes an extension when `status` is `passed`, `allPassed` is not
`false`, and the percentage is 100 directly or once provisional factors are
earned, matching CI.

**Fixed:** `audit` recorded a score of 0 when scoring errored (for example an
out-of-date `deno.lock`), indistinguishable from a real 0%.

**Added:** `audit` records `qualityProvisionalScore` (percentage once
provisional factors are earned), `qualityPassed` (CI's pass verdict) and
`qualityError` (why scoring produced no score) per extension. Both are optional,
so existing stored audits stay valid. Failure messages from `quality-gate` now
report both the confirmed and the provisional percentage.

**Changed:** `qualityScore` still holds the confirmed percentage, so it reads 87
for a compliant public extension.
