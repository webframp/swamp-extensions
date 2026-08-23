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

# Re-run discover with higher enumeration caps for a large account
swamp model method run aws-event-topology discover \
  --input '{"maxTopics": 500, "maxQueues": 2000}'
```

## Methods

- **discover** — Single fan-out observation: queries EventBridge, SNS, SQS, and
  Lambda event source mappings in parallel, produces a unified graph with nodes,
  edges, and computed statistics (connected components via union-find, degree
  metrics, boundary detection). Accepts `maxRulesPerBus` (default 100),
  `maxTopics` (default 200), and `maxQueues` (default 500) to bound enumeration
  of each service. Writes to the `graph` resource under instance `topology`.
- **analyze** — Pure data-layer queries against the stored `graph` resource
  (reads instance `topology` — run `discover` at least once first): `hubs`
  (nodes at or above a degree `threshold`, default 3), `boundaries`
  (cross-account, external, and unresolvable nodes), `orphans` (nodes with no
  edges), `components` (connected subgraphs, largest first), and `path`
  (inputs/outputs for one `nodeId`).

## Permissions

Requires read-only access to:
- `events:ListEventBuses`, `events:ListRules`, `events:ListTargetsByRule`
- `sns:ListTopics`, `sns:ListSubscriptionsByTopic`
- `sqs:ListQueues`, `sqs:GetQueueAttributes`
- `lambda:ListEventSourceMappings`
- `sts:GetCallerIdentity`

## Troubleshooting

**Empty or near-empty graph.** `region` defaults to `us-east-1`
(`GlobalArgsSchema` in `event_topology.ts`) if not passed at model creation.
EventBridge, SNS, SQS, and Lambda ESMs are all regional — if your event
infrastructure lives in another region, `discover` will silently return a
graph with few or no nodes rather than an error. Pass `--global-arg
'region=<your-region>'` explicitly.

**`truncated: true` in the graph resource.** This is only set when the
internal `MAX_PAGES = 50` cap fires on two specific loops: paginating
subscriptions for a single SNS topic, or paginating the account-wide Lambda
event source mapping listing. Each occurrence is also logged as a warning
("Subscription pagination cap reached" / "Event source mapping pagination
cap reached"). If you hit this, the graph is missing edges for whichever
topic/mapping set was mid-page when the cap hit.

**Missing topics, queues, or rules with `truncated` still `false`.** The
`maxTopics` (200), `maxQueues` (500), and `maxRulesPerBus` (100) argument
caps stop enumeration silently — hitting them does not set `truncated`,
unlike the two hardcoded pagination caps above. In an account with more
SNS topics, SQS queues, or rules-per-bus than the defaults, `discover` will
produce an incomplete graph with no signal that anything was cut off. If
node/edge counts look low for a large account, re-run with higher
`maxTopics`/`maxQueues`/`maxRulesPerBus` values before trusting the result.

**A queue is missing from the graph, or its DLQ/redrive edge is gone.**
`GetQueueAttributes` failures (e.g. insufficient `sqs:GetQueueAttributes`
permission on a specific queue) are caught per-queue and logged as a warning
("Failed to get queue attributes") rather than failing the whole `discover`
run. The queue itself, and any redrive edge it would have contributed, simply
never gets added to the graph — check the model's warn-level logs if a queue
you expect to see is absent.

**`analyze` fails with "No stored event topology graph found".** `analyze`
reads the `graph` resource's `topology` instance rather than fetching live
data. Run `discover` at least once before calling `analyze` — and note the
`graph` resource has a 12h lifetime, so a stale instance will eventually
expire and require another `discover` run.

**`analyze query="path"` fails with "nodeId ... was not found".** The error
message suggests it: run `analyze query=hubs` or `analyze query=orphans`
first to get valid node IDs from the current graph, since node IDs are ARNs
(or synthetic `external:<protocol>:<endpoint>` IDs for non-internal SNS
subscription endpoints) rather than friendly names.

## License

Apache-2.0 — see LICENSE.md for details.
