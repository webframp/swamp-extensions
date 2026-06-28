# @webframp/aws/event-topology

Discovers the directed graph of event relationships across AWS EventBridge
rules, SNS subscriptions, SQS redrive chains, and Lambda event source mappings.
Produces a unified graph of nodes and edges with connected component analysis,
boundary detection, and hub identification.

## Installation

```sh
swamp extension pull @webframp/aws/event-topology
```

## Usage

```sh
# Create the model with an AWS profile
swamp model create @webframp/aws/event-topology aws-event-topology \
  --global-arg 'profile=my-account/ReadOnlyPlus' \
  --global-arg 'region=us-east-1'

# Discover the event topology graph
swamp model method run aws-event-topology discover

# Analyze hub nodes (high connectivity)
swamp model method run aws-event-topology analyze \
  --input '{"query": "hubs", "threshold": 3}'

# Find orphaned nodes with no connections
swamp model method run aws-event-topology analyze \
  --input '{"query": "orphans"}'

# Trace inputs/outputs for a specific node
swamp model method run aws-event-topology analyze \
  --input '{"query": "path", "nodeId": "arn:aws:sqs:us-east-1:123456789012:my-queue"}'
```

## Methods

- **discover** — Single fan-out observation: queries all 4 services in parallel,
  produces a unified graph with nodes, edges, and computed statistics (connected
  components via union-find, degree metrics, boundary detection).
- **analyze** — Pure data-layer queries against stored graph: `hubs`, `boundaries`,
  `orphans`, `components`, and `path`.

## Permissions

Requires read-only access to:
- `events:ListEventBuses`, `events:ListRules`, `events:ListTargetsByRule`
- `sns:ListTopics`, `sns:ListSubscriptionsByTopic`
- `sqs:ListQueues`, `sqs:GetQueueAttributes`
- `lambda:ListEventSourceMappings`
- `sts:GetCallerIdentity`

## License

Apache-2.0 — see LICENSE.md for details.
