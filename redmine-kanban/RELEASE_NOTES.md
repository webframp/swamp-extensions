## 2026.11.26.1

**Fixed:** The `@webframp/scaffold-story` workflow had a non-UUID `id`
(`scaffold-story-001`), so swamp printed `Skipping broken extension workflow ...
id: Invalid UUID` on every `swamp workflow` command and never loaded the
workflow. It now has a valid UUID `id` and loads.
