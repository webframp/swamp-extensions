## 2026.08.21.1

**Changed:** AWS Config and STS API failures across `get_non_compliant`,
`get_compliance_summary`, and `list_rules` now raise an error naming the
failing operation (`GetCallerIdentity`, `DescribeComplianceByConfigRule`,
`GetComplianceDetailsByConfigRule`, `DescribeConfigRules`) plus the region
and, where relevant, the specific Config rule name and page being fetched.
Previously these calls surfaced the raw AWS SDK error with no indication of
which rule or request had failed.
