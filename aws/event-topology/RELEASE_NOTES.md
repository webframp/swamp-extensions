## 2026.08.23.1

**Changed:** Documentation only — no code changes. Expanded the `discover` and
`analyze` method descriptions with actual argument names/defaults and resource
instance names. Added a `## Troubleshooting` section covering the `region`
default (`us-east-1`), the hardcoded `MAX_PAGES = 50` cap on two specific
loops, and — the most notable finding — that the user-supplied
`maxTopics`/`maxQueues`/`maxRulesPerBus` caps break enumeration silently
**without** setting `truncated`, an honesty gap distinct from the hardcoded
caps. Also documents per-queue attribute-fetch failures that silently drop
queues (and their DLQ/redrive edges) from the graph.
