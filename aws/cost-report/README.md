# @webframp/aws/cost-report

Format AWS cost estimates into readable reports with breakdowns and actionable
recommendations. This extension generates markdown and JSON output from cost
estimate model data produced by `@webframp/aws/cost-estimate`.

## Features

- Formatted markdown tables for EC2, RDS, and spec-based cost estimates
- Cost breakdowns by tag (owner, project)
- Actionable recommendations for cost optimization (right-sizing, Reserved
  Instances, Savings Plans)
- JSON output for programmatic analysis and downstream tooling
- Automatic execution after cost-estimate methods or standalone invocation

## Usage

The report runs automatically after `@webframp/aws/cost-estimate` methods. To
view the stored report afterward:

```bash
# Runs automatically after method execution
swamp model method run cost-est estimate_from_spec --input-file spec.json

# Retrieve the stored report
swamp report get @webframp/aws/cost-report --model cost-est --json
swamp report get @webframp/aws/cost-report --model cost-est --markdown
```

## Report Output

The generated report includes:

- **Resource tables** with per-item costs (name, type, spec, count, unit cost,
  total) — **only for `estimate_from_spec`** (see Troubleshooting)
- **Data artifact pointers** — `swamp data get` commands for the resources the
  method actually wrote, where the real computed costs live
- **Recommendations** tailored to the method executed

Filter reports using labels:

```bash
swamp model method run <model> <method> --report-label cost
```

## Troubleshooting

**Report shows `*Report skipped: Not a cost-estimate model (...)*`.**
The report only runs its logic for model types whose name contains
`cost-estimate`. If it's attached to a different model type (directly, or
via `reports.require`), it always skips — this is by design, not a bug.

**The cost table shows `$0.00` for every row.**
Only `estimate_from_spec` produces a resource table, and it's built from
the *method's input arguments* (`ec2Instances`, `rdsInstances`), not from
computed pricing — `monthlyPerUnit`/`monthlyTotal` are hardcoded to `0` in
the table itself. The actual computed costs live in the data artifact the
method wrote; use the `swamp data get` command printed under "Data
Produced" in the same report to see real numbers.

**No resource table at all, just recommendations.**
`estimate_ec2` and `estimate_rds` only get the generic recommendations
section — the resource-table code path is gated to
`context.methodName === "estimate_from_spec"` specifically. Use
`swamp data get <model> <artifact>` for those methods' actual cost
breakdowns.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for full text.
