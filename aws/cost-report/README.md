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

The report runs automatically after `@webframp/aws/cost-estimate` methods. It
can also be invoked standalone against an existing model:

```bash
# Runs automatically after method execution
swamp model method run cost-est estimate_from_spec --input-file spec.json

# Run standalone on an existing model with JSON output
swamp model report cost-est --json
```

## Report Output

The generated report includes:

- **Resource tables** with per-item costs (name, type, spec, count, unit cost, total)
- **Tag-based cost allocation** grouped by owner and project
- **Recommendations** tailored to the method executed

Filter reports using labels:

```bash
swamp model method run <model> <method> --report-label cost
```

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for full text.
