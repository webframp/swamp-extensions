# @webframp/ddd-guidance

Guides teams through applying Domain-Driven Design to existing projects. A
concept model — the agent drives real conversations using method descriptions
as structured guidance; execute functions store versioned discovery results.

## Installation

```bash
swamp extension pull @webframp/ddd-guidance
```

## Usage

### Discover bounded contexts

```bash
swamp model @webframp/ddd-guidance method run contexts my-project
swamp model @webframp/ddd-guidance method run contexts my-project --input focus="checkout subsystem"
```

The agent guides a conversation through term inventory, ownership boundaries,
rate of change analysis, context identification, and relationship mapping.
Results are stored in the `contextMap` resource.

### Capture ubiquitous language

```bash
swamp model @webframp/ddd-guidance method run language my-project --input context="order-management"
```

For a selected bounded context, the agent elicits precise term definitions,
flags overloaded or implementation-leaked language, and discovers term
relationships. Results accumulate in the `domainGlossary` resource.

### Design aggregate boundaries

```bash
swamp model @webframp/ddd-guidance method run boundaries my-project --input context="inventory"
```

Using Vernon's four rules of thumb, the agent guides aggregate candidate
clustering (translating glossary terms into candidate aggregates), invariant
discovery, aggregate sizing, reference strategy, and consistency boundary
decisions. Results are stored per-context in the `boundaries` resource.

### Revisit existing decisions

```bash
swamp model @webframp/ddd-guidance method run revisit my-project
swamp model @webframp/ddd-guidance method run revisit my-project --input scope="contexts"
```

Domain understanding evolves. After new services, team reorgs, or incidents
that revealed hidden coupling, run `revisit` to review prior decisions.
The agent guides a structured review of context boundaries, language drift,
and aggregate pressure, then updates affected resources. Previous versions
remain queryable through the datastore's version history.

## Resources

| Resource | Lifetime | GC | Purpose |
|----------|----------|-----|---------|
| `contextMap` | infinite | 20 | Bounded contexts, relationships, overloaded terms |
| `domainGlossary` | infinite | 20 | Per-context term definitions |
| `boundaries` | infinite | 20 | Aggregate designs with invariants and consistency rules |

All resources are versioned. Query historical versions to track how domain
understanding evolves over time:

```bash
swamp data query "type == '@webframp/ddd-guidance' && specName == 'contextMap'"
```

## Design Philosophy

This model stores the *results* of DDD discovery conversations, not the
conversations themselves. The agent's value is in asking the right questions
in the right order — Vernon's structured approach to aggregate design,
Evans' context mapping patterns. The typed resources make that knowledge
queryable, comparable across versions, and available to other agents making
architectural decisions.

The high garbage collection count (20 versions) reflects that domain
understanding deepens over months. Early versions capture initial assumptions;
later versions capture refined understanding after the team encounters real
constraints.

## License

Apache-2.0
