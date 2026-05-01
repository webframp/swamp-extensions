# @webframp/redmine-kanban

Kanban workflow reports and automation for Redmine, built on top of
[@webframp/redmine](../redmine/).

## What's Included

- **flow_metrics_report** — Cycle time, WIP age, and throughput analysis
- **sprint_summary_report** — Sprint-based issue summaries by status, tracker, and assignee
- **scaffold-story workflow** — Creates a Theme→Story→Task hierarchy from a subject line

## Quick Start

```bash
swamp extension pull @webframp/redmine-kanban

swamp model create @webframp/redmine tracker \
  --global-arg host=https://your-redmine.example.org \
  --global-arg apiKey=YOUR_API_KEY \
  --global-arg project=your-project

swamp workflow run @webframp/scaffold-story \
  --input subject="ADDS | LDAP | Implement Geographic Redundancy"
```

## License

Apache-2.0
